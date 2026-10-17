import {
  Binden,
  type BindenAbortError,
  type Context,
  releasedFailure,
} from "../index.js";
import { HOST, capture, ioTurn, listen, pollUntil, within } from "./helpers.js";
import {
  type IStreamLikeMethods,
  decided,
  readStreamLike,
  streamLikeOf,
} from "../src/stream-like.js";
import { suite, test } from "node:test";
import { EventEmitter } from "node:events";
import { connect } from "node:net";
import { createRequire } from "node:module";
import { deepStrictEqual } from "node:assert/strict";

const require = createRequire(import.meta.url);

/** `undefined`, which the linter does not let the tests write */
const none = ({} as { value?: undefined }).value;

/** A stream of `readable-stream`, or a source of its own */
interface ISource extends EventEmitter {
  pause(): this;
  resume(): this;
  destroy(error?: Error): unknown;
  push?(chunk: unknown): boolean;
}

/** A `Readable` of `readable-stream` */
type IReadable = new (options: { read(): void }) => ISource;

/** A readable of a version of `readable-stream` */
function readableOf(version: string): ISource {
  const { Readable } = require(`readable-stream-v${version}`) as {
    Readable: IReadable;
  };
  return new Readable({
    read(): void {
      // Nothing to read
    },
  });
}

/** A source of its own whose destroy emits its error, then its `close`, on the next turn */
class Emitter extends EventEmitter {
  public pause(): this {
    return this;
  }

  public resume(): this {
    return this;
  }

  public destroy(error?: Error): this {
    setImmediate(() => {
      if (error) {
        this.emit("error", error);
      }
      this.emit("close");
    });
    return this;
  }
}

/** The sources of the stream-like cases: of `readable-stream` 2, 3 and 4, and of their own */
const libraries: readonly (readonly [string, () => ISource])[] = [
  ...["2", "3", "4"].map(
    (version) =>
      [
        `readable-stream ${version}`,
        (): ISource => readableOf(version),
      ] as const,
  ),
  ["an emitter", (): ISource => new Emitter()],
];

/** The messages of the late errors that a logger has logged */
function lateOf(captured: ReturnType<typeof capture>): unknown[] {
  return captured.records
    .filter(({ msg }) => msg === releasedFailure)
    .map(({ failure }) => {
      const { code, message } = failure as {
        code?: unknown;
        message?: unknown;
      };
      return code ?? message;
    });
}

/** The status of the first reply, and whether the connection has closed, of `GET /` (once more, `GET /next`) */
async function exchange(
  port: number,
  { gone = false, next = false } = {},
): Promise<string[]> {
  const socket = connect(port, HOST);
  let received = "";
  socket.setEncoding("latin1").on("data", (chunk: string) => {
    received += chunk;
    if (gone) {
      socket.destroy();
    }
  });
  socket.on("error", () => null);
  socket.write(
    next
      ? "GET / HTTP/1.1\r\nHost: a\r\n\r\nGET /next HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n"
      : "GET / HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n",
  );
  const closed = new Promise((resolve) => {
    socket.once("close", resolve);
  });
  try {
    await within(closed);
  } finally {
    socket.destroy();
  }
  return received.match(/HTTP\/1\.1 \d{3}/gu) ?? [];
}

/** Runs an application of a middleware (and `/next`) while the client is done */
async function withApp(
  timeout: number,
  middleware: (context: Context) => Promise<void>,
  client: (port: number, captured: ReturnType<typeof capture>) => Promise<void>,
): Promise<void> {
  const captured = capture();
  const app = new Binden({
    logger: captured.logger,
    log_error_details: true,
    timeout,
  })
    .use("/next", (context: Context) => context.send("next"))
    .use(middleware);
  const listening = await listen(app);
  try {
    await client(listening.port, captured);
  } finally {
    await listening.close();
  }
}

/** The methods of a stream-like source (see `streamLikeOf()`) */
function methodsOf(source: object): IStreamLikeMethods {
  return streamLikeOf(source) as IStreamLikeMethods;
}

suite(
  "A stream-like source destroyed with an error before the send (its `errored`)",
  () => {
    test("rejects with that error, which is not logged, and is not destroyed again", async () => {
      const source = readableOf("4");
      const destroys: unknown[] = [];
      const destroy = source.destroy.bind(source);
      const rejected: unknown[] = [];
      await withApp(
        0,
        async (context: Context) => {
          destroy(new Error("Failed before the send"));
          Object.assign(source, {
            destroy(error?: Error): void {
              destroys.push(error);
              destroy(error);
            },
          });
          await context.send(source).catch((error: unknown) => {
            rejected.push((error as Error).message);
            throw error;
          });
        },
        async (port, captured) => {
          deepStrictEqual(await exchange(port), ["HTTP/1.1 500"]);
          await pollUntil(() => source.listenerCount("error") === 0);
          await ioTurn();
          deepStrictEqual(
            [rejected, destroys, lateOf(captured)],
            [["Failed before the send"], [], []],
          );
        },
      );
    });

    test("once the response has ended (by a getter of its `errored`): resolves, and that error is logged once, also once the source emits it", async () => {
      const failure = new Error("Failed before the send");
      const source = Object.assign(new Emitter(), { destroyed: true });
      const outcomes: string[] = [];
      await withApp(
        0,
        async (context: Context) => {
          Object.defineProperty(source, "errored", {
            get(): Error {
              context.response.end("ended");
              return failure;
            },
          });
          outcomes.push(
            await context.send(source).then(
              () => "resolved",
              (error: unknown) => (error as Error).message,
            ),
          );
        },
        async (port, captured) => {
          deepStrictEqual(await exchange(port, { next: true }), [
            "HTTP/1.1 200",
            "HTTP/1.1 200",
          ]);
          await pollUntil(() => outcomes.length === 1);
          // Its guard (it never closes)
          source.emit("error", failure);
          await ioTurn();
          deepStrictEqual(
            [outcomes, lateOf(captured)],
            [["resolved"], ["Failed before the send"]],
          );
        },
      );
    });
  },
);

suite("A stream-like source cancelled by the send", () => {
  for (const [library, create] of libraries) {
    for (const gone of [false, true]) {
      test(`(${library}) ${gone ? "once the client has gone away" : "at the deadline"}: destroyed with the reason, which its guard does not log once it emits it`, async () => {
        const source = create();
        const emitted: unknown[] = [];
        // The application listens: its guard does not report less
        source.on("error", (error: unknown) => emitted.push(error));
        const rejected: unknown[] = [];
        await withApp(
          gone ? 0 : 50,
          async (context: Context) => {
            if (gone) {
              setImmediate(() => {
                if (typeof source.push === "function") {
                  source.push("first");
                } else {
                  source.emit("data", "first");
                }
              });
            }
            await context.send(source).catch((error: unknown) => {
              rejected.push(error);
              throw error;
            });
          },
          async (port, captured) => {
            deepStrictEqual(await exchange(port, { gone }), [
              gone ? "HTTP/1.1 200" : "HTTP/1.1 503",
            ]);
            await pollUntil(() => emitted.length > 0);
            await ioTurn();
            const [reason] = emitted;
            deepStrictEqual(
              [
                gone
                  ? (reason as BindenAbortError).reason
                  : reason === rejected[0],
                lateOf(captured),
              ],
              [gone ? "client_closed" : true, []],
            );
          },
        );
      });
    }
  }
});

suite(
  "A stream-like source that cannot be read once the response has ended (by code of the source)",
  () => {
    for (const how of ["errored", "on"] as const) {
      for (const [library, create] of [
        ["an emitter", (): ISource => new Emitter()],
        [
          "readable-stream 4",
          (): ISource => {
            const { Readable } = require("readable-stream-v4") as {
              Readable: new (options: {
                read(): void;
                autoDestroy: boolean;
              }) => ISource;
            };
            return new Readable({
              autoDestroy: false,
              read(): void {
                // Nothing to read
              },
            });
          },
        ],
      ] as const) {
        test(`(${library}, ${how === "errored" ? "a getter of its `errored`" : "its own on() that then throws"}): resolves, and its error is logged once`, async () => {
          const failure = new Error("Source failed");
          const outcomes: string[] = [];
          await withApp(
            0,
            async (context: Context) => {
              const source = create();
              // The application listens
              source.on("error", () => null);
              if (how === "errored") {
                Object.defineProperty(source, "errored", {
                  get(): Error {
                    context.response.end("ended");
                    return failure;
                  },
                });
              } else {
                const on = source.on.bind(source);
                let added = 0;
                Object.assign(source, {
                  on(event: string, listener: () => void): ISource {
                    added += 1;
                    if (added === 1) {
                      context.response.end("ended");
                      throw failure;
                    }
                    return on(event, listener);
                  },
                });
              }
              outcomes.push(
                await context.send(source).then(
                  () => "resolved",
                  (error: unknown) => (error as Error).message,
                ),
              );
            },
            async (port, captured) => {
              deepStrictEqual(await exchange(port, { next: true }), [
                "HTTP/1.1 200",
                "HTTP/1.1 200",
              ]);
              await pollUntil(() => outcomes.length === 1);
              await ioTurn();
              deepStrictEqual(
                [outcomes, lateOf(captured)],
                [["resolved"], ["Source failed"]],
              );
            },
          );
        });
      }
    }
  },
);

suite(
  "A stream-like source whose destroy emits an error at once, while its send decides it",
  () => {
    /**
     * A source whose `on()` throws `thrown` for `end` (once it has run
     * `before()`), and whose destroy emits `emitted` at once
     */
    function deciding(
      thrown: Error,
      emitted: readonly Error[],
      before = (): null => null,
    ): Emitter {
      const source: Emitter = Object.assign(new Emitter(), {
        on(event: string, listener: () => void): Emitter {
          if (event === "end") {
            before();
            throw thrown;
          }
          EventEmitter.prototype.on.call(source, event, listener);
          return source;
        },
        destroy(): void {
          for (const error of emitted) {
            source.emit("error", error);
          }
        },
      });
      return source;
    }

    test("that error is never reported (the send rejects with it), but another one is", async () => {
      const reported: unknown[] = [];
      const thrown = new Error("Thrown");
      const source = deciding(thrown, [thrown, new Error("Another")]);
      const readable = readStreamLike(
        source,
        methodsOf(source),
        () => new Error("Cancelled"),
        (error) => reported.push((error as Error).message),
      );
      const failure = await within(
        new Promise((resolve) => {
          readable.once("error", resolve);
        }),
      );
      deepStrictEqual([failure === thrown, reported], [true, ["Another"]]);
    });

    test("sent: the send rejects with it, which is not logged; once the response has ended (by its on()), the send resolves, and it is logged once", async () => {
      const outcomes: string[] = [];
      await withApp(
        0,
        async (context: Context) => {
          const thrown = new Error("Thrown");
          const ends = context.url.pathname === "/ended";
          const source = deciding(thrown, [thrown], () => {
            if (ends) {
              context.response.end("ended");
            }
            return null;
          });
          outcomes.push(
            await context.send(source).then(
              () => "resolved",
              (error: unknown) => (error as Error).message,
            ),
          );
        },
        async (port, captured) => {
          const statuses = [];
          for (const path of ["/", "/ended"]) {
            const socket = connect(port, HOST);
            let received = "";
            socket.setEncoding("latin1").on("data", (chunk: string) => {
              received += chunk;
            });
            socket.write(
              `GET ${path} HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n`,
            );
            await within(
              new Promise((resolve) => {
                socket.once("close", resolve);
              }),
            );
            statuses.push(/^HTTP\/1\.1 \d{3}/u.exec(received)?.[0]);
          }
          await pollUntil(() => outcomes.length === 2);
          await ioTurn();
          // The rejection caught: nothing replied (404)
          deepStrictEqual(
            [statuses, outcomes, lateOf(captured)],
            [
              ["HTTP/1.1 404", "HTTP/1.1 200"],
              ["Thrown", "resolved"],
              ["Thrown"],
            ],
          );
        },
      );
    });
  },
);

suite(
  "Code of a stream-like source that throws while send() adds its listeners",
  () => {
    test("the same error for the listener of `close` of its guard: the readable fails with it, which neither its refusal nor its destroy logs", async () => {
      const reported: unknown[] = [];
      const thrown = new Error("No listener of close");
      const source = new Emitter();
      source.on("newListener", (event: string) => {
        if (event === "close") {
          throw thrown;
        }
      });
      const readable = readStreamLike(
        source,
        methodsOf(source),
        () => new Error("Cancelled"),
        (error) => reported.push(error),
        () => null,
        {
          released: (error) => reported.push(error),
          removed: (error) => reported.push(error),
        },
      );
      // As the send does once it rejects (see `BindenResponse.#unreadable()`)
      decided(readable.errored);
      const failure = await within(
        new Promise((resolve) => {
          readable.once("error", resolve);
        }),
      );
      // Its destroy emits it on the next turn
      await ioTurn();
      deepStrictEqual([failure === thrown, reported], [true, []]);
    });

    for (const version of ["2", "3", "4"]) {
      for (const [name, value] of [
        ["null", null],
        ["0", 0],
      ] as const) {
        test(`(readable-stream ${version}) a falsy value (${name}): destroyed with a premature close, which is not logged once it emits it`, async () => {
          const reported: unknown[] = [];
          const emitted: unknown[] = [];
          const source = readableOf(version);
          source.on("error", (error: unknown) => emitted.push(error));
          source.on("newListener", (event: string) => {
            if (event === "data") {
              // eslint-disable-next-line @typescript-eslint/only-throw-error -- code of a source may throw anything
              throw value;
            }
          });
          const readable = readStreamLike(
            source,
            methodsOf(source),
            () =>
              Object.assign(new Error("Premature close"), {
                code: "ERR_STREAM_PREMATURE_CLOSE",
              }),
            (error) => reported.push(error),
          );
          // Destroyed without an error: no `error` event
          await within(
            new Promise((resolve) => {
              readable.once("close", resolve);
            }),
          );
          await pollUntil(() => emitted.length > 0);
          await ioTurn();
          deepStrictEqual(
            [(emitted[0] as { code?: unknown }).code, reported],
            ["ERR_STREAM_PREMATURE_CLOSE", []],
          );
        });
      }
    }
  },
);

suite(
  "The decision of a send of a stream-like source that cannot be read",
  () => {
    test("of a value that Node.js cannot take as an error, wrapped (its cause): the Error that its destroy emits at once is not reported", async () => {
      const reported: unknown[] = [];
      const thrown = new Error("Unstackable");
      Object.defineProperty(thrown, "stack", {
        get(): never {
          throw new Error("Its stack cannot be read");
        },
      });
      const source: EventEmitter = Object.assign(new Emitter(), {
        on(event: string, listener: () => void): EventEmitter {
          if (event === "end") {
            throw thrown;
          }
          EventEmitter.prototype.on.call(source, event, listener);
          return source;
        },
        destroy(error: Error): void {
          source.emit("error", error);
        },
      });
      const readable = readStreamLike(
        source,
        methodsOf(source),
        () => new Error("Cancelled"),
        (error) => reported.push(error),
      );
      // As the send does once it rejects (see `BindenResponse.#unreadable()`)
      decided(readable.errored);
      const failure = await within(
        new Promise<Error>((resolve) => {
          readable.once("error", resolve);
        }),
      );
      deepStrictEqual([failure.cause === thrown, reported], [true, []]);
    });

    test("is not taken for an `undefined` that a source emits later as its error: its guard reports it", () => {
      const reported: unknown[] = [];
      const source = Object.assign(new Emitter(), { readableEnded: true });
      readStreamLike(
        source,
        methodsOf(source),
        () => new Error("Cancelled"),
        (error) => reported.push(error),
      );
      source.emit("error", none);
      deepStrictEqual(reported, [none]);
    });
  },
);
