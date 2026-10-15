import {
  Compression,
  type ICompressionOptions,
  isCompressible,
} from "../index.js";
import { ContentType, type Context } from "binden";
import {
  type IServed,
  capture,
  fetchRaw,
  none,
  serve,
  text,
} from "./helpers.js";
import { afterEach, suite, test } from "node:test";
import { deepStrictEqual, ok } from "node:assert";

const gzip = { "Accept-Encoding": "gzip" };

suite("Threshold and filter", () => {
  let served: IServed | null = null;

  afterEach(async () => {
    const current = served;
    served = null;
    await current?.close();
  });

  /** Serves a handler through a compression */
  const start = async (
    handler: (context: Context) => Promise<void> | void,
    options?: ICompressionOptions,
  ): Promise<string> => {
    served = await serve({}, new Compression(options), (context: Context) =>
      handler(context),
    );
    return served.url;
  };

  /** Ends the response with a body (without `Content-Length`) */
  const end = async (context: Context, body: string): Promise<void> => {
    context.done = true;
    await new Promise<void>((resolve) => {
      context.response.end(body, resolve);
    });
  };

  test("`threshold` (1024 by default) compares the `Content-Length`", async () => {
    const url = await start((context) =>
      context.text(text(Number(context.request.headers["x-size"]))),
    );
    for (const [size, coding] of [
      [1023, none],
      [1024, "gzip"],
    ] as const) {
      const response = await fetchRaw(url, {
        headers: { ...gzip, "x-size": `${size}` },
      });
      deepStrictEqual(response.headers["content-encoding"], coding, `${size}`);
      deepStrictEqual(response.body, text(size));
    }

    // Not compressed for its size: sent as it is when the request accepts it
    const small = await fetchRaw(url, { headers: { ...gzip, "x-size": "10" } });
    deepStrictEqual(small.headers["content-length"], "10");
    deepStrictEqual(small.headers.vary, "Accept-Encoding");
    const refused = await fetchRaw(url, {
      headers: { "Accept-Encoding": "gzip, identity;q=0", "x-size": "10" },
    });
    deepStrictEqual(
      [refused.status, refused.headers.vary, refused.raw.length],
      [406, "Accept-Encoding", 0],
    );
  });

  test("`threshold` is set by the option", async () => {
    let url = await start((context) => context.text("tiny"), { threshold: 0 });
    deepStrictEqual(
      (await fetchRaw(url, { headers: gzip })).headers["content-encoding"],
      "gzip",
    );
    await served?.close();

    url = await start((context) => context.text(text(2048)), {
      threshold: 4096,
    });
    ok(
      !("content-encoding" in (await fetchRaw(url, { headers: gzip })).headers),
    );
  });

  test("a body without a length is compressed, the chunk of `end()` is the body", async () => {
    const url = await start(async (context) => {
      const { response } = context;
      response.setHeader("Content-Type", "text/plain");
      const { pathname } = context.url;
      if (pathname === "/stream") {
        response.write("tiny");
        await end(context, "");
      } else {
        await end(context, pathname === "/large" ? text(2048) : "tiny");
      }
    });

    const stream = await fetchRaw(url, { path: "/stream", headers: gzip });
    deepStrictEqual(stream.headers["content-encoding"], "gzip");
    deepStrictEqual(stream.body, "tiny");

    const small = await fetchRaw(url, { headers: gzip });
    ok(!("content-encoding" in small.headers));
    deepStrictEqual(small.headers["content-length"], "4");

    const large = await fetchRaw(url, { path: "/large", headers: gzip });
    deepStrictEqual(large.headers["content-encoding"], "gzip");
    deepStrictEqual(large.body, text(2048));
  });

  test("isCompressible()", () => {
    const cases: [string | null, boolean][] = [
      ["text/plain", true],
      ["text/html; charset=utf-8", true],
      ["text/css", true],
      ["text/csv", true],
      ["text/event-stream", false],
      ["application/json", true],
      ["application/problem+json", true],
      ["application/ld+json", true],
      ["application/javascript", true],
      ["application/xml", true],
      ["application/atom+xml", true],
      ["image/svg+xml", true],
      ["application/wasm", true],
      ["application/x-www-form-urlencoded", true],
      ["font/ttf", true],
      ["image/x-icon", true],
      ["image/png", false],
      ["image/jpeg", false],
      ["font/woff2", false],
      ["application/octet-stream", false],
      ["application/zip", false],
      ["video/mp4", false],
      ["application/jsonx", false],
      [null, false],
    ];
    for (const [type, expected] of cases) {
      const parsed = type === null ? null : ContentType.fromString(type);
      deepStrictEqual(isCompressible(parsed), expected, `${type}`);
    }
    // A media type in another case
    deepStrictEqual(
      isCompressible(new ContentType({ type: "Image/SVG+XML" })),
      true,
    );
    deepStrictEqual(
      isCompressible(new ContentType({ type: "TEXT/Event-Stream" })),
      false,
    );
  });

  test("the default filter decides by the `Content-Type`", async () => {
    const url = await start((context) => {
      const type = context.request.headers["x-type"];
      if (typeof type === "string") {
        context.setHeader("Content-Type", type);
      }
      return context.response.send(Buffer.from(text(2048)));
    });
    const cases: [string | null, string | undefined][] = [
      ["text/html; charset=utf-8", "gzip"],
      ["application/geo+json", "gzip"],
      ["image/png", none],
      ["text/event-stream", none],
      ["not a media type", none],
      [null, "gzip"],
    ];
    for (const [type, coding] of cases) {
      const response = await fetchRaw(url, {
        headers: type === null ? gzip : { ...gzip, "x-type": type },
      });
      deepStrictEqual(response.headers["content-encoding"], coding, `${type}`);
      deepStrictEqual(response.body, text(2048));
    }
  });

  test("a custom filter gets the context and the `Content-Type`", async () => {
    const seen: unknown[] = [];
    const url = await start(
      (context) => {
        context.setHeader("Content-Type", "image/bmp; x=1");
        return context.response.send(Buffer.from(text(2048)));
      },
      {
        filter: (context, type): boolean => {
          seen.push(context.url.pathname, type?.toString());
          return context.url.pathname !== "/no";
        },
      },
    );

    const yes = await fetchRaw(url, { path: "/yes", headers: gzip });
    deepStrictEqual(yes.headers["content-encoding"], "gzip");
    const no = await fetchRaw(url, { path: "/no", headers: gzip });
    ok(!("content-encoding" in no.headers));
    deepStrictEqual(seen, ["/yes", "image/bmp; x=1", "/no", "image/bmp; x=1"]);
  });

  test("a filter that does not return a boolean replaces the response with 500", async () => {
    const results: Record<string, unknown> = {
      "/undefined": none,
      "/string": "true",
      "/number": 1,
      "/promise": Promise.resolve(true),
      "/null": null,
    };
    const captured = capture();
    const callbacks: string[] = [];
    served = await serve(
      { app: { logger: captured.logger } },
      new Compression({
        filter: (context): boolean => {
          const { pathname } = context.url;
          if (pathname === "/throws") {
            throw new Error("filter");
          }
          return results[pathname] as boolean;
        },
      }),
      async (context: Context) => {
        const { response } = context;
        context.done = true;
        response.setHeader("Content-Type", "text/plain");
        response.setHeader("ETag", `"tag"`);
        // Discarded once the response has been replaced
        response.write(text(2048), () => callbacks.push("write"));
        response.write("no callback");
        await new Promise<void>((resolve) => {
          response.end("end", () => {
            callbacks.push("end");
            resolve();
          });
        });
      },
    );

    for (const path of [...Object.keys(results), "/throws"]) {
      const response = await fetchRaw(served.url, { path, headers: gzip });
      deepStrictEqual(response.status, 500, path);
      deepStrictEqual(response.headers["content-length"], "0");
      ok(!("content-type" in response.headers));
      ok(!("etag" in response.headers));
      ok(!("vary" in response.headers));
      deepStrictEqual(response.raw.length, 0);
    }
    // Every callback has run
    deepStrictEqual(
      callbacks.toSorted((a, b) => a.localeCompare(b)),
      [
        ...Array.from({ length: 6 }, () => "end"),
        ...Array.from({ length: 6 }, () => "write"),
      ],
    );
    await captured.waitFor(6);
    deepStrictEqual(captured.records, [
      ...Array.from({ length: 5 }, () => ({
        level: 50,
        msg: "The `filter` of the compression has not returned a boolean",
      })),
      { level: 50, msg: "The `filter` of the compression has failed" },
    ]);
  });
});
