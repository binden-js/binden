import { type BindenResponse, type Context, type IMiddleware } from "binden";
import {
  type IServeOptions,
  type IServed,
  fetchRaw,
  gzips,
  none,
  serve,
  text,
  within,
} from "./helpers.js";
import { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, suite, test } from "node:test";
import { Compression } from "../index.js";
import { Socket } from "node:net";
import { deepStrictEqual } from "node:assert/strict";
import { once } from "node:events";

const gzip = { "Accept-Encoding": "gzip" };
const body = text(4096);

/** The code and the message of the error that a native response throws, and its state then */
function refusal(
  response: BindenResponse | ServerResponse,
  fn: () => unknown,
): unknown[] {
  try {
    fn();
  } catch (error: unknown) {
    const { code, message } = error as { code?: unknown; message?: unknown };
    return [
      code,
      message,
      response.headersSent,
      response.writableEnded,
      response.getHeader("Vary") ?? null,
    ];
  }
  return ["not thrown"];
}

/** The refusal of a native response of Node.js (see `refusal()`) */
function native(fn: (response: ServerResponse) => unknown): unknown[] {
  const socket = new Socket();
  const response = new ServerResponse(new IncomingMessage(socket));
  try {
    return refusal(response, () => fn(response));
  } finally {
    socket.destroy();
  }
}

/** The chunks that `write()` of Node.js refuses before it changes anything */
const refused: [string, unknown][] = [
  ["an object", {}],
  ["null", null],
  ["a number", 42],
  ["a Uint16Array", new Uint16Array(4)],
];

suite("A chunk that Node.js refuses", () => {
  const servers: IServed[] = [];

  /** Serves the middlewares, and returns the URL */
  const start = async (
    options: IServeOptions,
    ...middlewares: IMiddleware[]
  ): Promise<string> => {
    const served = await serve(options, ...middlewares);
    servers.push(served);
    return served.url;
  };

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (served) => served.close()));
  });

  test("by the first `write()` is its error, before any decision", async () => {
    for (const [name, chunk] of refused) {
      const expected = native((response) => response.write(chunk));
      for (const caught of [false, true]) {
        const states: unknown[] = [];
        // Created before: it checks its options with a compressor
        const compression = new Compression({ format: "gzip" });
        const created = await gzips(async () => {
          const url = await start(
            {
              app: {
                error_handler: async (context: Context, error: unknown) => {
                  const { code, message } = error as Record<string, unknown>;
                  states.push(code, message, context.response.headersSent);
                  // Its own decision
                  await context.response.status(500).send(text(2048));
                },
              },
            },
            compression,
            (context: Context) => {
              const { response } = context;
              response.type("text/plain");
              if (!caught) {
                response.write(chunk);
              }
              states.push(refusal(response, () => response.write(chunk)));
              response.end(body);
              context.done = true;
            },
          );
          const received = await fetchRaw(url, { headers: gzip });
          states.push(
            received.status,
            received.headers["content-encoding"],
            received.body,
          );
        });
        const label = `${name}${caught ? ", caught" : ""}`;
        deepStrictEqual(
          [...states, created.length],
          caught
            ? [expected, 200, "gzip", body, 1]
            : [expected[0], expected[1], false, 500, "gzip", text(2048), 1],
          label,
        );
      }
    }
  });

  test("by any later `write()` is its error, as for an uncompressed response", async () => {
    const states: unknown[] = [];
    const url = await start(
      {},
      new Compression({ format: "gzip" }),
      (context: Context) => {
        const { response } = context;
        context.done = true;
        response.type("text/plain");
        const ended = context.url.pathname === "/406";
        if (ended) {
          // Replaced (with `406`), and ended
          response.end(body);
        } else {
          response.write(body);
        }
        for (const [, chunk] of refused) {
          states.push(refusal(response, () => response.write(chunk)));
        }
        if (!ended) {
          response.end(" end");
        }
      },
    );
    const compressed = await fetchRaw(url, { headers: gzip });
    const replaced = await fetchRaw(url, {
      path: "/406",
      headers: { "Accept-Encoding": "identity;q=0, gzip;q=0" },
    });

    deepStrictEqual(
      [compressed.status, compressed.body, replaced.status, replaced.body],
      [200, `${body} end`, 406, ""],
    );
    const errors = refused.map(([, chunk]) =>
      native((response) => response.write(chunk)).slice(0, 2),
    );
    deepStrictEqual(
      states.map((state) => (state as unknown[]).slice(0, 2)),
      [...errors, ...errors],
    );
  });

  test("once the compression has ended the response is its error, as for a response that has not ended", async () => {
    const calls: [
      string,
      (response: BindenResponse | ServerResponse) => unknown,
    ][] = [
      ["end(42)", (response): unknown => response.end(42)],
      ["end({})", (response): unknown => response.end({})],
      ["write({})", (response): unknown => response.write({})],
    ];
    // How the compression ends it: replaced with `406` (by a write, or by
    // `writeHead()`), or compressed, and ended by the end of its compressor
    // (also once the response has finished)
    const starts: [string, string, (response: BindenResponse) => unknown][] = [
      [
        "406 by write()",
        "identity;q=0",
        (response): unknown => response.write(body),
      ],
      [
        "406 by writeHead()",
        "identity;q=0",
        (response): unknown => response.writeHead(200),
      ],
      ["compressed", "gzip", (response): unknown => response.end(body)],
      [
        "compressed, finished",
        "gzip",
        async (response): Promise<void> => {
          response.end(body);
          await once(response, "finish");
        },
      ],
    ];
    for (const [started, accept, begin] of starts) {
      for (const [name, call] of calls) {
        const { promise: called, resolve } = Promise.withResolvers<unknown>();
        const states: unknown[] = [];
        const url = await start(
          {},
          new Compression({ format: "gzip" }),
          async (context: Context) => {
            const { response } = context;
            context.done = true;
            response.type("text/plain");
            await begin(response);
            states.push(refusal(response, () => call(response)).slice(0, 2));
            // A chunk that Node.js accepts is discarded: only its callback runs
            response.end("late", () => {
              resolve("called");
            });
          },
        );
        const received = await fetchRaw(url, {
          headers: { "Accept-Encoding": accept },
        });
        const label = `${name} (${started})`;

        deepStrictEqual(
          [...states, await within(called)],
          [native((response) => call(response)).slice(0, 2), "called"],
          label,
        );
        deepStrictEqual(
          [received.status, received.body],
          accept === "gzip" ? [200, body] : [406, ""],
          label,
        );
      }
    }
  });

  test("by `end()` is its error, before any decision; a falsy chunk is none", async () => {
    const chunks: [string, unknown][] = [
      ["an object", {}],
      ["an ArrayBuffer", new ArrayBuffer(8)],
      ["a Uint16Array", new Uint16Array(4)],
    ];
    for (const [name, chunk] of chunks) {
      const expected = native((response) => response.end(chunk));
      const states: unknown[] = [];
      const url = await start(
        {},
        new Compression({ format: "gzip" }),
        (context: Context) => {
          const { response } = context;
          context.done = true;
          response.type("text/plain");
          states.push(refusal(response, () => response.end(chunk)));
          response.end(body);
        },
      );
      const received = await fetchRaw(url, { headers: gzip });

      deepStrictEqual(
        [...states, received.headers["content-encoding"], received.body],
        [expected, "gzip", body],
        name,
      );
    }

    // Alone, and after a compressed write
    for (const [chunk, written] of [0, false, ""].flatMap(
      (value): [unknown, string][] => [
        [value, ""],
        [value, body],
      ],
    )) {
      const { promise: ended, resolve } = Promise.withResolvers<unknown>();
      const url = await start(
        {},
        new Compression({ format: "gzip" }),
        (context: Context) => {
          const { response } = context;
          context.done = true;
          response.type("text/plain");
          if (written !== "") {
            response.write(written);
          }
          Reflect.apply(response.end.bind(response), response, [
            chunk,
            (): void => {
              resolve("called");
            },
          ]);
        },
      );
      const received = await fetchRaw(url, { headers: gzip });

      deepStrictEqual(
        [
          received.status,
          received.headers["content-length"],
          received.headers["content-encoding"],
          received.body,
          await within(ended),
        ],
        written === ""
          ? [200, "0", none, "", "called"]
          : [200, none, "gzip", body, "called"],
        `${String(chunk)} after ${written.length} bytes`,
      );
    }
  });
});
