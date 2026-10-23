import { Binden, type Context, releasedFailure } from "../index.js";
import {
  type IStreamLikeMethods,
  readStreamLike,
  streamLikeOf,
} from "../src/stream-like.js";
import { capture, ioTurn, listen, send } from "./helpers.js";
import { deepStrictEqual, throws } from "node:assert/strict";
import { suite, test } from "node:test";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** The messages that tell what code of a source has thrown, or a late error of it */
const messages = new Set([
  "The release of a stream has failed",
  releasedFailure,
]);

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

/** A source whose listener of `newListener` runs `act` once the `nth` listener of `event` is added */
function sourceOn(
  event: string,
  nth: number,
  act: (source: Source) => void,
): Source {
  const source = new Source();
  let added = 0;
  source.on("newListener", (name: string) => {
    if (name === event) {
      added += 1;
      if (added === nth) {
        act(source);
      }
    }
  });
  return source;
}

/** The methods of a stream-like source (see `streamLikeOf()`) */
function methodsOf(source: object): IStreamLikeMethods {
  return streamLikeOf(source) as IStreamLikeMethods;
}

/** The values that a log (or a report) has been given */
function recorder(): [unknown[], (error: unknown) => void] {
  const recorded: unknown[] = [];
  return [
    recorded,
    (error): void => {
      recorded.push(error);
    },
  ];
}

/** The reason of a cancellation, which no test expects */
function cancelled(): Error {
  return new Error("Cancelled");
}

/**
 * Runs `GET /` on an application whose middleware sends a source (then
 * replies `500` once the send has rejected): the status, how the send has
 * settled, and the records of what code of the source has thrown, or of a
 * late error of it
 */
async function run(
  sent: (context: Context) => Promise<void>,
): Promise<[number, unknown[], string[]]> {
  const captured = capture();
  const outcomes: unknown[] = [];
  const app = new Binden({
    logger: captured.logger,
    log_error_details: true,
  }).use(async (context: Context) => {
    outcomes.push(
      await sent(context).then(
        () => "resolved",
        (error: unknown) => error,
      ),
    );
    await context.response.status(500).send("failed");
  });
  const listening = await listen(app);
  try {
    const { status } = await send(listening.port);
    await ioTurn();
    const logs = captured.records
      .filter(({ msg }) => messages.has(msg as string))
      .map(
        ({ msg, failure }) =>
          `${String(msg)}: ${String((failure as { message?: unknown }).message)}`,
      );
    return [status, outcomes, logs];
  } finally {
    await listening.close();
  }
}

suite(
  "A stream-like source that fails while it is sent (its `error`), the error that decides the send before its guard is installed",
  () => {
    for (const [event, nth] of [
      ["close", 2],
      ["error", 2],
    ] as const) {
      test(`whose code throws it again for the listener of \`${event}\` of its guard: rejects with it, which is not logged (R21-C2)`, async () => {
        const failure = new Error("The source has failed");
        // The second one is the one of its guard (after the one of the send)
        const source = sourceOn(event, nth, () => {
          throw failure;
        });
        const [status, outcomes, logs] = await run(async (context) => {
          const sent = context.send(source);
          source.emit("error", failure);
          await sent;
        });
        deepStrictEqual([status, outcomes, logs], [500, [failure], []]);
      });
    }
  },
);

suite(
  "A stream-like source destroyed with an error before its send (its `errored`), that error decided before its guard is installed",
  () => {
    test("whose code throws it again for the listener of `close` of its guard: rejects with it, which is not logged (R21-C2)", async () => {
      const failure = new Error("Destroyed with it");
      // The first one is the one of its guard: nothing else listens
      const source = Object.assign(
        sourceOn("close", 1, () => {
          throw failure;
        }),
        { destroyed: true, errored: failure },
      );
      const [status, outcomes, logs] = await run((context) =>
        context.send(source),
      );
      deepStrictEqual([status, outcomes, logs], [500, [failure], []]);
    });

    test("whose code emits it while its guard is installed: rejects with it, which is not logged (R1 F1)", async () => {
      const failure = new Error("Destroyed with it");
      const source = Object.assign(
        sourceOn("close", 1, (emitter) => {
          emitter.emit("error", failure);
        }),
        { destroyed: true, errored: failure },
      );
      const [status, outcomes, logs] = await run((context) =>
        context.send(source),
      );
      deepStrictEqual([status, outcomes, logs], [500, [failure], []]);
    });

    test("whose own `on()` gives each new listener of its `error` that error at once (a sticky error): rejects with it, which is not logged (R1 F1)", async () => {
      const failure = new Error("Sticky");
      const source = Object.assign(new Source(), {
        destroyed: true,
        errored: failure,
      });
      Object.assign(source, {
        on(event: string, listener: (error: unknown) => void): Source {
          EventEmitter.prototype.on.call(source, event, listener);
          if (event === "error") {
            listener(failure);
          }
          return source;
        },
      });
      const [status, outcomes, logs] = await run((context) =>
        context.send(source),
      );
      deepStrictEqual([status, outcomes, logs], [500, [failure], []]);
    });

    test("of `readable-stream` 4, which emits it while its guard is installed: rejects with it, which is not logged (R1 F1)", async () => {
      const failure = new Error("Destroyed with it");
      const { Readable } = require("readable-stream-v4") as {
        Readable: new (options: { read(): void }) => EventEmitter & {
          destroy(error: Error): unknown;
        };
      };
      const source = new Readable({
        read(): void {
          // Never read
        },
      });
      // The application listens
      source.on("error", () => null);
      source.destroy(failure);
      let armed = true;
      source.on("newListener", (event: string) => {
        if (armed && event === "close") {
          armed = false;
          source.emit("error", failure);
        }
      });
      const [status, outcomes, logs] = await run((context) =>
        context.send(source as Parameters<typeof context.send>[0]),
      );
      deepStrictEqual([status, outcomes, logs], [500, [failure], []]);
    });

    test("whose `errored` cannot be read (a getter of its own that throws): the send fails with what it throws, and its guard listens all the same", () => {
      const thrown = new Error("No errored");
      const source = Object.assign(new Source(), { destroyed: true });
      Object.defineProperty(source, "errored", {
        get(): never {
          throw thrown;
        },
      });
      throws(
        () => readStreamLike(source, methodsOf(source), cancelled, () => null),
        thrown,
      );
      deepStrictEqual(source.listenerCount("error"), 1);
    });
  },
);

suite(
  "A readable of a stream-like source destroyed with an error, which decides its send before the guard of the source is installed",
  () => {
    for (const [event, destroyed, how] of [
      ["close", true, "with it"],
      // Its guard is refused: only the listener of the send hears it
      ["error", false, "without it"],
    ] as const) {
      test(`whose code throws it again for the listener of \`${event}\` of its guard: not logged, and the source is destroyed ${how}`, () => {
        const failure = new Error("Decided by the send");
        // The second one is the one of its guard (after the one of the send)
        const source = sourceOn(event, 2, () => {
          throw failure;
        });
        const [released, log] = recorder();
        const [reports, report] = recorder();
        const readable = readStreamLike(
          source,
          methodsOf(source),
          cancelled,
          report,
          () => null,
          { released: log, removed: log },
        );
        readable.on("error", () => null).destroy(failure);
        deepStrictEqual(
          [released, reports, source.destroys],
          [[], [], [destroyed ? [failure] : []]],
        );
      });
    }

    test("by a `pause()` that throws once it is full, then thrown again for the listener of `close` of its guard: not logged", () => {
      const failure = new Error("No pause");
      const source = sourceOn("close", 2, () => {
        throw failure;
      });
      Object.assign(source, {
        pause(): never {
          throw failure;
        },
      });
      const [released, log] = recorder();
      const readable = readStreamLike(
        source,
        methodsOf(source),
        cancelled,
        () => null,
        () => null,
        { released: log, removed: log },
      ).on("error", () => null);
      // More than its high water mark: it is full, and paused
      source.emit("data", Buffer.alloc(readable.readableHighWaterMark));
      deepStrictEqual(
        [readable.errored, released, source.destroys],
        [failure, [], [[failure]]],
      );
    });
  },
);
