import { Binden, type Context, releasedFailure } from "../index.js";
import {
  type ICaptured,
  capture,
  ioTurn,
  listen,
  send,
  within,
} from "./helpers.js";
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { suite, test } from "node:test";
import { Readable } from "node:stream";
import { createReadStream } from "node:fs";

/** The message of the failure of a release of a source */
const releaseFailure = "The release of a stream has failed";

/**
 * An error whose `stack` getter throws: Node.js reads it to destroy a stream
 * with it, and throws before the stream is destroyed
 */
function unstackable(): Error {
  return Object.defineProperty(new Error("Unstackable"), "stack", {
    get(): never {
      throw new Error("Its stack cannot be read");
    },
  });
}

/**
 * Replies one request with the middleware, which sends the source (and runs
 * `meanwhile` with the response): resolves with the status that the client
 * gets, the outcome of the send (`resolved`, or the value that it has
 * rejected with), and its logger, once the middleware has settled
 */
async function replied(
  source: Readable,
  meanwhile: (context: Context) => void = (): void => {
    // Nothing else
  },
): Promise<[number, unknown, ICaptured]> {
  const captured = capture();
  const outcome = Promise.withResolvers<unknown>();
  const app = new Binden({
    logger: captured.logger,
    log_error_details: true,
  }).use(async (context: Context) => {
    meanwhile(context);
    await context.send(source).then(
      () => {
        outcome.resolve("resolved");
      },
      (error: unknown) => {
        outcome.resolve(error);
        throw error;
      },
    );
  });
  const listening = await listen(app);
  try {
    const { status } = await send(listening.port);
    return [status, await within(outcome.promise), captured];
  } finally {
    await listening.close();
  }
}

/** The messages of the records of a release, or of a late error */
function releases(captured: ICaptured): unknown[] {
  return captured.records
    .filter(({ msg }) => msg === releaseFailure || msg === releasedFailure)
    .map(({ msg }) => msg);
}

suite("A Readable that binden destroys with what its code has thrown", () => {
  for (const [where, thrower] of [
    [
      "its own `resume()`",
      (source: Readable, thrown: Error): void => {
        source.resume = (): never => {
          throw thrown;
        };
      },
    ],
    [
      "its own `on()`, for the listener of `data`",
      (source: Readable, thrown: Error): void => {
        const on = Reflect.get(Readable.prototype, "on") as () => unknown;
        Object.defineProperty(source, "on", {
          value(this: Readable, event: string, listener: () => void): Readable {
            if (event === "data") {
              throw thrown;
            }
            Reflect.apply(on, this, [event, listener]);
            return this;
          },
        });
      },
    ],
  ] as const) {
    test(`is destroyed (its file closed) with an \`Error\` that carries it as its \`cause\` when Node.js cannot take it as an error (its \`stack\` getter throws), thrown by ${where}: nothing is logged`, async () => {
      const thrown = unstackable();
      const source = createReadStream(import.meta.filename);
      thrower(source, thrown);
      // Not `once()`, which rejects at its `error`
      const closed = new Promise<void>((resolve) => {
        source.once("close", () => {
          resolve();
        });
      });
      const [status, outcome, captured] = await replied(source);
      await within(closed);
      await ioTurn();
      const { errored } = source as { errored: Error | null };
      deepStrictEqual(
        [status, outcome === thrown, source.destroyed, source.closed],
        [500, true, true, true],
      );
      deepStrictEqual(
        [errored?.constructor, errored?.message, errored?.cause === thrown],
        [Error, "A stream has failed", true],
      );
      // Neither a failure of its release nor a late error: the error that
      // it is destroyed with is decided
      deepStrictEqual(releases(captured), []);
    });
  }

  test("is destroyed with an `Error` that carries it, whose stack is a value of its own before it is handed to the `destroy()` of the source (which may keep it): it holds no frames, and no `prepareStackTrace` runs for it", async () => {
    const thrown = unstackable();
    /** The errors whose stacks have been formatted, and when */
    const formatted = new WeakSet<object>();
    const prepare: unknown = Reflect.get(Error, "prepareStackTrace");
    Reflect.set(
      Error,
      "prepareStackTrace",
      (error: Error, frames: readonly unknown[]): string => {
        formatted.add(error);
        return [
          String(error),
          ...frames.map((frame) => `    at ${String(frame)}`),
        ].join("\n");
      },
    );
    /**
     * The errors that its own `destroy()` gets, whether they are formatted,
     * and whether their stack is a value of their own
     */
    const destroyed: [unknown, boolean, boolean][] = [];
    const source = new (class extends Readable {
      public override destroy(error?: Error): this {
        if (error === thrown) {
          // As Node.js, which reads its stack
          throw new Error("Its stack cannot be read");
        }
        destroyed.push([
          error,
          Object(error) === error && formatted.has(error as object),
          "value" in
            Object(Reflect.getOwnPropertyDescriptor(Object(error), "stack")),
        ]);
        return super.destroy(error);
      }
    })({
      read(): void {
        // Never read
      },
    });
    source.resume = (): never => {
      throw thrown;
    };
    try {
      const [status, outcome] = await replied(source);
      deepStrictEqual([status, outcome === thrown], [500, true]);
    } finally {
      Reflect.set(Error, "prepareStackTrace", prepare);
    }
    const [[error, stacked, valued] = []] = destroyed;
    deepStrictEqual(
      [
        destroyed.length,
        (error as Error | undefined)?.cause === thrown,
        stacked,
        valued,
      ],
      [1, true, false, true],
    );
  });

  test("whose own `destroy()` throws once it has destroyed it is not destroyed again: what it throws is logged (`debug`)", async () => {
    const failure = new Error("Destroyed, then thrown");
    let destroys = 0;
    const source = new (class extends Readable {
      public override destroy(error?: Error): this {
        destroys += 1;
        super.destroy(error);
        throw failure;
      }
    })({
      read(): void {
        // Never read
      },
    });
    source.on("error", () => {
      // It is destroyed with what its `resume()` throws
    });
    const thrown = new Error("Thrown by its resume()");
    source.resume = (): never => {
      throw thrown;
    };
    const [status, outcome, captured] = await replied(source);
    const record = await captured.waitFor(releaseFailure);
    deepStrictEqual(
      [status, outcome, destroys, source.errored],
      [500, thrown, 1, thrown],
    );
    strictEqual(
      (record.failure as { message?: unknown }).message,
      failure.message,
    );
  });

  test("released without an error by its own `destroy()` that throws (its send resolved once another writer has ended the response) is not destroyed with one: what it throws is logged (`debug`)", async () => {
    const failure = new Error("Not destroyed without an error");
    /** The type of the error that each destroy gets, and whether it is destroyed then */
    const destroyed: [string, boolean][] = [];
    const source = new (class extends Readable {
      public override destroy(error?: Error): this {
        destroyed.push([typeof error, this.destroyed]);
        throw failure;
      }
    })({
      read(): void {
        // Never read
      },
    });
    const [status, outcome, captured] = await replied(source, (context) => {
      setImmediate(() => {
        context.response.end("other");
      });
    });
    const record = await captured.waitFor(releaseFailure);
    deepStrictEqual(
      [status, outcome, destroyed, source.destroyed],
      [200, "resolved", [["undefined", false]], false],
    );
    strictEqual(
      (record.failure as { message?: unknown }).message,
      failure.message,
    );
  });
});
