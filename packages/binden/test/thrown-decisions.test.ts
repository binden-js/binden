import { Binden, type Context, releasedFailure } from "../index.js";
import { capture, ioTurn, listen, pollUntil, send } from "./helpers.js";
import { suite, test } from "node:test";
import { Readable } from "node:stream";
import { deepStrictEqual } from "node:assert/strict";

/**
 * Sends `GET /first` (a source that fails its send with an error), then
 * `HEAD /second`: a `Readable` released to `HEAD` (under its guard), whose
 * destroy fails 10 ms later with that same error. The statuses (`0` for a
 * response that is closed before it is complete), the message
 * of that error, and the late errors logged (once the second source has
 * closed)
 */
async function run(
  first: (context: Context) => Readable,
): Promise<[number[], string, unknown[]]> {
  const captured = capture();
  const failures: unknown[] = [];
  let second: Readable | null = null;
  const app = new Binden({
    logger: captured.logger,
    log_error_details: true,
  }).use(async (context: Context) => {
    if (context.url.pathname === "/second") {
      const [failure] = failures;
      second = new Readable({
        read(): void {
          // Never read: released to `HEAD`
        },
        destroy(_error, callback): void {
          setTimeout(callback, 10, failure);
        },
      });
      await context.send(second);
      return;
    }
    await context.send(first(context)).catch((error: unknown) => {
      failures.push(error);
    });
    await context.response.status(500).send("failed");
  });
  const listening = await listen(app);
  try {
    const statuses = [
      // A response that has written something is closed once its send fails
      (
        await send(listening.port, { path: "/first" }).catch(() => ({
          status: 0,
        }))
      ).status,
      (await send(listening.port, { method: "HEAD", path: "/second" })).status,
    ];
    await pollUntil(() => second?.closed === true);
    await ioTurn();
    const late = captured.records
      .filter(({ msg }) => msg === releasedFailure)
      .map(({ failure }) => (failure as { message?: unknown }).message);
    return [statuses, String((failures[0] as Error).message), late];
  } finally {
    await listening.close();
  }
}

suite(
  "An error that fails the send of a Node.js `Readable` that binden finds itself, then a late error of another source",
  () => {
    test("thrown by code of the source (an object of the application, here by its own `resume()`): decided for that source only, logged once for the other one (R1 F2)", async () => {
      const failure = new Error("One error of the application");
      const [statuses, message, late] = await run(() => {
        const source = new Readable({
          read(): void {
            // Never read
          },
        });
        // The one that `on("data")` of Node.js calls
        Object.assign(source, {
          resume(): never {
            throw failure;
          },
        });
        return source;
      });
      deepStrictEqual(
        [statuses, message, late],
        [[500, 200], failure.message, [failure.message]],
      );
    });

    test("thrown by its own `pause()` once the response is full (its socket corked): decided for that source only, logged once for the other one (R1 F2)", async () => {
      const failure = new Error("One error of the application");
      const [statuses, message, late] = await run((context) => {
        // Every write is buffered: the response is full at once
        context.response.cork();
        let pushed = false;
        const source = new Readable({
          read(): void {
            if (!pushed) {
              pushed = true;
              this.push(Buffer.alloc(64 * 1024));
            }
          },
        });
        Object.assign(source, {
          pause(): never {
            throw failure;
          },
        });
        return source;
      });
      deepStrictEqual(
        [statuses, message, late],
        [[0, 200], failure.message, [failure.message]],
      );
    });

    test("thrown by its own `resume()` once the response drains (its socket corked, then uncorked): decided for that source only, logged once for the other one (R1 F2)", async () => {
      const failure = new Error("One error of the application");
      const [statuses, message, late] = await run((context) => {
        // The response is full at once, and drains once uncorked
        context.response.cork();
        setTimeout(() => {
          context.response.uncork();
        }, 10);
        let pushed = false;
        let paused = false;
        const source = new Readable({
          read(): void {
            if (!pushed) {
              pushed = true;
              this.push(Buffer.alloc(64 * 1024));
            }
          },
        });
        Object.assign(source, {
          pause(): Readable {
            paused = true;
            return Readable.prototype.pause.call(source);
          },
          resume(): Readable {
            if (paused) {
              throw failure;
            }
            return Readable.prototype.resume.call(source);
          },
        });
        return source;
      });
      deepStrictEqual(
        [statuses, message, late],
        [[0, 200], failure.message, [failure.message]],
      );
    });

    test("of binden (a body longer than its `Content-Length`): decided for every source, never logged", async () => {
      const [statuses, message, late] = await run((context) => {
        context.response.setHeader("Content-Length", 1);
        return Readable.from(["too long"]);
      });
      deepStrictEqual(
        [statuses, message, late],
        [
          [500, 200],
          "The body (8 bytes) does not match its Content-Length (1 bytes)",
          [],
        ],
      );
    });
  },
);
