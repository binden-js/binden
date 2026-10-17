import { Binden, type Context, releasedFailure } from "../index.js";
import { capture, ioTurn, listen, pollUntil, send } from "./helpers.js";
import { suite, test } from "node:test";
import { Readable } from "node:stream";
import { createRequire } from "node:module";
import { deepStrictEqual } from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);

/** The message of a removal of a listener of a stream that throws */
const removal = "The removal of a listener of a stream has failed";

/**
 * Sends `source` to `GET /` (and runs `sent()` once the send has resolved)
 * while the client reads the response, then waits until `done()` holds: the
 * status, the body, and the records of the removals that have thrown and of
 * the late errors, as `message [failure]`
 */
async function run(
  source: Readable,
  done: () => boolean,
  sent: () => void = (): void => {
    // Nothing to do
  },
): Promise<[number, string, string[]]> {
  const captured = capture();
  const app = new Binden({
    logger: captured.logger,
    log_error_details: true,
  }).use(async (context: Context) => {
    await context.send(source);
    sent();
  });
  const listening = await listen(app);
  try {
    const { status, body } = await send(listening.port);
    await pollUntil(done);
    await ioTurn();
    const records = captured.records
      .filter(({ msg }) => msg === removal || msg === releasedFailure)
      .map(
        ({ msg, failure }) =>
          `${String(msg)} [${String((failure as { message?: unknown }).message)}]`,
      );
    return [status, body, records];
  } finally {
    await listening.close();
  }
}

suite(
  "The guard of a source that leaves on the turn after its close, whose removals throw",
  () => {
    test("(`readable-stream` 4, whose own `removeListener()` throws for every listener once it has removed it): each of its listeners is removed on its own, and each throw is logged as a removal, never as a late error (R3.21-6)", async () => {
      const { Readable: Readable4 } = require("readable-stream-v4") as {
        Readable: typeof Readable;
      };
      let pushed = 0;
      const source = new Readable4({
        read(): void {
          pushed += 1;
          this.push(pushed <= 2 ? "x" : null);
        },
      });
      const remove = source.removeListener.bind(source);
      Object.assign(source, {
        removeListener(event: string, listener: () => void): Readable {
          remove(event, listener);
          throw new Error(`No removal of ${event}`);
        },
      });
      const [status, body, records] = await run(
        source,
        () =>
          source.listenerCount("error") === 0 &&
          source.listenerCount("close") === 0,
      );
      deepStrictEqual(
        [status, body, records],
        [
          200,
          "xx",
          [
            // Of the send, once it has settled (the one of `error` on the
            // next turn)
            `${removal} [No removal of data]`,
            `${removal} [No removal of end]`,
            `${removal} [No removal of close]`,
            `${removal} [No removal of error]`,
            // Of its guard, once it has closed
            `${removal} [No removal of error]`,
            `${removal} [No removal of close]`,
          ],
        ],
      );
    });

    test("(a Node.js `Readable`, whose listener of `removeListener` throws once the send has settled): each of its listeners is removed, and each throw is logged as a removal, never as a late error (R3.21-6)", async () => {
      let armed = false;
      let pushed = 0;
      const source = new Readable({
        read(): void {
          pushed += 1;
          this.push(pushed <= 2 ? "x" : null);
        },
        destroy(error, callback): void {
          // It closes once the send has resolved (and has removed its
          // listeners): only the removals of its guard throw
          const closing = (): void => {
            if (armed) {
              callback(error);
            } else {
              setTimeout(closing, 5);
            }
          };
          closing();
        },
      });
      source.on("removeListener", (event: string) => {
        if (armed) {
          throw new Error(`No removal of ${event}`);
        }
      });
      const [status, body, records] = await run(
        source,
        () =>
          source.closed &&
          source.listenerCount("error") === 0 &&
          source.listenerCount("close") === 0,
        () => {
          armed = true;
        },
      );
      deepStrictEqual(
        [status, body, records],
        [
          200,
          "xx",
          [
            `${removal} [No removal of error]`,
            `${removal} [No removal of close]`,
          ],
        ],
      );
    });

    test("whose logger throws for them too: does not crash the process, and both of its listeners are removed", () => {
      const { status, stdout, stderr } = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          join(import.meta.dirname, "fixtures", "guard-removal-logs.ts"),
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      deepStrictEqual(
        { status, stdout, stderr },
        { status: 0, stdout: "left 0 0\n", stderr: "" },
      );
    });
  },
);
