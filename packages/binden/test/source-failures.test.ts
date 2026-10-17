import { Binden, type Context } from "../index.js";
import { capture, listen, send, within } from "./helpers.js";
import { suite, test } from "node:test";
import { Readable } from "node:stream";
import { deepStrictEqual } from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

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

suite("Code of a source that throws while send() reads it", () => {
  test("its own `on()`, a listener of its `newListener`, its `resume()` (fresh, flowing, paused, at a drain), whatever it throws: the send rejects with it, and nothing crashes or is left", () => {
    const { status, stdout, stderr } = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(import.meta.dirname, "fixtures", "throwing-sources.ts"),
      ],
      { encoding: "utf8", timeout: 60_000 },
    );
    const lines: string[] = [];
    for (const [path, reply] of [
      ["fresh", "started=false 500+200(open)"],
      ["flowing", "started=false 500+200(open)"],
      ["paused", "started=false 500+200(open)"],
      ["on", "started=false 500+200(open)"],
      ["newListener", "started=false 500+200(open)"],
      // The headers are committed: the connection is closed
      ["drain", "started=true (closed)"],
      ["backpressure", "started=true (closed)"],
    ] as const) {
      for (const value of ["error", "null", "undefined", "string", "number"]) {
        lines.push(
          `${path}/${value} rejected ${reply} destroyed=true listeners=0`,
        );
      }
    }
    deepStrictEqual(
      { status, stdout, stderr },
      { status: 0, stdout: `${lines.join("\n")}\n`, stderr: "" },
    );
  });

  test("an `error` that its own `on()` emits at once settles the send: no other listener is added, and it is not resumed", async () => {
    const failure = new Error("Emitted at once");
    const added: unknown[] = [];
    let resumes = 0;
    const source = new (class extends Readable {
      public override on(...args: Parameters<Readable["on"]>): this {
        const [event] = args;
        added.push(event);
        super.on(...args);
        if (event === "error") {
          this.emit("error", failure);
        }
        return this;
      }

      public override resume(): this {
        resumes += 1;
        return super.resume();
      }
    })({
      read(): void {
        // Never read
      },
    });
    source.pause();
    const [status, outcome] = await replied(async (context) => {
      const error = await outcomeOf(context.send(source));
      return [error, context.response.started];
    });
    deepStrictEqual(
      [status, outcome, added, resumes, source.destroyed],
      // Its `error` first: nothing else once it has failed
      [500, [failure, false], ["error"], 0, true],
    );
  });

  test("a guard that cannot be installed (a listener of its `newListener` that throws) is logged, and the send still settles", async () => {
    const failure = new Error("No close listener");
    const source = new Readable({
      read(): void {
        // Never read
      },
    });
    source.on("newListener", (event: string) => {
      if (event === "close") {
        throw failure;
      }
    });
    const [status, outcome, captured] = await replied(async (context) => {
      const error = await outcomeOf(context.send(source));
      return [error, context.response.started];
    });
    const record = await captured.waitFor("The release of a stream has failed");
    deepStrictEqual(
      [
        status,
        outcome,
        record.level,
        (record.failure as { message?: unknown }).message,
        source.destroyed,
      ],
      [500, [failure, false], 20, failure.message, true],
    );
    // Only the `error` listener of its guard
    deepStrictEqual(
      ["data", "end", "error", "close"].map((event) =>
        source.listenerCount(event),
      ),
      [0, 0, 1, 0],
    );
  });
});

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
