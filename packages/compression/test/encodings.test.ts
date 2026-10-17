import { type BindenResponse, type Context, type IMiddleware } from "binden";
import { Compression, type ICompressionOptions } from "../index.js";
import {
  type IRaw,
  type IServed,
  capture,
  converse,
  fetchRaw,
  framed,
  gzips,
  none,
  pollUntil,
  serve,
  sleep,
  text,
  within,
} from "./helpers.js";
import { afterEach, suite, test } from "node:test";
import { deepStrictEqual } from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import zlib from "node:zlib";

const body = text(4096);
const reply = text(2048);

/** The code and the message of the error that a call throws (`["not thrown"]` without one) */
function thrown(fn: () => unknown): unknown[] {
  try {
    fn();
  } catch (error: unknown) {
    const { code, message } = error as { code?: unknown; message?: unknown };
    return [code, message];
  }
  return ["not thrown"];
}

/**
 * Strings in an encoding whose byte length Node.js only estimates (the name
 * in any case), and the bytes that they are: invalid ones, which Node.js
 * would frame by more bytes than it writes
 */
const estimated: readonly (readonly [string, BufferEncoding, string])[] = [
  ["6869zz", "hex", "hi"],
  ["68692", "HEX" as BufferEncoding, "hi"],
  ["aGk!!!!", "base64", "hi"],
  ["aGk$$$$", "Base64url" as BufferEncoding, "hi"],
];

/** The body of the first response of a connection, as framed, and how many responses there are */
function first(responses: readonly IRaw[]): [string, string, number] {
  const [response] = responses as [IRaw];
  const coding = /\r\ncontent-encoding: (?<coding>\S+)/u.exec(response.head)
    ?.groups?.coding;
  const raw = framed(response);
  return [
    coding ?? "",
    (coding === "gzip" ? zlib.gunzipSync(raw) : raw).toString("latin1"),
    responses.length,
  ];
}

suite("The encoding of a chunk", () => {
  const servers: IServed[] = [];

  /** Serves the middlewares, and returns the URL */
  const start = async (
    options: Parameters<typeof serve>[0],
    ...middlewares: IMiddleware[]
  ): Promise<string> => {
    const served = await serve(options, ...middlewares);
    servers.push(served);
    return served.url;
  };

  /**
   * Sends a request, and a request for `/small` pipelined after it on the
   * same connection: the responses as they are read
   */
  const pipelined = async (
    url: string,
    path: string,
    accept: string,
  ): Promise<IRaw[]> =>
    converse(
      url,
      `GET ${path} HTTP/1.1\r\nHost: localhost\r\nAccept-Encoding: ${accept}\r\n\r\nGET /small HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
    );

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (served) => served.close()));
  });

  test("that binden refuses is its error before any decision, as without a compression", async () => {
    /** The refused calls, by path */
    const calls: Record<string, (response: BindenResponse) => unknown> = {
      "/write": (response) => response.write(body, "bogus" as BufferEncoding),
      "/end": (response) => response.end(body, "bogus" as BufferEncoding),
      // Bytes only
      "/buffer": (response) => response.write(body, "buffer" as BufferEncoding),
      "/number": (response) =>
        response.end(body, 42 as unknown as BufferEncoding),
    };
    const outcomes = new Map<boolean, unknown[]>();
    for (const compressed of [true, false]) {
      const outcome: unknown[] = [];
      const captured = capture();
      // Created before: it checks its options with a compressor
      const compression = new Compression({ format: "gzip" });
      const created = await gzips(async () => {
        const url = await start(
          {
            app: {
              logger: captured.logger,
              access_log: true,
              error_handler: async (
                context: Context,
                error: unknown,
              ): Promise<void> => {
                const { code } = error as { code?: unknown };
                outcome.push(code, context.response.headersSent);
                // Its own decision
                await context.response.status(500).send(reply);
              },
            },
          },
          ...(compressed ? [compression] : []),
          async (context: Context) => {
            const { response } = context;
            response.type("text/plain");
            const call = calls[context.url.pathname];
            if (context.url.searchParams.has("caught")) {
              outcome.push(
                thrown(() => call(response)),
                response.headersSent,
              );
              await response.status(400).send(reply);
            } else {
              call(response);
            }
          },
        );
        for (const path of Object.keys(calls)) {
          for (const query of ["", "?caught"]) {
            const received = await fetchRaw(url, {
              path: `${path}${query}`,
              headers: { "Accept-Encoding": "gzip" },
            });
            outcome.push(
              received.status,
              received.headers["content-encoding"],
              received.body === reply,
            );
          }
        }
        // The access log records what has been sent
        const completed = (): unknown[] =>
          captured.entries
            .filter(({ msg }) => msg === "The request has completed")
            .map(({ status }) => status);
        await pollUntil(() => completed().length >= 8);
        outcome.push(completed());
      });
      // One compressor by reply: none for a refused write
      outcomes.set(compressed, [...outcome, created.length]);
    }

    const error = (
      code: string,
      message: string,
      status: number,
    ): unknown[] => {
      // Thrown to the error handler, or caught
      const reason = status === 500 ? code : [code, message];
      return [reason, false, status, "gzip", true];
    };
    const expected = [
      ...error("ERR_UNKNOWN_ENCODING", "Unknown encoding: bogus", 500),
      ...error("ERR_UNKNOWN_ENCODING", "Unknown encoding: bogus", 400),
      ...error("ERR_UNKNOWN_ENCODING", "Unknown encoding: bogus", 500),
      ...error("ERR_UNKNOWN_ENCODING", "Unknown encoding: bogus", 400),
      ...error("ERR_UNKNOWN_ENCODING", "Unknown encoding: buffer", 500),
      ...error("ERR_UNKNOWN_ENCODING", "Unknown encoding: buffer", 400),
      ...error("ERR_UNKNOWN_ENCODING", "Unknown encoding: 42", 500),
      ...error("ERR_UNKNOWN_ENCODING", "Unknown encoding: 42", 400),
      [500, 400, 500, 400, 500, 400, 500, 400],
    ];
    deepStrictEqual(outcomes.get(true), [...expected, 8]);
    // Without a compression: the same, not compressed
    deepStrictEqual(
      outcomes.get(false),
      [...expected, 0].map((value) => (value === "gzip" ? none : value)),
    );
  });

  test("that binden refuses by a later write is its error: compressed, replaced, without a body", async () => {
    const refused: ((response: BindenResponse) => unknown)[] = [
      (response): unknown => response.write("x", "bogus" as BufferEncoding),
      (response): unknown => response.end("x", "bogus" as BufferEncoding),
      (response): unknown =>
        response.write("x", 42 as unknown as BufferEncoding),
      (response): unknown => response.end("x", "buffer" as BufferEncoding),
      // Whatever the chunk
      (response): unknown =>
        response.write(Buffer.from("x"), "bogus" as BufferEncoding),
    ];
    const outcomes: Record<string, unknown[]> = {};
    for (const compressed of [true, false]) {
      const url = await start(
        {},
        ...(compressed ? [new Compression({ format: "gzip" })] : []),
        (context: Context) => {
          const { response } = context;
          context.done = true;
          // `end()` ends a response to `HEAD` whatever its encoding: the
          // writes after it fail
          response.on("error", () => null);
          response.type("text/plain");
          // A status without a body: its chunks are not checked either
          response.statusCode = Number(context.url.searchParams.get("status"));
          const key = `${context.request.method}${context.url.search} ${String(compressed)} ${String(context.request.headers["accept-encoding"])}`;
          // Before any decision (only `HEAD` does not check it), and after it
          const states = refused.map((call) => thrown(() => call(response)));
          response.write(body);
          // Once the head is committed, its status no longer matters: Node.js
          // has decided whether it writes the body
          const { statusCode } = response;
          response.statusCode = 304;
          states.push(...refused.map((call) => thrown(() => call(response))));
          response.statusCode = statusCode;
          outcomes[key] = states;
          response.end(" end");
        },
      );
      for (const [method, status, accept] of [
        ["GET", 200, "gzip"],
        ["GET", 200, "identity;q=0"],
        ["HEAD", 200, "gzip"],
        ["GET", 204, "gzip"],
        ["GET", 304, "gzip"],
      ] as const) {
        const received = await fetchRaw(url, {
          method,
          path: `/?status=${status}`,
          headers: { "Accept-Encoding": accept },
        });
        const key = `${method}?status=${status} ${String(compressed)} ${accept}`;
        outcomes[key].push(received.status, received.body);
      }
    }

    const error = (encoding: string): unknown[] => [
      "ERR_UNKNOWN_ENCODING",
      `Unknown encoding: ${encoding}`,
    ];
    const errors = [
      error("bogus"),
      error("bogus"),
      error("42"),
      error("buffer"),
      error("bogus"),
    ];
    const ignored = refused.map(() => ["not thrown"]);
    const expected = (compressed: boolean): Record<string, unknown[]> => ({
      // Compressed
      [`GET?status=200 ${String(compressed)} gzip`]: [
        ...errors,
        ...errors,
        200,
        `${body} end`,
      ],
      // Replaced with `406`: as for a response that has not ended
      [`GET?status=200 ${String(compressed)} identity;q=0`]: compressed
        ? [...errors, ...errors, 406, ""]
        : [...errors, ...errors, 200, `${body} end`],
      // Without a body: as without a compression
      [`HEAD?status=200 ${String(compressed)} gzip`]: [
        ...ignored,
        ...ignored,
        200,
        "",
      ],
      [`GET?status=204 ${String(compressed)} gzip`]: [
        ...ignored,
        ...ignored,
        204,
        "",
      ],
      [`GET?status=304 ${String(compressed)} gzip`]: [
        ...ignored,
        ...ignored,
        304,
        "",
      ],
    });
    deepStrictEqual(outcomes, { ...expected(true), ...expected(false) });
  });

  test("`buffer` of bytes is accepted, as without a compression", async () => {
    const bodies: unknown[] = [];
    for (const compression of [
      new Compression({ format: "gzip", threshold: 0 }),
      null,
    ]) {
      const url = await start(
        {},
        ...(compression ? [compression] : []),
        (context: Context) => {
          const { response } = context;
          context.done = true;
          response.type("text/plain");
          const encoding = "buffer" as BufferEncoding;
          if (context.url.pathname === "/end") {
            response.end(Buffer.from("abc"), encoding);
            return;
          }
          // The first decides, the next is compressed
          response.write(Buffer.from("a"), encoding);
          response.write(Buffer.from("b"), encoding);
          response.end(Buffer.from("c"), encoding);
        },
      );
      for (const path of ["/", "/end"]) {
        const received = await fetchRaw(url, {
          path,
          headers: { "Accept-Encoding": "gzip" },
        });
        bodies.push([received.headers["content-encoding"], received.body]);
      }
    }

    deepStrictEqual(bodies, [
      ["gzip", "abc"],
      ["gzip", "abc"],
      [none, "abc"],
      [none, "abc"],
    ]);
  });

  test("whose byte length Node.js estimates is written as its bytes: as it is, and compressed", async () => {
    const url = await start(
      {},
      new Compression({ format: "gzip", threshold: 0 }),
      (context: Context) => {
        const { response } = context;
        context.done = true;
        response.type("text/plain");
        const index = Number(context.url.searchParams.get("index"));
        const [string, encoding] = estimated[index] ?? ["", "hex"];
        if (context.url.pathname === "/small") {
          response.end("small");
        } else if (context.url.pathname === "/write") {
          // Chunked: each chunk is framed by its bytes
          response.write(string, encoding);
          response.end(string, encoding);
        } else {
          response.end(string, encoding);
        }
      },
    );
    for (const [index, [string, encoding, bytes]] of estimated.entries()) {
      for (const [path, accept] of [
        ["/end", "identity"],
        ["/write", "identity"],
        ["/end", "gzip"],
        ["/write", "gzip"],
      ] as const) {
        const responses = await pipelined(
          url,
          `${path}?index=${index}`,
          accept,
        );
        const label = `${path} of ${string} (${encoding}, ${accept})`;
        const expected = path === "/end" ? bytes : `${bytes}${bytes}`;

        deepStrictEqual(
          first(responses),
          [accept === "gzip" ? "gzip" : "", expected, 2],
          label,
        );
        if (path === "/end" && accept === "identity") {
          // The length of the chunk is the one of its bytes
          deepStrictEqual(
            /\r\ncontent-length: (?<length>\d+)/u.exec(responses[0].head)
              ?.groups?.length,
            `${bytes.length}`,
            label,
          );
        }
        // The pipelined request is answered
        deepStrictEqual(framed(responses[1]).toString(), "small");
      }
    }
  });

  test("whose byte length Node.js estimates decides by its bytes: the threshold, an empty body", async () => {
    const decide = async (
      options: ICompressionOptions,
      string: string,
      method = "GET",
    ): Promise<unknown[]> => {
      const url = await start(
        {},
        new Compression(options),
        (context: Context) => {
          context.done = true;
          context.response.type("text/plain").end(string, "hex");
        },
      );
      const received = await fetchRaw(url, {
        method,
        headers: { "Accept-Encoding": "gzip" },
      });
      return [
        received.headers["content-encoding"],
        received.headers["content-length"],
        received.headers.vary,
        received.body,
      ];
    };
    const vary = "Accept-Encoding";

    // An empty body (Node.js would estimate one byte): sent as it is, whatever
    // the request accepts, also to `HEAD` (which Node.js sends without a
    // length, as for any empty `end()`)
    deepStrictEqual(await decide({ threshold: 0 }, "zz"), [
      none,
      "0",
      none,
      "",
    ]);
    deepStrictEqual(await decide({ threshold: 0 }, "zz", "HEAD"), [
      none,
      none,
      none,
      "",
    ]);
    // Below the threshold by its bytes, at it by the estimate (3)
    deepStrictEqual(await decide({ threshold: 3 }, "6869zz"), [
      none,
      "2",
      vary,
      "hi",
    ]);
    // At the threshold by its bytes, above it by the estimate (4)
    deepStrictEqual(await decide({ threshold: 3 }, "686921zz"), [
      "gzip",
      none,
      vary,
      "hi!",
    ]);
    // Valid strings at the boundary
    deepStrictEqual(await decide({ threshold: 3 }, "6869"), [
      none,
      "2",
      vary,
      "hi",
    ]);
    deepStrictEqual(await decide({ threshold: 3 }, "686921"), [
      "gzip",
      none,
      vary,
      "hi!",
    ]);
  });

  test("an empty string is no chunk of `end()`, in any encoding, as without a compression", async () => {
    const outcomes: unknown[][] = [];
    for (const compressed of [true, false]) {
      const outcome: unknown[] = [];
      const { promise: called, resolve } = Promise.withResolvers<unknown>();
      const url = await start(
        {},
        ...(compressed ? [new Compression({ format: "gzip" })] : []),
        (context: Context) => {
          const { response } = context;
          context.done = true;
          response.on("error", (error: Error & { code?: unknown }) => {
            outcome.push(error.code);
          });
          response.type("text/plain").end(body);
          // Ended as it is: a chunk would be written after the end
          response.end("", "hex", (error?: Error & { code?: unknown }) => {
            resolve(error?.code ?? "none");
          });
        },
      );
      const received = await fetchRaw(url);
      outcome.push(await within(called), received.body === body);
      await sleep(20);
      outcomes.push(outcome);
    }

    deepStrictEqual(outcomes[0], outcomes[1]);
    deepStrictEqual(outcomes[0].length, 2);
  });

  test("an explicit `Content-Length` is never replaced by the length of a chunk, after several writes", async () => {
    for (const threshold of [1024, 0]) {
      const url = await start(
        {},
        new Compression({ format: "gzip", threshold }),
        (context: Context) => {
          const { response } = context;
          context.done = true;
          response.type("text/plain");
          if (context.url.pathname === "/small") {
            response.end("small");
            return;
          }
          // Which counts the bytes that each chunk is
          response.strictContentLength = true;
          response.setHeader("Content-Length", 5);
          response.write("ab");
          response.write("6364zz", "hex");
          response.end("65", "hex");
        },
      );
      const responses = await pipelined(url, "/", "gzip");

      deepStrictEqual(
        [
          ...first(responses),
          /\r\ncontent-length: (?<length>\d+)/u.exec(responses[0].head)?.groups
            ?.length,
        ],
        threshold === 0 ? ["gzip", "abcde", 2, none] : ["", "abcde", 2, "5"],
        `threshold ${threshold}`,
      );
    }
  });

  test("the callbacks of a chunk written as its bytes run once, as those of any chunk", async () => {
    for (const accept of ["identity", "gzip"]) {
      const calls: unknown[] = [];
      const record = (name: string) =>
        function callback(this: unknown, ...args: unknown[]): void {
          // Its kind: a write request of the socket on Node.js 24, whose
          // chunk differs
          const receiver =
            typeof this === "object" && this !== null
              ? Object.keys(this)
              : this;
          calls.push([name, receiver, args.length > 0 ? args[0] : "none"]);
        };
      const url = await start(
        {},
        new Compression({ format: "gzip", threshold: 0 }),
        (context: Context) => {
          const { response } = context;
          context.done = true;
          response.type("text/plain");
          response.write("6869", "hex", record("hex"));
          response.write("hi", record("utf8"));
          response.end("21", "HEX" as BufferEncoding, record("end"));
        },
      );
      const received = await fetchRaw(url, {
        headers: { "Accept-Encoding": accept },
      });
      await pollUntil(() => calls.length >= 3);
      await sleep(20);

      deepStrictEqual(received.body, "hihi!", accept);
      // Once each, with the receiver and the error of a chunk in `utf8`
      const [hex, utf8] = calls as [unknown[], unknown[]];
      deepStrictEqual(
        [calls.length, hex.slice(1), (calls[2] as unknown[])[0]],
        [3, utf8.slice(1), "end"],
        accept,
      );
    }
  });

  test("of an odd `hex` length never aborts Node.js, and frames its bytes", () => {
    // In a process of its own: Node.js 24 aborts on it (`StringBytes`)
    const { status, stdout, stderr } = spawnSync(
      process.execPath,
      ["--import", "tsx", join(import.meta.dirname, "fixtures", "odd-hex.ts")],
      { encoding: "utf8", timeout: 30_000 },
    );

    deepStrictEqual(
      { status, stdout, stderr },
      {
        status: 0,
        stdout: [
          "200 slow",
          "200 hi",
          "200 hihi",
          "200 hi",
          "200 gzip hi",
          "200 small",
          "",
        ].join("\n"),
        stderr: "",
      },
    );
  });
});
