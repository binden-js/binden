import { type BindenResponse, type Context } from "binden";
import {
  type IRaw,
  type IServed,
  converse,
  framed,
  gzips,
  none,
  serve,
  text,
  within,
} from "./helpers.js";
import { afterEach, suite, test } from "node:test";
import { Compression } from "../index.js";
import type { Socket } from "node:net";
import { deepStrictEqual } from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import zlib from "node:zlib";

/**
 * A deep copy of the state of a response: its own properties (string and
 * symbol keys, with the contents of the header map and of the listener
 * table, and the other objects by identity), and the values of its accessors
 * (e.g. the storage of `shouldKeepAlive` and of the status)
 */
function snapshot(response: BindenResponse): Map<unknown, unknown> {
  const copy = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(copy);
    } else if (
      typeof value === "object" &&
      value !== null &&
      Object.getPrototypeOf(value) === null
    ) {
      return Reflect.ownKeys(value).map((key) => [
        key,
        copy(Reflect.get(value, key)),
      ]);
    }
    return value;
  };
  const state = new Map<unknown, unknown>();
  for (const key of Reflect.ownKeys(response)) {
    state.set(key, copy(Reflect.get(response, key)));
  }
  for (const name of [
    "chunkedEncoding",
    "headersSent",
    "sendDate",
    "shouldKeepAlive",
    "started",
    "statusCode",
    "statusMessage",
    "writableEnded",
  ]) {
    state.set(`get ${name}`, Reflect.get(response, name));
  }
  state.set("getHeaders()", Object.entries(response.getHeaders()));
  return state;
}

/** The keys whose values differ between two snapshots (see `snapshot()`) */
function changed(
  before: Map<unknown, unknown>,
  after: Map<unknown, unknown>,
): unknown[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys]
    .filter((key) => !isDeepStrictEqual(before.get(key), after.get(key)))
    .map(String);
}

const big = text(4096);
const page = text(4400);

/**
 * Heads that Node.js refuses once the decision is taken, by path: what is
 * set before, then what commits the head
 */
const attempts: Record<
  string,
  readonly [
    setup: (response: BindenResponse) => void,
    commit: (response: BindenResponse) => void,
  ]
> = {
  // As it is (below the `threshold`), of a length: by the `end()` of Node.js
  "/as-is-end": [
    (response): void => {
      response.set({ "Content-Length": 4, Trailer: "X-T" });
    },
    (response): void => {
      response.end("tiny");
    },
  ],
  // As it is, by the first `write()`
  "/as-is-write": [
    (response): void => {
      response.set({ "Content-Length": 4, Trailer: "X-T" });
    },
    (response): void => {
      response.write("tiny");
    },
  ],
  // As it is, with the byte count of `strictContentLength`, which Node.js
  // counts before it commits the head
  "/strict-end": [
    (response): void => {
      response.strictContentLength = true;
      response.set({ "Content-Length": 4, Trailer: "X-T" });
    },
    (response): void => {
      response.end("tiny");
    },
  ],
  "/strict-write": [
    (response): void => {
      response.strictContentLength = true;
      response.set({ "Content-Length": 4, Trailer: "X-T" });
    },
    (response): void => {
      response.write("tiny");
    },
  ],
  // As it is, not chunked for HTTP/1.0
  "/as-is-http10": [
    (response): void => {
      response.setHeader("Trailer", "X-T");
    },
    (response): void => {
      response.end("tiny");
    },
  ],
  // The headers of the connection (and a `Date`), set before: Node.js
  // applies them first
  "/keep-alive": [
    (response): void => {
      response.set({
        Connection: "keep-alive",
        "Keep-Alive": "timeout=5",
        "Content-Length": 4,
        Date: new Date(0).toUTCString(),
        Trailer: "X-T",
      });
    },
    (response): void => {
      response.end("tiny");
    },
  ],
  // A `304` that stands for a compressed `200`: chunks, which Node.js does
  // not send (nor keeps the connection) for it
  "/304": [
    (response): void => {
      response.status(304).set({
        "Transfer-Encoding": "chunked",
        Trailer: "X-T",
      });
    },
    (response): void => {
      response.end();
    },
  ],
  // Chunks of a `204`, set by the application
  "/204": [
    (response): void => {
      response.status(204).setHeader("Trailer", "X-T");
      response.chunkedEncoding = true;
    },
    (response): void => {
      response.end();
    },
  ],
  // Compressed: for HTTP/1.0, delimited by closing the connection. The
  // decision changes headers set before (removed, or a weak `ETag`).
  "/compressed-end": [
    (response): void => {
      response.set({
        "Content-Length": big.length,
        ETag: '"v"',
        "Accept-Ranges": "bytes",
        "Repr-Digest": "sha-256=:AAAA:",
        Vary: "Origin",
        Trailer: "X-T",
        "X-After": "set",
      });
    },
    (response): void => {
      response.end(big);
    },
  ],
  "/compressed-write-head": [
    (response): void => {
      response.setHeader("X-Before", "set");
    },
    (response): void => {
      response.writeHead(200, { Trailer: "X-T" });
    },
  ],
};

/** The scenarios: the path, the version of HTTP, and its `Connection` */
const scenarios = [
  ["/as-is-end", "1.1", ""],
  ["/as-is-end", "1.0", "keep-alive"],
  ["/as-is-write", "1.1", ""],
  ["/as-is-write", "1.0", "keep-alive"],
  ["/strict-end", "1.1", ""],
  ["/strict-write", "1.1", ""],
  ["/as-is-http10", "1.0", "keep-alive"],
  ["/as-is-http10", "1.0", ""],
  ["/keep-alive", "1.1", ""],
  ["/304", "1.1", ""],
  ["/304", "1.0", "keep-alive"],
  ["/204", "1.1", ""],
  ["/keep-alive", "1.0", "keep-alive"],
  ["/compressed-end", "1.0", "keep-alive"],
  ["/compressed-write-head", "1.0", "keep-alive"],
  ["/compressed-write-head", "1.0", ""],
] as const;

/** A response without its `Date` (the only header that may differ) */
function dated({ head, body }: IRaw): [string, Buffer] {
  return [head.replace(/\r\ndate: [^\r]*/u, ""), body];
}

suite("A refused head leaves nothing of the attempt", () => {
  let served: IServed | null = null;

  afterEach(async () => {
    const current = served;
    served = null;
    await current?.close();
  });

  test("the state of the response, its listeners, and the reply that follows", async () => {
    // By scenario: the error, and what the attempt has changed
    const states: Record<string, unknown[]> = {};
    const compression = new Compression({ format: "gzip" });
    await gzips(async (compressors) => {
      served = await serve({}, compression, async (context: Context) => {
        const { response } = context;
        const { pathname, searchParams } = context.url;
        const [setup, commit] = attempts[pathname];
        response.type("text/plain");
        setup(response);
        const scenario = searchParams.get("attempt");
        if (scenario !== null) {
          const before = snapshot(response);
          const listeners = response.listeners("close");
          const count = compressors.length;
          let code: unknown = null;
          try {
            commit(response);
          } catch (error: unknown) {
            ({ code } = error as { code?: unknown });
          }
          states[scenario] = [
            code,
            changed(before, snapshot(response)),
            isDeepStrictEqual(response.listeners("close"), listeners),
            compressors.slice(count).map(({ destroyed }) => destroyed),
          ];
        }
        // The reply that follows, negotiated anew (compressed but for a
        // client of HTTP/1.0, whose connection it would close)
        for (const name of ["Content-Length", "Trailer", "Transfer-Encoding"]) {
          response.removeHeader(name);
        }
        response.chunkedEncoding = false;
        await response
          .status(200)
          .send(context.request.httpVersion === "1.0" ? "ok" : page);
      });
      const { url } = served;
      for (const [path, version, connection] of scenarios) {
        const name = `${path} (HTTP/${version}${connection ? `, ${connection}` : ""})`;
        // A pipelined request when the connection is kept alive (otherwise
        // refused by Node.js, as data after the end of the connection)
        const kept = connection === "keep-alive" || version === "1.1";
        const next = kept
          ? "GET /as-is-end HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
          : "";
        // With the attempt and without it
        const [replies, reference] = await Promise.all(
          [`?attempt=${encodeURIComponent(name)}`, ""].map(async (query) =>
            converse(
              url,
              `GET ${path}${query} HTTP/${version}\r\nHost: localhost\r\nAccept-Encoding: gzip\r\n${connection ? `Connection: ${connection}\r\n` : ""}\r\n${next}`,
            ),
          ),
        );
        deepStrictEqual(replies.map(dated), reference.map(dated), name);
        // The pipelined request is answered
        deepStrictEqual(replies.length, kept ? 2 : 1, name);
        const [first] = replies as [IRaw];
        const coding = /\r\ncontent-encoding: (?<coding>\S+)/u.exec(first.head)
          ?.groups?.coding;
        deepStrictEqual(
          [
            coding,
            (coding === "gzip"
              ? zlib.gunzipSync(framed(first))
              : framed(first)
            ).toString(),
          ],
          version === "1.0" ? [none, "ok"] : ["gzip", page],
          name,
        );
      }
    });

    const refused = (created: boolean): unknown[] => [
      "ERR_HTTP_TRAILER_INVALID",
      [],
      true,
      created ? [true] : [],
    ];
    deepStrictEqual(states, {
      "/as-is-end (HTTP/1.1)": refused(false),
      "/as-is-end (HTTP/1.0, keep-alive)": refused(false),
      "/as-is-write (HTTP/1.1)": refused(false),
      "/as-is-write (HTTP/1.0, keep-alive)": refused(false),
      "/strict-end (HTTP/1.1)": refused(false),
      "/strict-write (HTTP/1.1)": refused(false),
      "/as-is-http10 (HTTP/1.0, keep-alive)": refused(false),
      "/as-is-http10 (HTTP/1.0)": refused(false),
      "/keep-alive (HTTP/1.1)": refused(false),
      "/304 (HTTP/1.1)": refused(false),
      "/304 (HTTP/1.0, keep-alive)": refused(false),
      "/204 (HTTP/1.1)": refused(false),
      "/keep-alive (HTTP/1.0, keep-alive)": refused(false),
      "/compressed-end (HTTP/1.0, keep-alive)": refused(true),
      "/compressed-write-head (HTTP/1.0, keep-alive)": refused(true),
      "/compressed-write-head (HTTP/1.0)": refused(true),
    });
  });

  test("the byte count of `strictContentLength`: the reply that follows is framed by its own length", async () => {
    const codes: unknown[] = [];
    served = await serve(
      {},
      new Compression({ format: "gzip" }),
      (context: Context) => {
        const { response } = context;
        context.done = true;
        response.type("text/plain");
        if (context.url.pathname === "/next") {
          response.end("next");
          return;
        }
        // Sent as it is (below the `threshold`)
        response.strictContentLength = true;
        response.set({ "Content-Length": 4, Trailer: "X-T" });
        try {
          if (context.url.pathname === "/write") {
            response.write("body");
          } else {
            response.end("body");
          }
        } catch (error: unknown) {
          codes.push((error as { code?: unknown }).code);
        }
        // The same body, which Node.js counts once
        response.removeHeader("Trailer");
        response.end("body");
      },
    );
    for (const path of ["/end", "/write"]) {
      const replies = await converse(
        served.url,
        `GET ${path} HTTP/1.1\r\nHost: localhost\r\nAccept-Encoding: gzip\r\n\r\nGET /next HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
      );
      const [reply, next] = replies as [IRaw, IRaw];

      deepStrictEqual(
        [
          replies.length,
          reply.head.split("\r\n")[0],
          `${reply.head}\r\n`.includes("\r\ncontent-length: 4\r\n"),
          framed(reply).toString(),
          framed(next).toString(),
        ],
        [2, "http/1.1 200 ok", true, "body", "next"],
        path,
      );
    }
    deepStrictEqual(codes, [
      "ERR_HTTP_TRAILER_INVALID",
      "ERR_HTTP_TRAILER_INVALID",
    ]);
  });

  test("no observer of the compressor that it destroys remains", async () => {
    const again: number[] = [];
    await gzips(async (compressors) => {
      served = await serve(
        {},
        new Compression({ format: "gzip" }),
        async (context: Context) => {
          const { response } = context;
          response.type("text/plain");
          const count = compressors.length;
          try {
            // Refused for HTTP/1.0 once the compressor is created
            response.writeHead(200, { Trailer: "X-T" });
          } catch {
            // Rolled back
          }
          const created = compressors.slice(count);
          deepStrictEqual(
            created.map(({ destroyed }) => destroyed),
            [true],
          );
          for (const [index, compressor] of created.entries()) {
            const destroy = compressor.destroy.bind(compressor);
            compressor.destroy = (error?: Error): typeof compressor => {
              again.push(index);
              return destroy(error);
            };
          }
          await response.send("ok");
        },
      );
      const [reply] = (await converse(
        served.url,
        "GET / HTTP/1.0\r\nHost: localhost\r\nAccept-Encoding: gzip\r\n\r\n",
      )) as [IRaw];
      deepStrictEqual(
        [reply.head.split("\r\n")[0], framed(reply).toString()],
        ["http/1.1 200 ok", "ok"],
      );
    });
    // The real close of the response does not destroy it again
    deepStrictEqual(again, []);
  });

  test("the error reply negotiates its own representation (the reproduction of the review)", async () => {
    const seen: unknown[] = [];
    served = await serve(
      {
        app: {
          error_handler: async (
            context: Context,
            error: unknown,
          ): Promise<void> => {
            const { response } = context;
            seen.push((error as { code?: unknown }).code, {
              ...response.getHeaders(),
            });
            response.removeHeader("Trailer");
            await response.status(500).text(page);
          },
        },
      },
      new Compression(),
      async (context: Context) => {
        const { response } = context;
        switch (context.url.pathname) {
          case "/small":
            // Below the `threshold`: sent as it is, by its `end()`
            response.setHeader("Trailer", "X-T");
            await context.text("tiny");
            break;
          case "/write":
            response.set({
              "Content-Type": "text/plain; charset=utf-8",
              "Content-Length": 4,
              Trailer: "X-T",
            });
            response.write("tiny");
            break;
          default:
            await context.text("next");
        }
      },
    );
    for (const path of ["/small", "/write"]) {
      seen.length = 0;
      const replies = await converse(
        served.url,
        `GET ${path} HTTP/1.1\r\nHost: localhost\r\nAccept-Encoding: gzip\r\n\r\nGET /next HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
      );
      const [error, next] = replies as [IRaw, IRaw];
      deepStrictEqual(
        [
          replies.length,
          error.head.split("\r\n")[0],
          error.head.includes("\r\nvary: accept-encoding\r\n"),
          error.head.includes("\r\ncontent-encoding: gzip\r\n"),
          zlib.gunzipSync(framed(error)).toString() === page,
          framed(next).toString(),
          seen,
        ],
        [
          2,
          "http/1.1 500 internal server error",
          true,
          true,
          true,
          "next",
          [
            "ERR_HTTP_TRAILER_INVALID",
            // A refused send of a value leaves the response as it was
            // before it (H30-2), a refused write as it was before the write
            path === "/small"
              ? { trailer: "X-T" }
              : {
                  trailer: "X-T",
                  "content-type": "text/plain; charset=utf-8",
                  "content-length": 4,
                },
          ],
        ],
        path,
      );
    }
  });

  test("a decision whose head is sent stands, when Node.js throws afterwards", async () => {
    const { promise: thrown, resolve } = Promise.withResolvers<unknown[]>();
    served = await serve(
      {},
      new Compression({ format: "gzip" }),
      (context: Context) => {
        const { response } = context;
        context.done = true;
        response.type("text/plain");
        // Node.js corks the socket once it has committed the head of a write
        // (binden checks the chunk and its encoding before, so that no
        // argument makes Node.js throw after the head any more)
        (response.socket as Socket).cork = (): void => {
          throw Object.assign(new Error("After the head"), {
            code: "E_AFTER_HEAD",
          });
        };
        try {
          // As it is (without `Accept-Encoding`)
          response.write("x");
        } catch (error: unknown) {
          resolve([
            (error as { code?: unknown }).code,
            response.headersSent,
            response.getHeader("Vary"),
          ]);
        }
        response.destroy();
      },
    );
    await converse(
      served.url,
      "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    );

    deepStrictEqual(await within(thrown), [
      "E_AFTER_HEAD",
      true,
      "Accept-Encoding",
    ]);
  });
});
