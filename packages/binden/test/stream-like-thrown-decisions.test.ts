import { Binden, type Context, releasedFailure } from "../index.js";
import { capture, ioTurn, listen, pollUntil, send } from "./helpers.js";
import { suite, test } from "node:test";
import { EventEmitter } from "node:events";
import { deepStrictEqual } from "node:assert/strict";

/** A stream-like source of its own */
class Source extends EventEmitter {
  public pause(): this {
    return this;
  }

  public resume(): this {
    return this;
  }

  public destroy(): this {
    return this;
  }
}

/** The message of each late error logged so far */
function lateOf(records: readonly Record<string, unknown>[]): unknown[] {
  return records
    .filter(({ msg }) => msg === releasedFailure)
    .map(({ failure }) => (failure as { message?: unknown }).message);
}

/** A chunk that the response does not take at once (its `write()` returns `false`) */
const big = Buffer.alloc(1 << 20, 0x61);

suite(
  "An error that code of a stream-like source throws, which the send does not reject with (R23-C1, H23-3)",
  () => {
    test("its resume() throws it, or it emits it, while the cancellation of the send is pending (a failed error handler): the send rejects with the reason, and that error is logged once, as a late error", async () => {
      for (const mode of ["thrown", "emitted"] as const) {
        const captured = capture();
        const failure = new Error("Source failure");
        const outcomes: unknown[] = [];
        const app = new Binden({
          logger: captured.logger,
          log_error_details: true,
          error_handler(context: Context): never {
            const source = Object.assign(new Source(), {
              resume(): Source {
                if (mode === "thrown") {
                  throw failure;
                }
                return source;
              },
            });
            context.send(source).then(
              () => outcomes.push("resolved"),
              (error: unknown) => outcomes.push((error as Error).message),
            );
            if (mode === "emitted") {
              process.nextTick(() => {
                source.emit("error", failure);
              });
            }
            throw new Error("Handler failure");
          },
        }).use((): never => {
          throw new Error("Middleware failure");
        });
        const listening = await listen(app);
        try {
          const { status } = await send(listening.port);
          await pollUntil(() => outcomes.length === 1);
          await ioTurn();
          deepStrictEqual(
            [status, outcomes, lateOf(captured.records)],
            [500, ["Handler failure"], ["Source failure"]],
            mode,
          );
        } finally {
          await listening.close();
        }
      }
    });

    test("its pause() ends the response, then throws it, or emits it: the send settles as the response does, and that error is logged once, as a late error", async () => {
      for (const mode of ["thrown", "emitted"] as const) {
        const captured = capture();
        const failure = new Error("Source failure");
        const outcomes: unknown[] = [];
        const app = new Binden({
          logger: captured.logger,
          log_error_details: true,
        }).use(async (context: Context) => {
          const source = Object.assign(new Source(), {
            pause(): Source {
              context.response.end("Ended by the source");
              if (mode === "thrown") {
                throw failure;
              }
              source.emit("error", failure);
              return source;
            },
          });
          setImmediate(() => {
            // Written at once, then kept by the readable, which pauses the
            // source
            source.emit("data", big);
            source.emit("data", big);
          });
          await context.send(source).then(
            () => outcomes.push("resolved"),
            (error: unknown) => outcomes.push((error as Error).message),
          );
        });
        const listening = await listen(app);
        try {
          await send(listening.port).catch(() => null);
          await pollUntil(() => outcomes.length === 1);
          await ioTurn();
          deepStrictEqual(
            [outcomes, lateOf(captured.records)],
            [["resolved"], ["Source failure"]],
            mode,
          );
        } finally {
          await listening.close();
        }
      }
    });
  },
);
