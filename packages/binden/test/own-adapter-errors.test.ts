import { Binden, type Context, releasedFailure } from "../index.js";
import { EventEmitter, once } from "node:events";
import { HOST, capture, ioTurn, listen, pollUntil, within } from "./helpers.js";
import {
  type IStreamLikeMethods,
  emitterMethods,
  guard,
  readStreamLike,
  streamLikeOf,
} from "../src/stream-like.js";
import { suite, test } from "node:test";
import { Readable } from "node:stream";
import { connect } from "node:net";
import { deepStrictEqual } from "node:assert/strict";

/** A stream-like source of its own, which records the errors that it is destroyed with */
class Source extends EventEmitter {
  public readonly destroys: unknown[] = [];

  public pause(): this {
    return this;
  }

  public resume(): this {
    return this;
  }

  public destroy(error?: Error): this {
    this.destroys.push(error);
    return this;
  }
}

/** A value whose `stack` getter throws, which Node.js cannot take as an error */
function unstackable(): object {
  return Object.defineProperty({}, "stack", {
    get(): never {
      throw new Error("No stack");
    },
  });
}

/**
 * The ways a stream-like source fails with an error that binden creates for
 * it: a chunk that is not bytes, a close before its end, and code of its own
 * that throws a value that Node.js cannot take as an error (wrapped)
 */
const failures: readonly (readonly [string, (source: Source) => void])[] = [
  [
    "a chunk that is not bytes (TypeError)",
    (source): void => {
      source.emit("data", 42);
    },
  ],
  [
    "a close before its end (premature close)",
    (source): void => {
      source.emit("close");
    },
  ],
  [
    "code of its own that throws a value without a stack (wrapped)",
    (source): void => {
      Object.assign(source, {
        on(event: string, listener: () => void): Source {
          if (event === "end") {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- a value that is not an error, as code of a source may throw
            throw unstackable();
          }
          EventEmitter.prototype.on.call(source, event, listener);
          return source;
        },
      });
    },
  ],
];

/**
 * Runs `run` while `Error.prepareStackTrace` records each error whose stack
 * V8 formats (once it is first read)
 */
function recording<T>(run: (formatted: WeakSet<object>) => T): T {
  const previous: unknown = Reflect.get(Error, "prepareStackTrace");
  const formatted = new WeakSet<object>();
  Reflect.set(
    Error,
    "prepareStackTrace",
    (error: Error, frames: readonly unknown[]): unknown => {
      formatted.add(error);
      return typeof previous === "function"
        ? Reflect.apply(previous, Error, [error, frames])
        : [`${error.name}: ${error.message}`, ...frames.map(String)].join(
            "\n    at ",
          );
    },
  );
  try {
    return run(formatted);
  } finally {
    Reflect.set(Error, "prepareStackTrace", previous);
  }
}

suite("An error that binden creates for a stream-like source (R3.22-2)", () => {
  for (const [name, fail] of failures) {
    test(`${name}: formatted once created (the carrier of a value: made with its stack as a value, which holds no frames), and decided for every source, whatever stream emits it`, async () => {
      const reported: unknown[] = [];
      const source = new Source();
      const before = name.startsWith("code");
      if (before) {
        fail(source);
      }
      const [readable, formatted] = recording((recorded) => {
        const read = readStreamLike(
          source,
          streamLikeOf(source) as IStreamLikeMethods,
          () => new Error("Cancelled"),
          (error) => reported.push(error),
        ).on("error", () => null);
        if (!before) {
          fail(source);
        }
        const errored = read.errored as Error;
        // The carrier (see `carrierOf()`) is never formatted: its stack is
        // a value from the start
        return [
          read,
          before
            ? !recorded.has(errored) &&
              "value" in
                Object(Reflect.getOwnPropertyDescriptor(errored, "stack"))
            : recorded.has(errored),
        ];
      });
      const failure = readable.errored as Error;
      // Another stream that the application destroys with it, and the
      // source itself
      const other = new EventEmitter();
      guard(other, emitterMethods, (error) => reported.push(error));
      other.emit("error", failure);
      source.emit("error", failure);
      await ioTurn();
      deepStrictEqual(
        [failure instanceof Error, formatted, reported],
        [true, true, []],
      );
    });
  }
});

/** The message of each late error logged so far */
function lateOf(records: readonly Record<string, unknown>[]): unknown[] {
  return records
    .filter(({ msg }) => msg === releasedFailure)
    .map(({ failure }) => (failure as { message?: unknown }).message);
}

suite(
  "A send of a stream-like source that fails with an error of binden, whose application destroys another stream with it",
  () => {
    // Not for what code of the source throws: the send rejects with that
    // value itself, an object of the application (see
    // `stream-like-safe-stacks.test.ts`), not with the error of binden that
    // carries it
    for (const [name, fail] of failures.filter(
      ([named]) => !named.startsWith("code"),
    )) {
      test(`${name}: the send rejects with it, which is not logged for the other stream (R3.22-2)`, async () => {
        const captured = capture();
        let failure: unknown = null;
        let second: Readable | null = null;
        const app = new Binden({
          logger: captured.logger,
          log_error_details: true,
        }).use(async (context: Context) => {
          if (context.url.pathname === "/second") {
            // Its destroy fails later with the error of the first send
            second = new Readable({
              read(): void {
                // Never read
              },
              destroy(_error, callback): void {
                setTimeout(callback, 10, failure);
              },
            });
            await context.send(second);
            return;
          }
          const source = new Source();
          setImmediate(() => {
            fail(source);
          });
          await context.send(source).catch((error: unknown) => {
            failure = error;
          });
          await context.response.status(500).send("failed");
        });
        const listening = await listen(app);
        try {
          for (const line of ["GET /first", "HEAD /second"]) {
            const socket = connect(listening.port, HOST);
            socket.resume().on("error", () => null);
            await once(socket, "connect");
            socket.write(
              `${line} HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n`,
            );
            await within(once(socket, "close"));
          }
          await pollUntil(() => second?.closed === true);
          await ioTurn();
          deepStrictEqual(
            [failure instanceof Error, lateOf(captured.records)],
            [true, []],
          );
        } finally {
          await listening.close();
        }
      });
    }
  },
);
