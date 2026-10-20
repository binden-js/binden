import { Binden, type Context, releasedFailure } from "../index.js";
import { EventEmitter, once } from "node:events";
import { HOST, type ICaptured, capture, ioTurn, listen } from "./helpers.js";
import { PassThrough, Readable } from "node:stream";
import {
  decidedFor,
  emitterMethods,
  forwarder,
  guard,
  hear,
  reportLate,
} from "../src/stream-like.js";
import { suite, test } from "node:test";
import { connect } from "node:net";
import { createRequire } from "node:module";
import { deepStrictEqual } from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);

/**
 * Runs a fixture (`test/fixtures`) in a process of its own, without a handler
 * of the process: a crash (e.g. an exception thrown out of a turn) is its exit
 * code and output, not a failure of the test runner
 */
function fixture(name: string): Record<string, unknown> {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--import",
      "tsx",
      join(import.meta.dirname, "fixtures", name),
    ],
    { encoding: "utf8", timeout: 40_000 },
  );
  return { status, stdout, stderr };
}

/** The values that a report of a late error has been given */
function reporter(): [unknown[], (error: unknown) => void] {
  const reported: unknown[] = [];
  return [
    reported,
    (error): void => {
      reported.push(error);
    },
  ];
}

/** The message of each late error logged so far */
function lateOf(captured: ICaptured): unknown[] {
  return captured.records
    .filter(({ msg }) => msg === releasedFailure)
    .map(({ failure }) => (failure as { message?: unknown }).message);
}

/** How a send has settled: `resolved`, or the message of what it has rejected with */
function outcomeOf(promise: Promise<void>): Promise<string> {
  return promise.then(
    () => "resolved",
    (error: unknown) => `rejected ${(error as Error).message}`,
  );
}

/** A stream-like source of its own */
class Source extends EventEmitter {
  public pause(): this {
    return this;
  }

  public resume(): this {
    return this;
  }
}

/** A client connection to `HOST` (see `request()`) */
interface IClient {
  /** Goes away */
  destroy(): void;
}

/** Writes a `GET` of the path on a connection of its own, which stays open */
async function request(port: number, path: string): Promise<IClient> {
  const socket = connect(port, HOST);
  socket.resume().on("error", () => {
    // Its close follows
  });
  await once(socket, "connect");
  socket.write(`GET ${path} HTTP/1.1\r\nHost: a\r\n\r\n`);
  return {
    destroy: (): void => {
      socket.destroy();
    },
  };
}

/** Resolves on the turn after `ms` milliseconds */
function later(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

suite("A late error is reported on a later turn", () => {
  test("never while the event that brings it runs, by its guard, the listener that a settled send keeps, or its send", async () => {
    const [reports, report] = reporter();
    const guarded = new EventEmitter();
    guard(guarded, emitterMethods, report);
    guarded.emit("error", new Error("guard"));
    const kept = new EventEmitter();
    const listener = forwarder(() => null);
    kept.on("error", listener.listener);
    listener.detach(kept, report);
    kept.emit("error", new Error("forwarder"));
    reportLate(new EventEmitter(), new Error("reportLate"), report);
    const before = [...reports];
    await ioTurn();
    deepStrictEqual(
      [before, reports.map((error) => (error as Error).message)],
      [[], ["guard", "forwarder", "reportLate"]],
    );
  });

  for (const first of ["the guard", "the deciding send"] as const) {
    test(`by its guard, not once a send that hears it in the same event decides it (${first} listening first); another error, once`, async () => {
      const [reports, report] = reporter();
      const source = new EventEmitter();
      const failure = new Error("Decided by a send");
      // A live send of the source, which fails with its error, and decides
      // it for that source
      const deciding = (error: unknown): void => {
        if (error === failure) {
          decidedFor(source, error);
        }
      };
      if (first === "the guard") {
        guard(source, emitterMethods, report);
        source.on("error", deciding);
      } else {
        source.on("error", deciding);
        guard(source, emitterMethods, report);
      }
      source.emit("error", failure);
      const another = new Error("Not decided");
      source.emit("error", another);
      source.emit("error", another);
      await ioTurn();
      deepStrictEqual(reports, [another]);
    });
  }

  test("by its guard, not once a send decides it on the next tick (e.g. the readable of a stream-like source that reaches its send then)", async () => {
    const [reports, report] = reporter();
    const source = new EventEmitter();
    const failure = new Error("Decided on the next tick");
    guard(source, emitterMethods, report);
    source.emit("error", failure);
    process.nextTick(() => {
      decidedFor(source, failure);
    });
    await ioTurn();
    deepStrictEqual(reports, []);
  });

  for (const first of ["the kept listener", "the live send"] as const) {
    test(`by the listener that a settled send keeps, not while another send hears it and decides it in the same event (${first} listening first)`, async () => {
      const [reports, report] = reporter();
      const source = new EventEmitter();
      const failure = new Error("Decided by the live send");
      const kept = forwarder(() => null);
      const live = (error: unknown): void => {
        decidedFor(source, error);
      };
      if (first === "the kept listener") {
        source.on("error", kept.listener).on("error", live);
      } else {
        source.on("error", live).on("error", kept.listener);
      }
      // The live send hears the source (see `hear()`), whose guard has
      // refused (none listens)
      hear(source, 1);
      kept.detach(source, report);
      source.emit("error", failure);
      await ioTurn();
      // No longer heard: a later error is reported by the kept listener
      hear(source, -1);
      source.off("error", live);
      const another = new Error("Later");
      source.emit("error", another);
      await ioTurn();
      deepStrictEqual(reports, [another]);
    });
  }

  test("by its send (reportLate()), not once a send of the source decides it later in the turn; another error, once", async () => {
    const [reports, report] = reporter();
    const source = new EventEmitter();
    const failure = new Error("Decided later in the turn");
    reportLate(source, failure, report);
    decidedFor(source, failure);
    const another = new Error("Not decided");
    reportLate(source, another, report);
    reportLate(source, another, report);
    await ioTurn();
    deepStrictEqual(reports, [another]);
  });

  test("a report that throws on that turn (e.g. a logger whose own debug() throws) is ignored, whatever reports it: the process does not crash", () => {
    deepStrictEqual(fixture("throwing-late-reports.ts"), {
      status: 0,
      stdout: "200 guard,forwarder,reportLate,framework\n",
      stderr: "",
    });
  });
});

/** A stream of `readable-stream` */
interface IStream extends EventEmitter {
  push(chunk: unknown): boolean;
  destroy(error?: Error): unknown;
}

/** A `Readable` of a version of `readable-stream` */
function readableOf(version: string): IStream {
  const { Readable: Constructor } = require(`readable-stream-v${version}`) as {
    Readable: new (options: { read(): void }) => IStream;
  };
  return new Constructor({
    read(): void {
      // Pushed by the test
    },
  });
}

/** A source of its own whose `push()` emits its `data` */
class Pushing extends Source {
  public push(chunk: string): boolean {
    this.emit("data", Buffer.from(chunk));
    return true;
  }

  public destroy(): this {
    return this;
  }
}

/** A source of its own whose `destroy()` emits its last error again, at once */
class Reemitting extends Pushing {
  public destroyed = false;
  public last: Error | null = null;

  public override destroy(): this {
    this.destroyed = true;
    if (this.last !== null) {
      this.emit("error", this.last);
    }
    return this;
  }
}

suite(
  "A stream-like source that emits the error that decides its send again before the send has recorded it",
  () => {
    const failure = new Error("The source has failed");
    const another = new Error("A later error");
    /** The cases: the source, how it fails twice, and its later error */
    const cases: readonly (readonly [
      string,
      () => IStream,
      (source: IStream) => void,
    ])[] = [
      [
        "an emitter of its own that emits it twice",
        (): IStream => new Pushing(),
        (source): void => {
          source.emit("error", failure);
          source.emit("error", failure);
          source.emit("error", another);
        },
      ],
      [
        "readable-stream 2 destroyed twice with it",
        (): IStream => readableOf("2"),
        (source): void => {
          source.destroy(failure);
          source.destroy(failure);
          setTimeout(() => source.emit("error", another), 10);
        },
      ],
      [
        "readable-stream 3 destroyed twice with it",
        (): IStream => readableOf("3"),
        (source): void => {
          source.destroy(failure);
          source.destroy(failure);
          setTimeout(() => source.emit("error", another), 10);
        },
      ],
      [
        "readable-stream 4 that emits it twice",
        (): IStream => readableOf("4"),
        (source): void => {
          source.emit("error", failure);
          source.emit("error", failure);
          source.emit("error", another);
        },
      ],
      [
        "an emitter whose destroy() emits it again once the send releases it (R22-C1)",
        (): IStream => new Reemitting(),
        (source): void => {
          (source as unknown as Reemitting).last = failure;
          source.emit("error", failure);
          setTimeout(() => source.emit("error", another), 10);
        },
      ],
    ];
    for (const [name, create, fail] of cases) {
      test(`${name}: the send rejects with it, which is not logged; a later error is logged once`, async () => {
        const captured = capture();
        const outcomes: string[] = [];
        const app = new Binden({
          logger: captured.logger,
          log_error_details: true,
        }).use(async (context: Context) => {
          const source = create();
          setTimeout(() => {
            source.push("abc");
            setTimeout(() => {
              fail(source);
            }, 5);
          }, 5);
          // @ts-expect-error -- a stream-like source
          outcomes.push(await outcomeOf(context.send(source)));
        });
        const listening = await listen(app);
        try {
          const client = await request(listening.port, "/");
          for (let wait = 0; wait < 200 && outcomes.length === 0; wait += 1) {
            await later(5);
          }
          await later(20);
          await ioTurn();
          client.destroy();
          deepStrictEqual(
            [outcomes, lateOf(captured)],
            [[`rejected ${failure.message}`], [another.message]],
          );
        } finally {
          await listening.close();
        }
      });
    }
  },
);

suite(
  "A shared source whose late error rejects a live send of another response",
  () => {
    for (const how of ["refuses the guard", "throws on a removal"] as const) {
      for (const order of ["settled first", "live first"] as const) {
        test(`kept by a settled send whose source ${how} (the ${order}): not logged; a later error is logged once (R22-4)`, async () => {
          const captured = capture();
          const failure = new Error("Its destroy has failed later");
          const shared = new Readable({
            read(): void {
              // Pushed by the test
            },
            destroy(_error, callback): void {
              setTimeout(() => {
                callback(failure);
              }, 5);
            },
          });
          shared.push("x");
          let armed = false;
          if (how === "refuses the guard") {
            shared.on("newListener", (event: string) => {
              if (armed && event === "error") {
                armed = false;
                throw new Error("Refused");
              }
            });
          } else {
            const remove = shared.removeListener.bind(shared);
            const removing = (
              event: string,
              listener: (...args: unknown[]) => void,
            ): Readable => {
              if (armed && event === "error") {
                armed = false;
                throw new Error("Removal failed");
              }
              return remove(event, listener);
            };
            Object.assign(shared, { removeListener: removing, off: removing });
          }
          const outcomes = new Map<string, string>();
          const started = new Map<string, () => void>();
          const app = new Binden({
            logger: captured.logger,
            log_error_details: true,
          }).use(async (context: Context) => {
            const who = context.url.pathname;
            const sent = outcomeOf(context.send(shared));
            started.get(who)?.();
            outcomes.set(who, await sent);
            if (!context.response.writableEnded) {
              context.response.end("done");
            }
          });
          const listening = await listen(app);
          try {
            const begin = async (path: string): Promise<IClient> => {
              const { promise, resolve } = Promise.withResolvers<null>();
              started.set(path, () => {
                resolve(null);
              });
              const client = await request(listening.port, path);
              await promise;
              return client;
            };
            // The settled send listens first, or after the live one
            let [settling, live]: (IClient | null)[] = [null, null];
            if (order === "settled first") {
              settling = await begin("/settled");
              live = await begin("/live");
            } else {
              live = await begin("/live");
              settling = await begin("/settled");
            }
            await later(10);
            armed = true;
            // Its client goes away: its send settles, keeps its listener
            // of `error`, and the source is destroyed
            settling.destroy();
            for (let wait = 0; wait < 200 && outcomes.size < 2; wait += 1) {
              await later(5);
            }
            await ioTurn();
            const decided = lateOf(captured);
            shared.emit("error", new Error("Later"));
            await ioTurn();
            live.destroy();
            deepStrictEqual(
              [
                outcomes.get("/live"),
                decided,
                lateOf(captured),
                shared.listenerCount("error") > 0,
              ],
              [`rejected ${failure.message}`, [], ["Later"], true],
            );
          } finally {
            await listening.close();
          }
        });
      }
    }
  },
);

suite(
  "A shared source destroyed with an error, whose send ends its own response while it reads it, as another response sends it",
  () => {
    for (const version of ["Node.js", "readable-stream 4"] as const) {
      test(`(${version}): that error rejects the live send, and is not logged (R22-3)`, async () => {
        const captured = capture();
        const failure = new Error("Shared");
        let ending: (() => void) | null = null;
        const { PassThrough: Constructor } = (
          version === "Node.js"
            ? { PassThrough }
            : require("readable-stream-v4")
        ) as { PassThrough: new () => PassThrough };
        // Its `errored`, once read, ends the response of the second send
        const shared = new Constructor();
        Object.defineProperty(shared, "errored", {
          get(): unknown {
            ending?.();
            ending = null;
            return Reflect.get(
              Object.getPrototypeOf(shared) as object,
              "errored",
              shared,
            );
          },
        });
        const outcomes = new Map<string, string>();
        const contexts = new Map<string, Context>();
        const ready = Promise.withResolvers<null>();
        const live = Promise.withResolvers<null>();
        const app = new Binden({
          logger: captured.logger,
          log_error_details: true,
        }).use(async (context: Context) => {
          const who = context.url.pathname;
          if (who === "/ending") {
            contexts.set(who, context);
            ready.resolve(null);
            await later(100);
            return;
          }
          const sent = outcomeOf(context.send(shared));
          live.resolve(null);
          outcomes.set(who, await sent);
          if (!context.response.writableEnded) {
            context.response.status(500).end("failed");
          }
        });
        const listening = await listen(app);
        try {
          const clients = [
            await request(listening.port, "/live"),
            await request(listening.port, "/ending"),
          ];
          await Promise.all([ready.promise, live.promise]);
          const context = contexts.get("/ending") as Context;
          shared.destroy(failure);
          ending = (): void => {
            context.response.end("ended");
          };
          outcomes.set("/ending", await outcomeOf(context.send(shared)));
          for (let wait = 0; wait < 200 && outcomes.size < 2; wait += 1) {
            await later(5);
          }
          await ioTurn();
          for (const client of clients) {
            client.destroy();
          }
          deepStrictEqual(
            [outcomes.get("/live"), outcomes.get("/ending"), lateOf(captured)],
            [`rejected ${failure.message}`, "resolved", []],
          );
        } finally {
          await listening.close();
        }
      });
    }
  },
);
