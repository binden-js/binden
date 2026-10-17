import { Binden, type Context } from "../index.js";
import { capture, listen, send, within } from "./helpers.js";
import { suite, test } from "node:test";
import { Readable } from "node:stream";
import { deepStrictEqual } from "node:assert/strict";

/** How a send has settled: `resolved`, or what it has rejected with */
function outcomeOf(promise: Promise<void>): Promise<unknown> {
  return promise.then(
    () => "resolved",
    (error: unknown) => error,
  );
}

/**
 * Replies one request with the middleware: the status that the client gets
 * (`0` once the connection is closed before), what the middleware has seen,
 * and the logger (with the messages of the errors). The middleware then
 * throws: its error is replied (`500`), or the connection is closed once the
 * headers are committed.
 */
async function replied<T>(
  middleware: (context: Context) => Promise<T>,
): Promise<[number, T, ReturnType<typeof capture>]> {
  const captured = capture();
  const seen = Promise.withResolvers<T>();
  const app = new Binden({
    logger: captured.logger,
    log_error_details: true,
  }).use(async (context: Context) => {
    seen.resolve(await middleware(context));
    throw new Error("Replied");
  });
  const listening = await listen(app);
  try {
    const status = await send(listening.port, { ms: 10_000 }).then(
      (received) => received.status,
      () => 0,
    );
    return [status, await within(seen.promise, 10_000), captured];
  } finally {
    await listening.close();
  }
}

suite("A send that settles otherwise", () => {
  /**
   * A source that pushes a chunk once read, never ends, and records how many
   * `data` listeners it has when it is destroyed
   */
  function recording(counts: number[]): Readable {
    let pushed = false;
    return new (class extends Readable {
      public override destroy(error?: Error): this {
        counts.push(this.listenerCount("data"));
        return super.destroy(error);
      }
    })({
      read(): void {
        if (!pushed) {
          pushed = true;
          this.push("chunk");
        }
      },
    });
  }

  test("once its source has ended without being destroyed (`autoDestroy: false`): it resolves, and leaves the source as it is", async () => {
    const source = new Readable({
      autoDestroy: false,
      read(): void {
        this.push("ended");
        this.push(null);
      },
    });
    const [status, outcome] = await replied(async (context) => {
      const sent = await outcomeOf(context.send(source));
      return [sent, source.readableEnded];
    });
    // The middleware then throws: once the response has ended, it is logged
    deepStrictEqual(
      [status, outcome, source.destroyed],
      [200, ["resolved", true], false],
    );
  });

  test("by an `error` of the response: it rejects with it, then releases its source", async () => {
    const counts: number[] = [];
    const failure = new Error("The response has failed");
    const source = recording(counts);
    source.pause();
    const [status, outcome] = await replied(async (context) => {
      // Waits for the drain of the response
      context.response.write(Buffer.alloc(1 << 20, 0x61));
      const sent = outcomeOf(context.send(source));
      context.response.emit("error", failure);
      return sent;
    });
    // Its listeners removed before it is destroyed
    deepStrictEqual(
      [status, outcome, counts, source.destroyed],
      [0, failure, [0], true],
    );
  });

  test("by a write that is not delivered: it rejects with its error, then releases its source", async () => {
    const counts: number[] = [];
    const failure = new Error("Not delivered");
    const source = recording(counts);
    const [status, outcome] = await replied(async (context) => {
      const { response } = context;
      const write = response.write.bind(response);
      Object.defineProperty(response, "write", {
        value: (chunk: string, callback: (error: Error) => void): boolean => {
          setImmediate(callback, failure);
          return write(chunk);
        },
      });
      return outcomeOf(context.send(source));
    });
    deepStrictEqual(
      [status, outcome, counts, source.destroyed],
      [0, failure, [0], true],
    );
  });
});
