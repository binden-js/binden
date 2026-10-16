import { type AddressInfo, Socket, connect } from "node:net";
import {
  Binden,
  BindenError,
  BindenResponse,
  type Context,
  Cookie,
} from "../index.js";
import { IncomingMessage, createServer } from "node:http";
import { capture, listen, sleep, within } from "./helpers.js";
import { deepStrictEqual, ok, throws } from "node:assert/strict";
import { suite, test } from "node:test";
import { Readable } from "node:stream";
import { once } from "node:events";

/** Writes requests on one connection, and reads everything until the server closes it */
async function converse(port: number, requests: string): Promise<string> {
  const socket = connect(port, "localhost");
  await once(socket, "connect");
  let data = "";
  socket.setEncoding("latin1").on("data", (chunk: string) => {
    data += chunk;
  });
  socket.write(requests);
  await within(once(socket, "close"), 5000);
  return data.replaceAll(/\r\nDate: [^\r]*/gu, "");
}

/** A copy of a plain value (an object of Node.js, e.g. its headers, or an array); any other object is itself */
function copy(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  } else if (Array.isArray(value)) {
    return value.map(copy);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) {
    return value;
  }
  return Object.fromEntries(
    Reflect.ownKeys(value).map((key) => [
      String(key),
      copy(Reflect.get(value, key)),
    ]),
  );
}

/**
 * Every own property of a response (string and symbol keys, the contents of
 * its plain objects, e.g. of its headers), the values of its accessors (also
 * of the framing properties that binden stores apart), and its public state
 */
function snapshot(response: BindenResponse): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(response)) {
    state[String(key)] = copy(Reflect.get(response, key));
  }
  for (const name of [
    "chunkedEncoding",
    "maxRequestsOnConnectionReached",
    "sendDate",
    "shouldKeepAlive",
    "strictContentLength",
    "useChunkedEncodingByDefault",
    "statusCode",
    "statusMessage",
    "headersSent",
    "writableEnded",
    "started",
  ]) {
    state[`get ${name}`] = Reflect.get(response, name);
  }
  state["getHeaders()"] = copy({ ...response.getHeaders() });
  state["getRawHeaderNames()"] = (
    response as unknown as { getRawHeaderNames(): string[] }
  ).getRawHeaderNames();
  state.cookies = [...response.cookies].map(String);
  return state;
}

suite("A head that Node.js refuses", () => {
  test("leaves the response as it was before the attempt, field by field (also of Node.js)", async () => {
    /** The attempts to commit a head that Node.js refuses */
    const attempts: Record<string, (response: BindenResponse) => unknown> = {
      "writeHead()": (response) => response.writeHead(200),
      "writeHead() with a reason and headers": (response) =>
        response.writeHead(201, "Made", { "X-A": "1", "Content-Length": 4 }),
      "writeHead() with pairs": (response) =>
        response.writeHead(202, ["X-B", "2", "Connection", "close"]),
      "write()": (response) => response.write("body"),
      "end()": (response) => response.end("body"),
      "end() of bytes in an encoding": (response) =>
        response.end(Buffer.from("body"), "base64"),
      "flushHeaders()": (response) => {
        response.flushHeaders();
      },
      // Node.js has decided that it has no body
      "writeHead(204)": (response) => response.writeHead(204),
      // ... and not to keep the connection alive, as it is chunked
      "writeHead(304) of a chunked body": (response) =>
        response.writeHead(304, { "Transfer-Encoding": "chunked" }),
    };
    /** The headers set before (with a `Trailer` that Node.js refuses for a body that is not chunked) */
    const setups: Record<string, (response: BindenResponse) => void> = {
      "a length and a connection kept alive": (response) => {
        response.setHeader("Connection", "keep-alive");
        response.setHeader("Keep-Alive", "timeout=5");
        response.setHeader("Content-Length", 4);
      },
      // Neither a length nor chunks: Node.js closes the connection
      "removed framing and a cookie": (response) => {
        response.setHeader("Content-Length", 4);
        response.removeHeader("Content-Length");
        response.removeHeader("Transfer-Encoding");
        response.cookies.add(new Cookie({ key: "a", value: "1" }));
      },
      // Removing it would not send a `Date`
      "a date": (response) => {
        response.setHeader("Content-Length", 4);
        response.setHeader("Date", "Thu, 01 Jan 2026 00:00:00 GMT");
      },
      // Node.js counts the bytes of a chunk before it commits the head
      "a strict length": (response) => {
        response.strictContentLength = true;
        response.setHeader("Content-Length", 4);
      },
    };
    const failures: string[] = [];
    const server = createServer(
      { ServerResponse: BindenResponse },
      (request: IncomingMessage, response: BindenResponse) => {
        if (request.url === "/next") {
          response.end("next");
          return;
        }
        const { pathname, searchParams } = new URL(
          request.url ?? "/",
          "http://a",
        );
        setups[decodeURIComponent(pathname).slice(1)](response);
        response.setHeader("Trailer", "X-T");
        // Without the attempts: the reply that the others must send
        const control = searchParams.has("control");
        for (const [name, attempt] of Object.entries(control ? {} : attempts)) {
          const before = snapshot(response);
          throws(
            () => attempt(response),
            { code: "ERR_HTTP_TRAILER_INVALID" },
            name,
          );
          const after = snapshot(response);
          for (const key of new Set([
            ...Object.keys(before),
            ...Object.keys(after),
          ])) {
            try {
              deepStrictEqual(after[key], before[key]);
            } catch {
              failures.push(`${request.url}: ${name}: ${key}`);
            }
          }
        }
        // The next reply is framed as if nothing had been attempted
        response.removeHeader("Trailer");
        response.setHeader("Content-Length", 4).end("body");
      },
    );
    server.listen(0, "localhost");
    await once(server, "listening");
    try {
      const { port } = server.address() as AddressInfo;
      for (const version of ["1.1", "1.0"]) {
        for (const setup of Object.keys(setups)) {
          const keep = version === "1.0" ? "Connection: keep-alive\r\n" : "";
          const exchange = (query: string): Promise<string> =>
            converse(
              port,
              `GET /${encodeURIComponent(setup)}${query} HTTP/${version}\r\nHost: a\r\n${keep}\r\n` +
                `GET /next HTTP/${version}\r\nHost: a\r\nConnection: close\r\n\r\n`,
            );
          const name = `HTTP/${version}: ${setup}`;
          const data = await exchange("");
          // Byte for byte the reply of a response without the attempts
          deepStrictEqual(data, await exchange("?control"), name);
          ok(
            data.includes("\r\n\r\nbodyHTTP/1.1 200 OK\r\n"),
            `${name}: ${data}`,
          );
          ok(data.endsWith("\r\n\r\nnext"), `${name}: ${data}`);
        }
      }
    } finally {
      server.closeAllConnections();
      server.close();
    }
    deepStrictEqual(failures, []);
  });

  test("the error reply is framed as if it had not been attempted, and the next request is answered", async () => {
    const big = "t".repeat(3000);
    /** Replies whose head Node.js refuses (a `Trailer` of a body that is not chunked) */
    const replies: Record<string, (context: Context) => unknown> = {
      // Set before: the connection kept alive, and a length
      length: ({ response }) => {
        response.setHeader("Connection", "keep-alive");
        response.setHeader("Keep-Alive", "timeout=5");
        response.setHeader("Content-Length", big.length);
        response.setHeader("Trailer", "X-T");
        response.end(big);
      },
      // Of HTTP/1.0: neither a length nor chunks
      stream: ({ response }) => {
        response.setHeader("Trailer", "X-T");
        return response.type("text/plain").send(Readable.from([big]));
      },
      write: ({ response }) => {
        response.setHeader("Trailer", "X-T");
        response.write(big);
        response.end();
      },
      // The `304` of the dynamic `ETag`
      "not-modified": async (context) => {
        context.response.setHeader("Trailer", "X-T");
        await context.text(big);
      },
    };
    const app = new Binden({ etag: true }).use(async (context: Context) => {
      const reply = replies[context.url.pathname.slice(1)];
      if (typeof reply === "undefined") {
        await context.text("next");
        return;
      }
      await reply(context);
    });
    const listening = await listen(app);
    try {
      // HTTP/1.1 chunks a body without a length (with its trailers)
      const refused: [string, string[]][] = [
        ["1.1", ["length", "not-modified"]],
        ["1.0", Object.keys(replies)],
      ];
      for (const [version, paths] of refused) {
        for (const path of paths) {
          const name = `HTTP/${version} ${path}`;
          const keep = version === "1.0" ? "Connection: keep-alive\r\n" : "";
          const data = await converse(
            listening.port,
            `GET /${path} HTTP/${version}\r\nHost: a\r\n${keep}If-None-Match: *\r\n\r\n` +
              `GET /next HTTP/${version}\r\nHost: a\r\n${keep}\r\n` +
              "GET /next HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n",
          );
          const [failed = "", ...rest] = data.split(/(?=HTTP\/1\.1 )/u);
          const head = failed.split("\r\n");
          deepStrictEqual(head[0], "HTTP/1.1 500 Internal Server Error", name);
          ok(head.includes("Content-Length: 0"), `${name}: ${failed}`);
          ok(head.includes("Connection: keep-alive"), `${name}: ${failed}`);
          // Never a `Trailer` nor another framing
          ok(!/^(?:Trailer|Transfer-Encoding)/imu.test(failed), failed);
          deepStrictEqual(rest.length, 2, `${name}: ${data}`);
          for (const next of rest) {
            ok(next.startsWith("HTTP/1.1 200 OK\r\n"), `${name}: ${next}`);
            ok(next.endsWith("\r\n\r\nnext"), `${name}: ${next}`);
          }
        }
      }
    } finally {
      await listening.close();
    }
  });

  test("the bytes of a refused chunk are not counted for `strictContentLength`", async () => {
    /** A refused head (a `Trailer` of a body that is not chunked) of each path */
    const attempts: Record<string, (response: BindenResponse) => unknown> = {
      end: (response) => response.end("body"),
      write: (response) => response.write("body"),
    };
    const refused: unknown[] = [];
    const server = createServer(
      { ServerResponse: BindenResponse },
      (request: IncomingMessage, response: BindenResponse) => {
        const attempt = attempts[(request.url ?? "/").slice(1)];
        if (typeof attempt === "undefined") {
          response.end("next");
          return;
        }
        response.strictContentLength = true;
        response.setHeader("Content-Length", 4);
        response.setHeader("Trailer", "X-T");
        try {
          attempt(response);
        } catch (error: unknown) {
          refused.push((error as { code?: unknown }).code);
        }
        response.removeHeader("Trailer");
        response.end("body");
      },
    );
    server.listen(0, "localhost");
    await once(server, "listening");
    try {
      const { port } = server.address() as AddressInfo;
      for (const name of Object.keys(attempts)) {
        const data = await converse(
          port,
          `GET /${name} HTTP/1.1\r\nHost: a\r\n\r\n` +
            "GET /next HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n",
        );
        const [first = "", next = "", ...rest] = data.split(/(?=HTTP\/1\.1 )/u);
        deepStrictEqual(
          [first, rest],
          [
            "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: keep-alive\r\nKeep-Alive: timeout=5\r\n\r\nbody",
            [],
          ],
          name,
        );
        ok(next.endsWith("\r\n\r\nnext"), `${name}: ${next}`);
      }
      deepStrictEqual(refused, [
        "ERR_HTTP_TRAILER_INVALID",
        "ERR_HTTP_TRAILER_INVALID",
      ]);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  test("the error reply of a refused strict chunk has its length, and the next request is answered", async () => {
    const replies: Record<string, (context: Context) => unknown> = {
      end: ({ response }) => {
        response.end("abc");
      },
      write: ({ response }) => {
        response.write("abc");
      },
      text: (context) => context.text("abc"),
    };
    const app = new Binden().use(async (context: Context) => {
      const reply = replies[context.url.pathname.slice(1)];
      if (typeof reply === "undefined") {
        await context.text("next");
        return;
      }
      const { response } = context;
      response.strictContentLength = true;
      response.setHeader("Trailer", "X-T");
      response.setHeader("Content-Length", 3);
      await reply(context);
    });
    const listening = await listen(app);
    try {
      for (const path of Object.keys(replies)) {
        const data = await converse(
          listening.port,
          `GET /${path} HTTP/1.1\r\nHost: a\r\n\r\n` +
            "GET /next HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n",
        );
        const [failed = "", next = "", ...rest] =
          data.split(/(?=HTTP\/1\.1 )/u);
        deepStrictEqual(
          [failed, rest],
          [
            "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: keep-alive\r\nKeep-Alive: timeout=5\r\n\r\n",
            [],
          ],
          path,
        );
        ok(next.endsWith("\r\n\r\nnext"), `${path}: ${next}`);
      }
    } finally {
      await listening.close();
    }
  });

  test("an error reply whose end() throws once its head is committed closes the connection", async () => {
    // The counter of `strictContentLength` of Node.js, set as a refused head
    // would have left it if it were not restored: the `end()` of every reply
    // throws once it has committed its head
    const counter = Object.getOwnPropertySymbols(
      new BindenResponse(new IncomingMessage(new Socket())),
    ).find((key) => key.description === "kBytesWritten") as symbol;
    const miscount = (response: BindenResponse): void => {
      response.strictContentLength = true;
      Reflect.set(response, counter, 3);
    };
    const captured = capture();
    const app = new Binden({
      logger: captured.logger,
      error_handler: ({ request, response }: Context): void => {
        if (request.url === "/handler") {
          // Its own failure: the framework replies an opaque `500`
          miscount(response);
          throw new Error("Failed");
        }
      },
    }).use(({ response }: Context) => {
      miscount(response);
      throw new Error("Failed");
    });
    const listening = await listen(app);
    try {
      for (const path of ["/stack", "/handler"]) {
        // The head of the reply is never sent: closed, rather than left open
        const data = await converse(
          listening.port,
          `GET ${path} HTTP/1.1\r\nHost: a\r\n\r\n`,
        );
        deepStrictEqual(data, "", path);
      }
      const unsent = captured.records.filter(
        ({ msg }) => msg === "The error reply has not been sent",
      );
      deepStrictEqual(
        unsent.map(
          ({ failure }) => (failure as { code?: unknown } | undefined)?.code,
        ),
        [
          "ERR_HTTP_CONTENT_LENGTH_MISMATCH",
          "ERR_HTTP_CONTENT_LENGTH_MISMATCH",
        ],
      );
    } finally {
      await listening.close();
    }
  });

  test("an error reply that has ended is not cut when its send fails later", async () => {
    const late: unknown[] = [];
    const closed: unknown[] = [];
    const captured = capture();
    const app = new Binden({
      logger: captured.logger,
      error_handler: ({ response }: Context): void => {
        // Does not reply (the framework does), then writes once the reply has
        // ended, while it waits for the response before it: Node.js emits
        // `ERR_STREAM_WRITE_AFTER_END`, and the send of the reply rejects
        setTimeout(() => {
          late.push(response.writableEnded, response.writableFinished);
          response.write("late");
        }, 50);
      },
    }).use(async (context: Context) => {
      if (context.url.pathname === "/first") {
        await sleep(150);
        await context.text("first");
        return;
      }
      throw new BindenError(500, { expose: true, message: "failed" });
    });
    const listening = await listen(app);
    listening.server.on(
      "request",
      (request: IncomingMessage, response: BindenResponse) => {
        response.once("close", () => {
          closed.push([request.url, response.writableFinished]);
        });
      },
    );
    try {
      const data = await converse(
        listening.port,
        "GET /first HTTP/1.1\r\nHost: a\r\n\r\n" +
          "GET /second HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n",
      );
      const [first = "", second = "", ...rest] = data.split(/(?=HTTP\/1\.1 )/u);
      ok(first.endsWith("\r\n\r\nfirst"), first);
      ok(second.startsWith("HTTP/1.1 500 Internal Server Error\r\n"), second);
      ok(second.endsWith("\r\n\r\nfailed"), second);
      deepStrictEqual(rest, []);
      deepStrictEqual(late, [true, false]);
      deepStrictEqual(closed, [
        ["/first", true],
        ["/second", true],
      ]);
      const { failure } = await captured.waitFor(
        "The error reply has not been sent",
      );
      deepStrictEqual(
        (failure as { code?: unknown }).code,
        "ERR_STREAM_WRITE_AFTER_END",
      );
    } finally {
      await listening.close();
    }
  });

  test("a failure once the head is committed is not rolled back", async () => {
    const outcomes: unknown[] = [];
    const server = createServer(
      { ServerResponse: BindenResponse },
      (_request: IncomingMessage, response: BindenResponse) => {
        // Strict: Node.js throws once it has committed the head
        response.strictContentLength = true;
        response.setHeader("Content-Length", 10);
        try {
          response.end("abc");
        } catch (error: unknown) {
          outcomes.push((error as { code?: unknown }).code);
        }
        outcomes.push(
          response.headersSent,
          response.getHeader("Content-Length"),
        );
        response.destroy();
      },
    );
    server.listen(0, "localhost");
    await once(server, "listening");
    try {
      await converse(
        (server.address() as AddressInfo).port,
        "GET / HTTP/1.1\r\nHost: a\r\n\r\n",
      );
      deepStrictEqual(outcomes, ["ERR_HTTP_CONTENT_LENGTH_MISMATCH", true, 10]);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
