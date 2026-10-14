import { BindenResponse, type Context, Cookie } from "binden";
import { type IServed, fetchRaw, serve, text } from "./helpers.js";
import { afterEach, suite, test } from "node:test";
import compression, {
  Compression,
  type ICompressionOptions,
  skipCompression,
} from "../index.js";
import { deepStrictEqual, ok, throws } from "node:assert";
import { Readable } from "node:stream";
import { ServerResponse } from "node:http";
import { connect } from "node:net";

const body = text(2048);
const gzip = { "Accept-Encoding": "gzip" };

suite("The decision at the header commit", () => {
  let served: IServed | null = null;

  /** Serves a handler through a compression (`gzip` by default) */
  const start = async (
    handler: (context: Context) => Promise<void> | void,
    options: ICompressionOptions = { format: "gzip" },
    strict = false,
  ): Promise<string> => {
    served = await serve(
      { strict },
      new Compression(options),
      (context: Context) => handler(context),
    );
    return served.url;
  };

  afterEach(async () => {
    const current = served;
    served = null;
    await current?.close();
  });

  test("the default instance negotiates", async () => {
    served = await serve({}, compression, (context: Context) =>
      context.text(body),
    );
    const response = await fetchRaw(served.url, { headers: gzip });

    deepStrictEqual(compression.format, "auto");
    deepStrictEqual(response.headers["content-encoding"], "gzip");
    deepStrictEqual(response.body, body);
  });

  test("a compressed response: its length and ranges removed, its `ETag` weakened", async () => {
    const url = await start((context) => {
      const weak = context.url.pathname === "/weak";
      context.setHeader("ETag", weak ? `W/"tag"` : `"tag"`);
      context.setHeader("Accept-Ranges", "bytes");
      return context.text(body);
    });
    for (const method of ["GET", "HEAD"]) {
      for (const path of ["/", "/weak"]) {
        const response = await fetchRaw(url, { method, path });
        deepStrictEqual(response.status, 200);
        deepStrictEqual(response.headers["content-encoding"], "gzip");
        deepStrictEqual(response.headers.etag, `W/"tag"`);
        ok(!("content-length" in response.headers), `${method} ${path}`);
        ok(!("accept-ranges" in response.headers));
        deepStrictEqual(response.body, method === "HEAD" ? "" : body);
      }
    }
  });

  test("the status and the headers of the commit decide (e.g. set after the compression ran)", async () => {
    const url = await start(async (context) => {
      await Promise.resolve();
      if (context.url.pathname === "/partial") {
        context.status(206).setHeader("Content-Range", "bytes 0-2047/4096");
      } else if (context.url.pathname === "/range") {
        context.status(416).setHeader("Content-Range", "bytes */4096");
      }
      return context.text(body);
    });

    const whole = await fetchRaw(url);
    deepStrictEqual(whole.headers["content-encoding"], "gzip");

    for (const path of ["/partial", "/range"]) {
      const response = await fetchRaw(url, { path });
      ok(!("content-encoding" in response.headers), path);
      deepStrictEqual(response.headers["content-length"], `${body.length}`);
      deepStrictEqual(response.raw.toString(), body);
    }
  });

  test("responses without a body are sent as they are", async () => {
    const url = await start(
      (context) => {
        const status = Number(context.request.headers["x-status"]);
        context.setHeader("ETag", `"tag"`).status(status);
        if (context.url.pathname === "/write") {
          context.done = true;
          context.response.writeHead(status, { "Content-Type": "text/plain" });
          context.response.end();
          return Promise.resolve();
        }
        const empty = status === 200 || status === 205;
        return context.response.send(empty ? "" : "ignored");
      },
      { format: "gzip" },
      true,
    );
    for (const status of [204, 205, 304]) {
      for (const path of ["/", "/write"]) {
        const response = await fetchRaw(url, {
          path,
          headers: { "x-status": `${status}` },
        });
        deepStrictEqual(response.status, status);
        ok(!("content-encoding" in response.headers), `${status} ${path}`);
        deepStrictEqual(response.raw.length, 0);
      }
    }

    // An empty body is not compressed
    const empty = await fetchRaw(url, { headers: { "x-status": "200" } });
    ok(!("content-encoding" in empty.headers));
    deepStrictEqual(empty.headers["content-length"], "0");
    deepStrictEqual(empty.headers.etag, `"tag"`);
  });

  test("an encoded response is sent as it is, `identity` is removed", async () => {
    const url = await start((context) => {
      const encoding = context.request.headers["x-encoding"];
      if (typeof encoding === "string") {
        context.setHeader("Content-Encoding", encoding.split(","));
      }
      return context.text(context.url.pathname === "/small" ? "small" : body);
    });

    // Also from a response that is not compressed
    const small = await fetchRaw(url, {
      path: "/small",
      headers: { "x-encoding": "identity" },
    });
    ok(!("content-encoding" in small.headers));
    deepStrictEqual(small.body, "small");

    const precompressed = await fetchRaw(url, {
      headers: { "x-encoding": "br" },
    });
    deepStrictEqual(precompressed.headers["content-encoding"], "br");
    deepStrictEqual(precompressed.raw.toString(), body);

    for (const encoding of ["identity", "IDENTITY, identity"]) {
      const response = await fetchRaw(url, {
        headers: { "x-encoding": encoding },
      });
      deepStrictEqual(response.headers["content-encoding"], "gzip", encoding);
      deepStrictEqual(response.body, body);
    }

    // An empty value is not `identity`
    const empty = await fetchRaw(url, { headers: { "x-encoding": "" } });
    deepStrictEqual(empty.headers["content-encoding"], "");
    deepStrictEqual(empty.raw.toString(), body);
  });

  test("`Cache-Control: no-transform` is sent as it is", async () => {
    const url = await start((context) => {
      const value = context.request.headers["x-cache-control"] as string;
      context.setHeader("Cache-Control", value.split("|"));
      return context.text(body);
    });
    for (const value of [
      "no-transform",
      "public, No-Transform",
      "max-age=0|no-transform",
    ]) {
      const response = await fetchRaw(url, {
        headers: { "x-cache-control": value },
      });
      ok(!("content-encoding" in response.headers), value);
      deepStrictEqual(response.raw.toString(), body);
    }
    const other = await fetchRaw(url, {
      headers: { "x-cache-control": "no-store" },
    });
    deepStrictEqual(other.headers["content-encoding"], "gzip");
  });

  test("`skipCompression()` leaves one response uncompressed", async () => {
    const url = await start(async (context) => {
      const { pathname } = context.url;
      if (pathname === "/skip") {
        skipCompression(context.response);
      } else if (pathname === "/late") {
        context.done = true;
        context.response.setHeader("Content-Type", "text/plain");
        context.response.write(body.slice(0, 1024));
        skipCompression(context.response);
        await new Promise<void>((resolve) => {
          context.response.end(body.slice(1024), resolve);
        });
        return;
      }
      await context.text(body);
    });

    const skipped = await fetchRaw(url, { path: "/skip" });
    ok(!("content-encoding" in skipped.headers));
    deepStrictEqual(skipped.raw.toString(), body);

    // Once the headers are committed, it no longer changes the response
    const late = await fetchRaw(url, { path: "/late" });
    deepStrictEqual(late.headers["content-encoding"], "gzip");
    deepStrictEqual(late.body, body);

    const other = await fetchRaw(url);
    deepStrictEqual(other.headers["content-encoding"], "gzip");

    throws(() => {
      skipCompression({} as BindenResponse);
    }, new TypeError("The response is not a `BindenResponse`"));
  });

  test("a fixed format does not bypass the conditions", async () => {
    const url = await start((context) => {
      if (context.url.pathname === "/no-transform") {
        context.setHeader("Cache-Control", "no-transform");
      }
      return context.url.pathname === "/small"
        ? context.text("small")
        : context.text(body);
    });
    for (const path of ["/small", "/no-transform"]) {
      const response = await fetchRaw(url, { path });
      ok(!("content-encoding" in response.headers), path);
    }
  });

  test("an installation is idempotent", async () => {
    const first = new Compression({ format: "gzip" });
    served = await serve(
      {},
      first,
      first,
      // Would decide first (its methods replace those of the first one)
      new Compression({ format: "br" }),
      (context: Context) => context.text(body),
    );
    const response = await fetchRaw(served.url);

    deepStrictEqual(response.headers["content-encoding"], "gzip");
    deepStrictEqual(response.body, body);
  });

  test("`206` is sent as it is, also without `Content-Range`", async () => {
    const expected = "--boundary--";
    const url = await start(
      (context) =>
        context
          .status(206)
          .setHeader("Content-Type", "multipart/byteranges; boundary=boundary")
          .send(expected),
      { format: "gzip", threshold: 0, filter: (): boolean => true },
    );
    const response = await fetchRaw(url);

    deepStrictEqual(response.status, 206);
    ok(!("content-encoding" in response.headers));
    deepStrictEqual(response.raw.toString(), expected);
  });

  test("a response whose headers have been sent is left as it is", async () => {
    const replaced: string[] = [];
    served = await serve(
      {},
      (context: Context) => {
        context.response.flushHeaders();
      },
      new Compression(),
      (context: Context) => {
        // None of its methods has been replaced
        const names = ["writeHead", "write", "end", "flush", "send"];
        replaced.push(
          ...names.filter((name) => Object.hasOwn(context.response, name)),
        );
        return context.send(body);
      },
    );
    const response = await fetchRaw(served.url, { headers: gzip });

    deepStrictEqual(response.status, 200);
    ok(!("content-encoding" in response.headers));
    ok(!("vary" in response.headers));
    deepStrictEqual(response.raw.toString(), body);
    deepStrictEqual(replaced, []);
  });

  test("`HEAD` gets the headers of `GET`, also for a stream", async () => {
    const url = await start((context) =>
      context
        .setHeader("Content-Type", "text/plain")
        .send(Readable.from([body.slice(0, 1024), body.slice(1024)])),
    );
    for (const method of ["GET", "HEAD"]) {
      const response = await fetchRaw(url, { method });
      deepStrictEqual(response.headers["content-encoding"], "gzip", method);
      ok(!("content-length" in response.headers));
      deepStrictEqual(response.body, method === "GET" ? body : "");
    }
  });

  test("an informational status is sent as it is", async () => {
    const url = await start((context) => {
      context.done = true;
      context.response.writeHead(102, { "Content-Type": "text/plain" });
      context.response.end();
    });
    const { port } = new URL(url);
    const socket = connect(Number(port), "localhost");
    socket.end(
      "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    );
    let head = "";
    for await (const chunk of socket) {
      head += (chunk as Buffer).toString();
      if (head.includes("\r\n\r\n")) {
        break;
      }
    }
    socket.destroy();

    ok(head.startsWith("HTTP/1.1 102 Processing\r\n"), head);
    ok(!/content-encoding/iu.test(head), head);
  });

  test("`flushHeaders()` commits the decision", async () => {
    const url = await start(async (context) => {
      context.done = true;
      context.response.setHeader("Content-Type", "text/plain");
      context.response.flushHeaders();
      // Too late to change the representation
      throws(() => context.setHeader("X-Late", "1"), {
        code: "ERR_HTTP_HEADERS_SENT",
      });
      await new Promise<void>((resolve) => {
        context.response.end(body, resolve);
      });
    });
    const response = await fetchRaw(url);

    deepStrictEqual(response.headers["content-encoding"], "gzip");
    deepStrictEqual(response.body, body);
  });

  test("`writeHead()` with its headers commits the decision", async () => {
    const url = await start(async (context) => {
      const { response } = context;
      const { pathname } = context.url;
      context.done = true;
      response.setHeader("X-Before", "1");
      if (pathname === "/object") {
        response.writeHead(200, "Fine", {
          "Content-Type": "text/plain",
          "Content-Length": body.length,
          "": "ignored",
        });
      } else if (pathname === "/flat") {
        response.writeHead(201, ["Content-Type", "text/plain", "", "ignored"]);
      } else if (pathname === "/pairs") {
        response.writeHead(200, [
          ["Content-Type", "text/plain"],
          ["X-Before", "2"],
          ["X-Before", "3"],
        ]);
      } else if (pathname === "/image") {
        response.writeHead(200, { "Content-Type": "image/png" });
      } else {
        response.writeHead(200);
      }
      await new Promise<void>((resolve) => {
        response.end(body, resolve);
      });
    });

    const object = await fetchRaw(url, { path: "/object" });
    deepStrictEqual(object.status, 200);
    deepStrictEqual(object.headers["content-encoding"], "gzip");
    ok(!("content-length" in object.headers));
    deepStrictEqual(object.body, body);

    const flat = await fetchRaw(url, { path: "/flat" });
    deepStrictEqual(flat.status, 201);
    deepStrictEqual(flat.headers["content-encoding"], "gzip");
    deepStrictEqual(flat.body, body);

    const pairs = await fetchRaw(url, { path: "/pairs" });
    deepStrictEqual(pairs.headers["content-encoding"], "gzip");
    deepStrictEqual(pairs.headers["x-before"], "2, 3");
    deepStrictEqual(pairs.body, body);

    // Not compressible, or no `Content-Type`
    for (const path of ["/image", "/none"]) {
      const response = await fetchRaw(url, { path });
      ok(!("content-encoding" in response.headers), path);
      deepStrictEqual(response.raw.toString(), body);
    }
  });

  test("`writeHead()` rejects what Node.js rejects", async () => {
    const errors: unknown[] = [];
    const url = await start((context) => {
      const { response } = context;
      for (const args of [
        [99],
        [1000],
        ["abc"],
        [200, ["Content-Type"]],
      ] as const) {
        try {
          Reflect.apply(response.writeHead.bind(response), response, args);
        } catch (error: unknown) {
          errors.push((error as { code?: unknown }).code);
        }
      }
      return context.text(body);
    });
    const response = await fetchRaw(url);

    deepStrictEqual(errors, [
      "ERR_HTTP_INVALID_STATUS_CODE",
      "ERR_HTTP_INVALID_STATUS_CODE",
      "ERR_HTTP_INVALID_STATUS_CODE",
      "ERR_INVALID_ARG_VALUE",
    ]);
    deepStrictEqual(response.headers["content-encoding"], "gzip");
    deepStrictEqual(response.body, body);
  });

  test("headers committed around the compression are left as they are", async () => {
    const url = await start(async (context) => {
      const { response } = context;
      context.done = true;
      response.setHeader("Content-Type", "text/plain");
      // As Node.js itself would, once the headers are sent
      ServerResponse.prototype.writeHead.call(response, 200);
      throws(() => response.writeHead(200), { code: "ERR_HTTP_HEADERS_SENT" });
      await new Promise<void>((resolve) => {
        response.end(body, resolve);
      });
    });
    const response = await fetchRaw(url);

    ok(!("content-encoding" in response.headers));
    deepStrictEqual(response.raw.toString(), body);
  });

  test("cookies are set by the commit of a compressed response", async () => {
    const cookie = new Cookie({ key: "a", value: "1" });
    const url = await start((context) => {
      context.response.cookies.add(cookie);
      return context.text(body);
    });
    const response = await fetchRaw(url);

    deepStrictEqual(response.headers["content-encoding"], "gzip");
    deepStrictEqual(response.headers["set-cookie"], [cookie.toString()]);
  });

  test("error responses are compressed like the others", async () => {
    const url = await start(() => {
      throw Object.assign(new Error(body), { status: 400, expose: true });
    });
    const response = await fetchRaw(url);

    deepStrictEqual(response.status, 400);
    deepStrictEqual(response.headers["content-encoding"], "gzip");
    deepStrictEqual(response.body, body);
  });
});
