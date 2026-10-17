import {
  type ISourceReport,
  type IStreamLikeLogs,
  type IStreamLikeMethods,
  decided,
  emitterMethods,
  guard,
  hear,
  readStreamLike,
  releaseStreamLike,
  streamLikeOf,
} from "../src/stream-like.js";
import { suite, test } from "node:test";
import { EventEmitter } from "node:events";
import { deepStrictEqual } from "node:assert/strict";
import { ioTurn } from "./helpers.js";

/** A stream-like source of its own: an emitter with `pause()` and `resume()` */
class Source extends EventEmitter {
  public pause(): this {
    return this;
  }

  public resume(): this {
    return this;
  }
}

/** What has been reported as a late error, and logged by each log of a release */
interface IRecorded {
  readonly report: ISourceReport;
  readonly logs: IStreamLikeLogs;
  /** The messages, by where they have gone */
  readonly seen: Record<"late" | "released" | "removed", unknown[]>;
}

/** Records the late errors and the logs of a release (see `IStreamLikeLogs`) */
function record(): IRecorded {
  const seen = {
    late: [] as unknown[],
    released: [] as unknown[],
    removed: [] as unknown[],
  };
  /** The message of an error, any other value as it is */
  function message(error: unknown): unknown {
    return error instanceof Error ? error.message : error;
  }
  return {
    report: (error) => seen.late.push(message(error)),
    logs: {
      released: (error) => seen.released.push(message(error)),
      removed: (error) => seen.removed.push(message(error)),
    },
    seen,
  };
}

/** The methods of a stream-like source (see `streamLikeOf()`) */
function methodsOf(source: object): IStreamLikeMethods {
  return streamLikeOf(source) as IStreamLikeMethods;
}

/** A source whose listeners of `event` are refused (by a listener of its `newListener`) with `error`, after `after` of them */
function refusing(event: string, error: unknown, after = 0): Source {
  const source = new Source();
  let added = 0;
  source.on("newListener", (name: string) => {
    if (name === event) {
      added += 1;
      if (added > after) {
        throw error;
      }
    }
  });
  return source;
}

suite("guard() of a source whose code refuses it", () => {
  test("never gives an error that has decided a send to `refused`: of its listener of `error`, of `close`, or of the removal after a refusal", () => {
    const refused: unknown[] = [];
    const late: unknown[] = [];
    const add = (error: unknown): void => {
      refused.push((error as Error).message);
    };
    const report = (error: unknown): void => {
      late.push(error);
    };
    const decision = new Error("Decided");
    decided(decision);
    // Its listener of `error`: not guarded, whatever it has thrown
    const errors = refusing("error", decision);
    const other = refusing("error", new Error("Not decided"));
    // Its listener of `close`: guarded, as without the refusal
    const closes = refusing("close", decision);
    // Its `on()` adds the listener, then throws; and so does the removal
    const removing = Object.assign(new Source(), {
      on(): never {
        throw new Error("Refused");
      },
      removeListener(): never {
        throw decision;
      },
    });
    deepStrictEqual(
      [
        guard(errors, emitterMethods, report, false, add),
        guard(other, emitterMethods, report, false, add),
        guard(closes, emitterMethods, report, false, add),
        guard(removing, methodsOf(removing), report, false, add),
      ],
      [false, false, true, false],
    );
    deepStrictEqual([refused, late], [["Not decided", "Refused"], []]);
  });
});

suite("hear() of a source", () => {
  test("while a send hears it (however many), its guard does not report its error: once none does, it does", () => {
    const late: unknown[] = [];
    const source = new Source();
    guard(source, emitterMethods, (error) => late.push(error));
    hear(source, 1);
    hear(source, 1);
    source.emit("error", "heard by two");
    hear(source, -1);
    source.emit("error", "heard by one");
    hear(source, -1);
    source.emit("error", "heard by none");
    deepStrictEqual(late, ["heard by none"]);
  });
});

suite(
  "readStreamLike() of a source whose code throws once it is no longer read",
  () => {
    test("logs a refusal of its guard by `released`, never as a late error", async () => {
      const recorded = record();
      // The listener of the send is added, the one of its guard refused
      const source = refusing("error", new Error("Guard refused"), 1);
      const readable = readStreamLike(
        source,
        methodsOf(source),
        () => new Error("Cancelled"),
        recorded.report,
        () => null,
        recorded.logs,
      );
      readable.on("error", () => null).destroy(new Error("Cancelled"));
      await ioTurn();
      deepStrictEqual(recorded.seen, {
        late: [],
        released: ["Guard refused"],
        removed: [],
      });
    });

    test("logs a pause() that throws, of a source without destroy() once cancelled, by `released`", async () => {
      const recorded = record();
      const source = Object.assign(new Source(), {
        pause(): never {
          throw new Error("Pause failed");
        },
      });
      const readable = readStreamLike(
        source,
        methodsOf(source),
        () => new Error("Cancelled"),
        recorded.report,
        () => null,
        recorded.logs,
      );
      readable.on("error", () => null).destroy(new Error("Cancelled"));
      await ioTurn();
      deepStrictEqual(recorded.seen, {
        late: [],
        released: ["Pause failed"],
        removed: [],
      });
    });

    test("logs a removal that throws, at once and on the next turn, by `removed`", async () => {
      const recorded = record();
      const source = Object.assign(new Source(), {
        removeListener(event: string): never {
          throw new Error(`Cannot remove ${event}`);
        },
      });
      const readable = readStreamLike(
        source,
        methodsOf(source),
        () => new Error("Cancelled"),
        recorded.report,
        () => null,
        recorded.logs,
      );
      readable.resume();
      source.emit("end");
      await ioTurn();
      deepStrictEqual(recorded.seen, {
        late: [],
        released: [],
        removed: [
          "Cannot remove data",
          "Cannot remove end",
          "Cannot remove close",
          "Cannot remove error",
        ],
      });
    });

    test("without logs, reports them as late errors (the default)", async () => {
      const recorded = record();
      const source = Object.assign(refusing("error", new Error("Refused"), 1), {
        removeListener(): never {
          throw new Error("Cannot remove");
        },
      });
      const readable = readStreamLike(
        source,
        methodsOf(source),
        () => new Error("Cancelled"),
        recorded.report,
      );
      readable.on("error", () => null).destroy(new Error("Cancelled"));
      await ioTurn();
      // The removal of the refused listener of its guard, then of the
      // listeners of the send (but the one of `error`, kept)
      deepStrictEqual(recorded.seen.late, [
        "Refused",
        "Cannot remove",
        "Cannot remove",
        "Cannot remove",
        "Cannot remove",
      ]);
    });
  },
);

suite("releaseStreamLike() of a source whose code throws", () => {
  test("logs a refusal of its guard by `released`, never as a late error (without logs, as one)", () => {
    const recorded = record();
    for (const logs of [recorded.logs, null]) {
      const source = refusing("close", new Error("Close refused"));
      if (logs === null) {
        releaseStreamLike(source, methodsOf(source), recorded.report);
      } else {
        releaseStreamLike(
          source,
          methodsOf(source),
          recorded.report,
          () => null,
          logs,
        );
      }
    }
    deepStrictEqual(recorded.seen, {
      late: ["Close refused"],
      released: ["Close refused"],
      removed: [],
    });
  });
});
