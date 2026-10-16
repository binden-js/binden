import { type AddressInfo, connect } from "node:net";
import { Binden, BindenResponse, type Context } from "../index.js";
import { type IListening, listen, sleep, within } from "./helpers.js";
import {
  type IncomingMessage,
  OutgoingMessage,
  ServerResponse,
  createServer,
} from "node:http";
import { deepStrictEqual, ok } from "node:assert/strict";
import { suite, test } from "node:test";
import { Readable } from "node:stream";
import { once } from "node:events";

const hints = { link: "</style.css>; rel=preload; as=style" };
const body = Buffer.from("bytes");

/** A promise with its `resolve()` */
function gate(): { promise: Promise<void>; open(): void } {
  const { promise, resolve } = Promise.withResolvers<never>();
  return { promise, open: resolve as () => void };
}

/**
 * Writes requests on one connection, and reads the responses until the
 * server closes it (the last request has `Connection: close`)
 */
async function converse(port: number, requests: string): Promise<string> {
  const socket = connect(port, "127.0.0.1");
  await once(socket, "connect");
  let data = "";
  socket.setEncoding("latin1").on("data", (chunk: string) => {
    data += chunk;
  });
  socket.write(requests);
  await within(once(socket, "close"), 5000);
  return data;
}

/**
 * Sends two pipelined requests on one connection, and reads the responses
 * until the server closes it (the second request has `Connection: close`)
 */
function pipelined(port: number, second: string): Promise<string> {
  return converse(
    port,
    `GET /first HTTP/1.1\r\nHost: a\r\n\r\nGET ${second} HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n`,
  );
}

suite("Informational responses of a pipelined request", () => {
  // The first request replies once the second has replied: the response of
  // the second (with its `103 Early Hints`) is queued until then
  const replied = { current: gate() };
  const replies: Partial<Record<string, (context: Context) => unknown>> = {
    "/send": (context) => context.send(body),
    "/write-head": ({ response }) => {
      response.writeHead(200, { "Content-Length": body.length }).end(body);
    },
    "/write": ({ response }) => {
      response.setHeader("Content-Length", body.length);
      response.write(new Uint8Array(body), "utf8", () => {
        response.end();
      });
    },
    "/end": ({ response }) => {
      response.setHeader("Content-Length", body.length);
      response.end(body, () => {
        // Ended
      });
    },
    "/stream": (context) =>
      context
        .setHeader("Content-Length", body.length)
        .send(Readable.from([body])),
    "/file": async (context) => {
      await context.response.sendFile(import.meta.filename, {
        content_type: "text/plain",
      });
    },
  };

  const withApp = async (
    fn: (listening: IListening) => Promise<void>,
  ): Promise<void> => {
    const app = new Binden({ timeout: 100 }).use(async (context: Context) => {
      const { pathname } = context.url;
      if (pathname === "/first") {
        // Without a deadline: it waits for the second one
        context.setTimeout(0);
        await replied.current.promise;
        await sleep(20);
        await context.send("first");
        return;
      } else if (pathname === "/delayed") {
        context.response.writeEarlyHints(hints);
        // Its first chunk never comes: the deadline cancels the send
        await context.send(
          new Readable({
            read(): void {
              // Nothing
            },
          }),
        );
        return;
      }
      // Ended by its reply, not by the deadline
      context.setTimeout(0);
      context.response.writeEarlyHints(hints);
      const reply = replies[pathname]?.(context);
      replied.current.open();
      await reply;
    });
    const listening = await listen(app);
    try {
      await fn(listening);
    } finally {
      await listening.close();
    }
  };

  test("are sent before the response, also when its body is bytes", async () => {
    await withApp(async ({ port }) => {
      for (const path of Object.keys(replies)) {
        replied.current = gate();
        const data = await pipelined(port, path);
        const [first = "", early = "", second = ""] =
          data.split(/(?=HTTP\/1\.1 )/u);
        ok(first.startsWith("HTTP/1.1 200 OK\r\n"), `${path}: ${data}`);
        ok(first.endsWith("\r\n\r\nfirst"), `${path}: ${first}`);
        deepStrictEqual(
          early,
          `HTTP/1.1 103 Early Hints\r\nLink: ${hints.link}\r\n\r\n`,
          path,
        );
        ok(second.startsWith("HTTP/1.1 200 OK\r\n"), `${path}: ${second}`);
        if (path === "/file") {
          ok(second.includes('suite("Informational responses'), path);
        } else {
          ok(
            second.endsWith(`\r\n\r\n${body.toString()}`),
            `${path}: ${second}`,
          );
        }
      }
    });
  });

  test("a send whose first chunk is late is still cancelled by the deadline", async () => {
    await withApp(async ({ port }) => {
      // The first request replies once the deadline has passed
      replied.current = gate();
      setTimeout(() => {
        replied.current.open();
      }, 150);
      const data = await pipelined(port, "/delayed");
      const [, early = "", second = ""] = data.split(/(?=HTTP\/1\.1 )/u);
      deepStrictEqual(
        early,
        `HTTP/1.1 103 Early Hints\r\nLink: ${hints.link}\r\n\r\n`,
      );
      ok(second.startsWith("HTTP/1.1 503 "), second);
    });
  });
});

suite("Informational responses to HTTP/1.0", () => {
  /** The raw response of one request of `version` (read until the server closes) */
  async function raw(port: number, version: string): Promise<string> {
    const socket = connect(port, "127.0.0.1");
    await once(socket, "connect");
    let data = "";
    socket.setEncoding("latin1").on("data", (chunk: string) => {
      data += chunk;
    });
    socket.write(
      `GET / HTTP/${version}\r\nHost: a\r\nConnection: close\r\n\r\n`,
    );
    await within(once(socket, "close"), 5000);
    return data;
  }

  test("an HTTP/1.0 client never gets an informational response (RFC 9110, 15.2)", async () => {
    const callbacks: string[] = [];
    const app = new Binden().use(async ({ response }: Context) => {
      response.writeContinue(() => callbacks.push("continue"));
      response.writeProcessing(() => callbacks.push("processing"));
      response.writeEarlyHints(hints, () => callbacks.push("hints"));
      await new Promise<null>((resolve) => {
        response.end("final", () => {
          resolve(null);
        });
      });
    });
    const listening = await listen(app);
    try {
      const old = await raw(listening.port, "1.0");
      ok(old.startsWith("HTTP/1.1 200 OK\r\n"), old);
      ok(!/HTTP\/1\.1 1\d\d /u.test(old), old);
      ok(old.endsWith("final"), old);
      // Ignored, but each callback is called once
      deepStrictEqual(callbacks.toSorted(), [
        "continue",
        "hints",
        "processing",
      ]);

      callbacks.length = 0;
      const current = await raw(listening.port, "1.1");
      ok(current.startsWith("HTTP/1.1 100 Continue\r\n"), current);
      ok(current.includes("HTTP/1.1 102 Processing\r\n"), current);
      ok(current.includes("HTTP/1.1 103 Early Hints\r\n"), current);
    } finally {
      await listening.close();
    }
  });
});

suite("Informational responses, then a native write in any encoding", () => {
  /** A reply written with the methods of Node.js, which passes `callback` to them */
  type IReply = (response: ServerResponse, callback: () => void) => void;

  interface ICase {
    readonly method?: string;
    readonly status?: number;
    /** How many times the reply passes its callback */
    readonly callbacks: number;
    readonly reply: IReply;
  }

  const hi = (): Buffer => Buffer.from("hi");
  /** `undefined`, which the linter does not let the tests write */
  const none = ({} as { value?: undefined }).value as unknown as BufferEncoding;
  /** Ends the first response of a connection once the second has replied */
  const later = (replied: Promise<void>, response: ServerResponse): void => {
    replied.then(
      async () => {
        await sleep(20);
        response.end("first");
      },
      () => {
        // Never rejects
      },
    );
  };
  // Strings that Node.js frames by an estimate of their length (e.g. an odd
  // number of hex digits, which aborts Node.js 24 as it writes them to a
  // socket) are not written as Node.js writes them: see `process.test.ts`
  const cases: Record<string, ICase> = {
    "end(string, 'utf-8')": {
      callbacks: 0,
      reply: (r) => r.end("h\u00e9llo", "utf-8"),
    },
    "end(string, 'UTF8')": {
      callbacks: 0,
      reply: (r) => r.end("hi", "UTF8" as BufferEncoding),
    },
    "end(string, 'ascii')": {
      callbacks: 0,
      reply: (r) => r.end("hi", "ascii"),
    },
    "end(string, 'binary')": {
      callbacks: 0,
      reply: (r) => r.end("h\u00e9", "binary"),
    },
    "end(base64, callback)": {
      callbacks: 1,
      reply: (r, cb) => r.end("aGk=", "base64", cb),
    },
    "write(base64) + end()": {
      callbacks: 0,
      reply: (r) => {
        r.write("aGk=", "base64");
        r.end();
      },
    },
    "write(hex, callback) + end(callback)": {
      callbacks: 2,
      reply: (r, cb) => {
        r.write("6869", "hex", cb);
        r.end(cb);
      },
    },
    "write(HEX) + end()": {
      callbacks: 0,
      reply: (r) => {
        r.write("6869", "HEX" as BufferEncoding);
        r.end();
      },
    },
    "end(base64url, callback)": {
      callbacks: 1,
      reply: (r, cb) => r.end("aGk", "base64url", cb),
    },
    // An empty string is no chunk, also in these encodings
    "end(string) + end('', 'hex', callback)": {
      callbacks: 1,
      reply: (r, cb) => {
        r.end("hi");
        r.end("", "hex", cb);
      },
    },
    "end()": { callbacks: 0, reply: (r) => r.end() },
    "end(callback)": { callbacks: 1, reply: (r, cb) => r.end(cb) },
    "end(bytes)": { callbacks: 0, reply: (r) => r.end(hi()) },
    "end(Uint8Array, 'buffer')": {
      callbacks: 0,
      reply: (r) => r.end(new Uint8Array(hi()), "buffer" as BufferEncoding),
    },
    "write(bytes, undefined, callback) + end()": {
      callbacks: 1,
      reply: (r, cb) => {
        r.write(hi(), none, cb);
        r.end();
      },
    },
    "write(bytes, null, callback) + end()": {
      callbacks: 1,
      reply: (r, cb) => {
        r.write(hi(), null as unknown as BufferEncoding, cb);
        r.end();
      },
    },
    "end(bytes, undefined, callback)": {
      callbacks: 1,
      reply: (r, cb) => r.end(hi(), none, cb),
    },
    "Content-Length, write(bytes) + end(bytes, callback)": {
      callbacks: 1,
      reply: (r, cb) => {
        r.setHeader("Content-Length", 4);
        r.write(hi());
        r.end(hi(), cb);
      },
    },
    "writeHead(), a 204 status, end(bytes)": {
      callbacks: 0,
      reply: (r) => {
        r.writeHead(200, { "Content-Length": 2 }).statusCode = 204;
        r.end(hi());
      },
    },
    "writeHead() + end(bytes)": {
      callbacks: 0,
      reply: (r) => r.writeHead(200).end(hi()),
    },
    "HEAD: end(bytes)": {
      method: "HEAD",
      callbacks: 0,
      reply: (r) => r.end(hi()),
    },
    "HEAD: end(string, 'utf-8', callback)": {
      method: "HEAD",
      callbacks: 1,
      reply: (r, cb) => r.end("hi", "utf-8", cb),
    },
    "204: end(bytes)": { status: 204, callbacks: 0, reply: (r) => r.end(hi()) },
    "304: write(hex) + end()": {
      status: 304,
      callbacks: 0,
      reply: (r) => {
        r.write("6869", "hex");
        r.end();
      },
    },
    "102: end(bytes)": { status: 102, callbacks: 0, reply: (r) => r.end(hi()) },
    "205: end(bytes)": { status: 205, callbacks: 0, reply: (r) => r.end(hi()) },
    // Ignored by Node.js, whatever their encoding
    "HEAD: end(string, 'bogus')": {
      method: "HEAD",
      callbacks: 0,
      reply: (r) => r.end("hi", "bogus" as BufferEncoding),
    },
    "204: write(string, 'bogus') + end()": {
      status: 204,
      callbacks: 0,
      reply: (r) => {
        r.write("hi", "bogus" as BufferEncoding);
        r.end();
      },
    },
    "304: end(bytes, 'bogus')": {
      status: 304,
      callbacks: 0,
      reply: (r) => r.end(hi(), "bogus" as BufferEncoding),
    },
    "102: end(string, 'bogus')": {
      status: 102,
      callbacks: 0,
      reply: (r) => r.end("hi", "bogus" as BufferEncoding),
    },
    "end('', 'bogus')": {
      callbacks: 0,
      reply: (r) => r.end("", "bogus" as BufferEncoding),
    },
    "end(string) + write(string, 'bogus', callback)": {
      callbacks: 1,
      reply: (r, cb) => {
        // Node.js emits `ERR_STREAM_WRITE_AFTER_END`
        r.on("error", () => {
          // Expected
        });
        r.end("hi");
        r.write("hi", "bogus" as BufferEncoding, cb);
      },
    },
  };

  /** The second response of a connection, without its `Date` */
  const undated = (data: string): string =>
    data.replaceAll(/\r\nDate: [^\r]*/gu, "");

  /**
   * Serves the case of a path with `Response` (and the first request of a
   * pipelined pair, which replies once the second has replied), and reads
   * the requests from one connection until the server closes it
   */
  async function exchange(
    Response: typeof ServerResponse,
    requests: string,
    informational: boolean,
  ): Promise<{ data: string; calls: Map<string, number> }> {
    const calls = new Map<string, number>();
    const replied = gate();
    const server = createServer(
      { ServerResponse: Response as typeof BindenResponse },
      (request: IncomingMessage, response: ServerResponse) => {
        const path = decodeURIComponent(request.url ?? "/").slice(1);
        if (path === "first") {
          later(replied.promise, response);
          return;
        }
        const { status = 200, reply } = cases[path];
        if (informational) {
          response.writeEarlyHints({ link: "</a.css>; rel=preload" });
        }
        response.statusCode = status;
        reply(response, () => {
          calls.set(path, (calls.get(path) ?? 0) + 1);
        });
        replied.open();
      },
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const { port } = server.address() as AddressInfo;
      const socket = connect(port, "127.0.0.1");
      let data = "";
      socket.setEncoding("latin1").on("data", (chunk: string) => {
        data += chunk;
      });
      socket.write(requests);
      await within(once(socket, "close"), 5000);
      // The callbacks of the last writes run once they are flushed
      await sleep(20);
      return { data, calls };
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }

  test("are sent first, and the response is framed as Node.js frames it", async () => {
    for (const [name, { method = "GET", callbacks }] of Object.entries(cases)) {
      const target = `/${encodeURIComponent(name)}`;
      const last = `${method} ${target} HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n`;
      // Node.js itself, with nothing queued before the response
      const native = await exchange(ServerResponse, last, false);
      const queued = await exchange(
        BindenResponse,
        `GET /first HTTP/1.1\r\nHost: a\r\n\r\n${last}`,
        true,
      );
      const early =
        "HTTP/1.1 103 Early Hints\r\nLink: </a.css>; rel=preload\r\n\r\n";
      const index = queued.data.indexOf(early);
      ok(index > 0, `${name}: ${queued.data}`);
      ok(queued.data.slice(0, index).endsWith("\r\n\r\nfirst"), name);
      deepStrictEqual(
        undated(queued.data.slice(index + early.length)),
        undated(native.data),
        name,
      );
      deepStrictEqual(native.calls.get(name) ?? 0, callbacks, name);
      deepStrictEqual(queued.calls.get(name) ?? 0, callbacks, name);
    }
  });

  test("a chunk that Node.js refuses sends nothing, and the response can still reply", async () => {
    const invalid: Record<string, [string, (r: ServerResponse) => unknown]> = {
      "unknown encoding": [
        "ERR_UNKNOWN_ENCODING",
        (r): unknown => r.end("hi", "bogus" as BufferEncoding),
      ],
      "unknown encoding of a length": [
        "ERR_UNKNOWN_ENCODING",
        (r): unknown =>
          r.setHeader("Content-Length", 2).end("hi", "bogus" as BufferEncoding),
      ],
      "unknown encoding of bytes": [
        "ERR_UNKNOWN_ENCODING",
        (r): unknown => r.write(hi(), "bogus" as BufferEncoding),
      ],
      "bytes encoding of a string": [
        "ERR_UNKNOWN_ENCODING",
        (r): unknown => r.end("hi", "buffer" as BufferEncoding),
      ],
      "encoding that is not a string": [
        "ERR_UNKNOWN_ENCODING",
        (r): unknown => r.end(hi(), 1 as unknown as BufferEncoding),
      ],
      "not bytes": ["ERR_INVALID_ARG_TYPE", (r): unknown => r.end(1)],
      null: ["ERR_STREAM_NULL_VALUES", (r): unknown => r.write(null)],
    };
    // After early hints, behind another response (where Node.js would crash
    // the process as it flushes the head), and alone
    const modes = { hints: true, pipelined: true, alone: false };
    for (const [mode, behind] of Object.entries(modes)) {
      for (const [name, [code, reply]] of Object.entries(invalid)) {
        const replied = gate();
        const outcomes: unknown[] = [];
        const server = createServer(
          { ServerResponse: BindenResponse },
          (request: IncomingMessage, response: ServerResponse) => {
            if (request.url === "/first") {
              later(replied.promise, response);
              return;
            } else if (mode === "hints") {
              response.writeEarlyHints({ link: "</a.css>; rel=preload" });
            }
            try {
              reply(response);
            } catch (error: unknown) {
              outcomes.push(
                (error as { code?: unknown }).code,
                response.headersSent,
              );
              response.setHeader("Content-Length", 8).end("fallback");
            }
            replied.open();
          },
        );
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        try {
          const { port } = server.address() as AddressInfo;
          const data = behind
            ? await pipelined(port, "/second")
            : await converse(
                port,
                "GET /second HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n",
              );
          const key = `${mode}: ${name}`;
          deepStrictEqual(outcomes, [code, false], key);
          const responses = undated(data).split(/(?=HTTP\/1\.1 )/u);
          deepStrictEqual(
            responses.slice(behind ? 1 : 0),
            [
              ...(mode === "hints"
                ? [
                    "HTTP/1.1 103 Early Hints\r\nLink: </a.css>; rel=preload\r\n\r\n",
                  ]
                : []),
              "HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nfallback",
            ],
            key,
          );
        } finally {
          server.closeAllConnections();
          server.close();
        }
      }
    }
  });

  test("a destroyed response refuses nothing, as with Node.js", async () => {
    const results: unknown[] = [];
    for (const Response of [ServerResponse, BindenResponse]) {
      const replied = gate();
      const outcomes: unknown[] = [];
      const server = createServer(
        { ServerResponse: Response as typeof BindenResponse },
        (request: IncomingMessage, response: ServerResponse) => {
          if (request.url === "/first") {
            later(replied.promise, response);
            return;
          }
          response.writeEarlyHints({ link: "</a.css>; rel=preload" });
          response.destroy();
          response.end(hi(), "bogus" as BufferEncoding, () => {
            outcomes.push("called");
          });
          outcomes.push("returned");
          replied.open();
        },
      );
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const socket = connect(
        (server.address() as AddressInfo).port,
        "127.0.0.1",
      );
      try {
        let data = "";
        socket.setEncoding("latin1").on("data", (chunk: string) => {
          data += chunk;
        });
        socket.write(
          "GET /first HTTP/1.1\r\nHost: a\r\n\r\nGET /second HTTP/1.1\r\nHost: a\r\n\r\n",
        );
        // Node.js keeps the connection open: what it has sent by then
        await sleep(200);
        results.push([undated(data), outcomes]);
      } finally {
        socket.destroy();
        server.closeAllConnections();
        server.close();
      }
    }
    const [native, queued] = results;
    deepStrictEqual(queued, native);
    ok(JSON.stringify(native).includes("returned"));
  });

  test("the chunk is written as it is: only the empty commit is a string", async () => {
    const write = Object.getOwnPropertyDescriptor(
      ServerResponse.prototype,
      "write",
    );
    const end = Object.getOwnPropertyDescriptor(
      ServerResponse.prototype,
      "end",
    );
    ok(typeof write === "undefined" && typeof end === "undefined");
    const native = OutgoingMessage.prototype as unknown as Record<
      "end" | "write",
      (...args: unknown[]) => unknown
    >;
    const large = Buffer.alloc(1 << 20, 97);
    const parts = [large.subarray(0, 10), large.subarray(10, 20)];
    /** The calls of Node.js (by a response after early hints, or alone) */
    const calls = async (informed: boolean): Promise<[string, unknown[]][]> => {
      const replied = gate();
      const seen: [string, unknown[]][] = [];
      const server = createServer(
        { ServerResponse: BindenResponse },
        (request: IncomingMessage, response: ServerResponse) => {
          if (request.url === "/first") {
            later(replied.promise, response);
            return;
          } else if (informed) {
            response.writeEarlyHints({ link: "</a.css>; rel=preload" });
          }
          // What reaches Node.js
          Object.defineProperties(ServerResponse.prototype, {
            write: {
              configurable: true,
              value(this: ServerResponse, ...args: unknown[]): unknown {
                seen.push(["write", args]);
                return Reflect.apply(native.write, this, args);
              },
            },
            end: {
              configurable: true,
              value(this: ServerResponse, ...args: unknown[]): unknown {
                seen.push(["end", args]);
                return Reflect.apply(native.end, this, args);
              },
            },
          });
          try {
            response.setHeader("Content-Length", large.length);
            response.write(parts[0]);
            response.write(parts[1], "utf8");
            response.end(large.subarray(20), "base64");
          } finally {
            Reflect.deleteProperty(ServerResponse.prototype, "write");
            Reflect.deleteProperty(ServerResponse.prototype, "end");
          }
          replied.open();
        },
      );
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      try {
        const data = await pipelined(
          (server.address() as AddressInfo).port,
          "/second",
        );
        ok(data.endsWith(`\r\n\r\n${large.toString()}`));
        return seen;
      } finally {
        server.closeAllConnections();
        server.close();
      }
    };
    for (const informed of [true, false]) {
      const seen = await calls(informed);
      // The same chunks (not copies), each once
      deepStrictEqual(
        seen.map(([name, args]) => [name, args.length]),
        [
          ...(informed ? [["write", 2]] : []),
          ["write", 1],
          ["write", 2],
          ["end", 2],
        ],
      );
      if (informed) {
        deepStrictEqual(seen[0]?.[1], ["", "latin1"]);
      }
      const chunks = seen.slice(informed ? 1 : 0).map(([, args]) => args[0]);
      ok(chunks[0] === parts[0] && chunks[1] === parts[1]);
      ok(
        chunks[2] instanceof Buffer &&
          chunks[2].buffer === large.buffer &&
          chunks[2].byteOffset === large.byteOffset + 20,
      );
    }
  });
});
