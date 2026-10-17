import { Binden, type Context, releasedFailure } from "../index.js";
import {
  type IStreamLikeMethods,
  decide,
  decidedFor,
  emitterMethods,
  guard,
  readStreamLike,
  resolved,
  streamLikeOf,
} from "../src/stream-like.js";
import { capture, ioTurn, listen, send } from "./helpers.js";
import { deepStrictEqual, throws } from "node:assert/strict";
import { suite, test } from "node:test";
import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";

/** A stream-like source of its own, which records the arguments of each destroy */
class Source extends EventEmitter {
  public readonly destroys: unknown[][] = [];

  public pause(): this {
    return this;
  }

  public resume(): this {
    return this;
  }

  public destroy(...args: unknown[]): this {
    this.destroys.push(args);
    return this;
  }
}

/** The methods of a stream-like source (see `streamLikeOf()`) */
function methodsOf(source: object): IStreamLikeMethods {
  return streamLikeOf(source) as IStreamLikeMethods;
}

/** The values that a report (of a late error, or of a refusal) has been given */
function reporter(): [unknown[], (error: unknown) => void] {
  const reported: unknown[] = [];
  return [
    reported,
    (error): void => {
      reported.push(error);
    },
  ];
}

/** The reason of a cancellation, which no test expects */
function cancelled(): Error {
  return new Error("Cancelled");
}

/** An emitter whose listener of `newListener` throws `value` once a listener of `event` is added */
function refusing(event: string, value: unknown): EventEmitter {
  const source = new EventEmitter();
  source.on("newListener", (added: string) => {
    if (added === event) {
      throw value;
    }
  });
  return source;
}

suite("decide()", () => {
  test("returns what its call returns, and its decision ends once the call has returned or thrown", () => {
    const failure = new Error("Decided");
    const [reports, report] = reporter();
    const source = new EventEmitter();
    guard(source, emitterMethods, report);
    const returned = decide(source, failure, () => {
      source.emit("error", failure);
      return "returned";
    });
    throws(
      () =>
        decide(source, failure, () => {
          source.emit("error", failure);
          throw new Error("Thrown");
        }),
      { message: "Thrown" },
    );
    deepStrictEqual([returned, reports], ["returned", []]);
    // No longer decided: reported, once
    source.emit("error", failure);
    source.emit("error", failure);
    deepStrictEqual(reports, [failure]);
  });

  test("of an error of one source: another source that emits it meanwhile reports it", () => {
    const failure = new Error("Decided for one source");
    const [reports, report] = reporter();
    const [first, second] = [new EventEmitter(), new EventEmitter()];
    guard(first, emitterMethods, report);
    guard(second, emitterMethods, report);
    decide(first, failure, () => {
      first.emit("error", failure);
      second.emit("error", failure);
    });
    deepStrictEqual(reports, [failure]);
  });

  test("never of a primitive (only an object can be decided): it is reported, and a refusal with it is logged", () => {
    const [reports, report] = reporter();
    const [refusals, refused] = reporter();
    const source = new EventEmitter();
    guard(source, emitterMethods, report);
    const refuses = refusing("error", "thrown");
    decide(source, "emitted", () => {
      source.emit("error", "emitted");
    });
    decide(refuses, "thrown", () =>
      guard(refuses, emitterMethods, report, false, refused),
    );
    deepStrictEqual([reports, refusals], [["emitted"], ["thrown"]]);
  });

  test("nests with the same error of the same source: an inner decision that ends first leaves the outer one pending (R2-1)", () => {
    const failure = new Error("Decided twice");
    const [reports, report] = reporter();
    const source = new EventEmitter();
    guard(source, emitterMethods, report);
    decide(source, failure, () => {
      decide(source, failure, () => {
        source.emit("error", failure);
      });
      // Still decided by the outer one
      source.emit("error", failure);
    });
    deepStrictEqual(reports, []);
    source.emit("error", failure);
    deepStrictEqual(reports, [failure]);
  });

  test("nests: a send of the same source with the same error that its destroy starts, whose decision ends first, leaves the outer one pending (R2-1)", () => {
    const failure = new Error("Failed before the send");
    const [reports, report] = reporter();
    // Failed without being destroyed (its `errored`): its send destroys it
    // with that error, and decides it
    const source = Object.assign(new Source(), { errored: failure });
    const inner: Readable[] = [];
    Object.assign(source, {
      destroy(error?: Error): Source {
        Object.assign(source, { destroyed: true });
        // Another send of it, destroyed with the same error, which decides
        // it as well, and returns before the outer one
        const read = readStreamLike(
          source,
          methodsOf(source),
          cancelled,
          report,
        );
        inner.push(read.on("error", () => null));
        source.emit("error", error);
        return source;
      },
    });
    const outer = readStreamLike(
      source,
      methodsOf(source),
      cancelled,
      report,
    ).on("error", () => null);
    deepStrictEqual(
      [outer.errored, inner.map(({ errored }) => errored), reports],
      [failure, [failure], []],
    );
  });

  test("nests with another error of the same source: each ends with its own call", () => {
    const [outer, inner] = [new Error("Outer"), new Error("Inner")];
    const [reports, report] = reporter();
    const source = new EventEmitter();
    guard(source, emitterMethods, report);
    decide(source, outer, () => {
      decide(source, inner, () => {
        source.emit("error", outer);
        source.emit("error", inner);
      });
      source.emit("error", outer);
      source.emit("error", inner);
    });
    deepStrictEqual(reports, [inner]);
  });
});

suite("decidedFor()", () => {
  test("records an error for its source only: not reported for it, but for another source that emits it (R1 F2)", () => {
    const failure = new Error("One error of the application for every stream");
    const [reports, report] = reporter();
    const [first, second] = [new EventEmitter(), new EventEmitter()];
    guard(first, emitterMethods, report);
    guard(second, emitterMethods, report);
    decidedFor(first, failure);
    first.emit("error", failure);
    second.emit("error", failure);
    deepStrictEqual(reports, [failure]);
  });

  test("also for a refusal of the guard of its source: with that error, not logged, but for another source", () => {
    const failure = new Error("Decided, then thrown for the guard");
    const [refusals, refused] = reporter();
    const [first, second] = [
      refusing("error", failure),
      refusing("error", failure),
    ];
    decidedFor(first, failure);
    const guarded = [first, second].map((source) =>
      guard(source, emitterMethods, () => null, false, refused),
    );
    deepStrictEqual([guarded, refusals], [[false, false], [failure]]);
  });

  test("never of a primitive (only an object can be recorded): it is reported each time", () => {
    const [reports, report] = reporter();
    const source = new EventEmitter();
    guard(source, emitterMethods, report);
    decidedFor(source, "emitted");
    source.emit("error", "emitted");
    source.emit("error", "emitted");
    deepStrictEqual(reports, ["emitted", "emitted"]);
  });
});

suite("resolved()", () => {
  test("a readable of a stream-like source whose send has resolved, once released, destroys the source without an error, never with the reason (R2 R21-H3)", () => {
    const source = new Source();
    let reasons = 0;
    const readable = readStreamLike(
      source,
      methodsOf(source),
      () => {
        reasons += 1;
        return new Error("Cancelled");
      },
      () => null,
    );
    resolved(readable);
    readable.destroy();
    deepStrictEqual(
      [source.destroys, reasons, readable.errored],
      [[[]], 0, null],
    );
  });

  test("a readable destroyed with an error destroys the source with it all the same", () => {
    const source = new Source();
    const failure = new Error("A failure once resolved");
    const readable = readStreamLike(
      source,
      methodsOf(source),
      cancelled,
      () => null,
    );
    resolved(readable);
    readable.on("error", () => null).destroy(failure);
    deepStrictEqual(source.destroys, [[failure]]);
  });

  test("without it, a readable released without an error destroys the source with the reason", () => {
    const source = new Source();
    const reason = new Error("The reason of a cancellation");
    const readable = readStreamLike(
      source,
      methodsOf(source),
      () => reason,
      () => null,
    );
    readable.destroy();
    deepStrictEqual(source.destroys, [[reason]]);
  });
});

suite(
  "A stream-like source whose code throws one value for the listener of `data` of its send, then for a listener of its guard",
  () => {
    for (const event of ["error", "close"] as const) {
      for (const [kind, value, logged] of [
        ["an object", new Error("Thrown"), 0],
        ["a string", "thrown", 1],
      ] as const) {
        test(`(of its \`${event}\`), ${kind}: rejects with it, which is ${logged === 0 ? "not logged (it has decided the send)" : "logged once (only an object can be decided, R3.21-2)"}`, async () => {
          const captured = capture();
          const outcomes: unknown[] = [];
          const app = new Binden({
            logger: captured.logger,
            log_error_details: true,
          }).use(async (context: Context) => {
            const source = Object.assign(new EventEmitter(), {
              pause(): void {
                // Never full
              },
              resume(): void {
                // Emits nothing
              },
              destroy(): void {
                // Emits nothing
              },
            });
            const counts = new Map<string, number>();
            source.on("newListener", (added: string) => {
              const count = (counts.get(added) ?? 0) + 1;
              counts.set(added, count);
              // The second one of `event` is the one of its guard
              if (added === "data" || (added === event && count === 2)) {
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- also a primitive, as code of a source may throw
                throw value;
              }
            });
            await context.send(source).catch((error: unknown) => {
              outcomes.push(error);
            });
            await context.response.status(500).send("failed");
          });
          const listening = await listen(app);
          try {
            const { status } = await send(listening.port);
            await ioTurn();
            const messages = captured.records
              .map(({ msg }) => msg)
              .filter(
                (msg) =>
                  msg === "The release of a stream has failed" ||
                  msg === releasedFailure,
              );
            deepStrictEqual(
              [status, outcomes, messages],
              [
                500,
                [value],
                logged === 0 ? [] : ["The release of a stream has failed"],
              ],
            );
          } finally {
            await listening.close();
          }
        });
      }
    }
  },
);
