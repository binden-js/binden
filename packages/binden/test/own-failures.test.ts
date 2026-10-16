import { Binden, type Context } from "../index.js";
import { type ICaptured, capture, listen, send, within } from "./helpers.js";
import { deepStrictEqual, ok } from "node:assert/strict";
import { suite, test } from "node:test";
import { Readable } from "node:stream";

/** The code (or the message) of an error */
function codeOf(error: unknown): unknown {
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code ?? message;
}

/**
 * Replies one request with the middleware, which sends the source (with a
 * `Content-Length` of 5 bytes when `length`): resolves with the status that
 * the client gets within 2 s, how the send has settled, and its logger,
 * once the middleware has settled
 */
async function replied(
  source: Readable,
  length: boolean,
): Promise<[number, unknown, ICaptured]> {
  const captured = capture();
  const outcome = Promise.withResolvers<unknown>();
  const app = new Binden({ logger: captured.logger }).use(
    async (context: Context) => {
      if (length) {
        context.response.setHeader("Content-Length", 5);
      }
      await context.send(source).then(
        () => {
          outcome.resolve("resolved");
        },
        (error: unknown) => {
          outcome.resolve(codeOf(error));
          throw error;
        },
      );
    },
  );
  const listening = await listen(app);
  try {
    const { status } = await send(listening.port, { ms: 2000 });
    return [status, await within(outcome.promise), captured];
  } finally {
    await listening.close();
  }
}

/** A source of one chunk (an object in `objectMode`), whose `_destroy()` calls `destroyed` */
function sourceOf(
  objectMode: boolean,
  destroyed: (
    error: Error | null,
    callback: (error?: Error | null) => void,
  ) => void,
): Readable {
  return new Readable({
    objectMode,
    read(): void {
      this.push(objectMode ? { a: 1 } : "x".repeat(10));
      this.push(null);
    },
    destroy: destroyed,
  });
}

suite("A send of a Readable that binden fails itself", () => {
  for (const [what, objectMode, error] of [
    [
      "a body longer than its `Content-Length`",
      false,
      "ERR_HTTP_CONTENT_LENGTH_MISMATCH",
    ],
    ["a chunk that is not bytes", true, "ERR_INVALID_ARG_TYPE"],
  ] as const) {
    test(`(${what}) settles at once with its error, which is replied, also when the \`_destroy()\` of the source swallows it (it never emits its \`error\`)`, async () => {
      const source = sourceOf(objectMode, (_error, callback) => {
        callback(null);
      });
      const [status, outcome] = await replied(source, !objectMode);
      // Destroyed with it afterwards
      deepStrictEqual(
        [status, outcome, source.destroyed, codeOf(source.errored)],
        [500, error, true, error],
      );
    });
  }

  test("settles at once with its error, which is replied, while the `_destroy()` of the source completes later: then its guard logs the error", async () => {
    let complete = (): void => {
      // Until the source is destroyed
    };
    const source = sourceOf(false, (error, callback) => {
      complete = (): void => {
        callback(error);
      };
    });
    const [status, outcome, captured] = await replied(source, true);
    deepStrictEqual(
      [status, outcome, source.destroyed, source.closed],
      [500, "ERR_HTTP_CONTENT_LENGTH_MISMATCH", true, false],
    );
    const message = "A stream-like source has failed once released";
    ok(!captured.records.some(({ msg }) => msg === message));
    complete();
    const record = await captured.waitFor(message);
    deepStrictEqual(
      [record.level, codeOf(record.failure)],
      [20, "ERR_HTTP_CONTENT_LENGTH_MISMATCH"],
    );
  });

  test("whose own `destroy()` throws: settles at once with its error, which is replied, and the failure of the release is logged (`debug`)", async () => {
    const failure = new Error("Not destroyed");
    const source = new (class extends Readable {
      // With an error only (`autoDestroy` destroys it without one)
      public override destroy(error?: Error): this {
        if (error) {
          throw failure;
        }
        return super.destroy();
      }
    })({
      read(): void {
        this.push("x".repeat(10));
        this.push(null);
      },
    });
    const [status, outcome, captured] = await replied(source, true);
    const released = captured.records.filter(
      ({ msg }) => msg === "The release of a stream has failed",
    );
    deepStrictEqual(
      [status, outcome, released.map(({ level }) => level)],
      [500, "ERR_HTTP_CONTENT_LENGTH_MISMATCH", [20]],
    );
  });
});

suite(
  "A send of a Readable that the application destroys with an error that its `_destroy()` swallows (it emits its `close` only)",
  () => {
    test("before the headers are committed: rejects with that error, which is replied", async () => {
      const failure = new Error("Swallowed");
      const source = new Readable({
        read(): void {
          this.destroy(failure);
        },
        destroy(_error, callback): void {
          callback(null);
        },
      });
      const [status, outcome] = await replied(source, false);
      deepStrictEqual(
        [status, outcome, source.closed, source.errored],
        [500, "Swallowed", true, failure],
      );
    });
  },
);
