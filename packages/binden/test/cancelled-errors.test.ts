import { Binden, type Context, releasedFailure } from "../index.js";
import {
  type ICaptured,
  capture,
  ioTurn,
  listen,
  never,
  send,
  within,
} from "./helpers.js";
import { suite, test } from "node:test";
import { PassThrough } from "node:stream";
import { deepStrictEqual } from "node:assert/strict";

/** The error that the source of the send brings while its cancellation is pending */
const brought = "The source has failed meanwhile";

/** The messages of the late errors that have been logged */
function late(captured: ICaptured): unknown[] {
  return captured.records
    .filter(({ msg }) => msg === releasedFailure)
    .map(({ failure }) => (failure as { message?: unknown }).message);
}

/**
 * Replies one request of the application: the status that the client gets,
 * and the messages of the late errors that have been logged once the send
 * has settled, on a later turn
 */
async function replied(
  app: Binden,
  captured: ICaptured,
  settled: Promise<unknown>,
): Promise<[number, unknown[]]> {
  const listening = await listen(app);
  try {
    const { status } = await send(listening.port);
    await within(settled);
    // A late error is logged on a later turn
    await ioTurn();
    return [status, late(captured)];
  } finally {
    await listening.close();
  }
}

suite(
  "An error that the source of a send brings once the cancellation of the send is recorded, before it is carried out, decides nothing: the send rejects with the reason of the cancellation, and that error is logged once, as a late error",
  () => {
    test("of a failed error handler", async () => {
      const reason = new Error("The error handler has failed");
      const outcome = Promise.withResolvers<unknown>();
      const captured = capture();
      const app = new Binden({
        logger: captured.logger,
        log_error_details: true,
        error_handler: (context: Context): never => {
          const source = new PassThrough();
          context.send(source).then(outcome.resolve, outcome.resolve);
          // Once the failure of the handler has recorded the cancellation of
          // its sends, before it is carried out
          process.nextTick(() => {
            source.destroy(new Error(brought));
          });
          throw reason;
        },
      }).use(() => {
        throw new Error("The middleware has failed");
      });
      const [status, logged] = await replied(app, captured, outcome.promise);
      deepStrictEqual(
        [status, await outcome.promise, logged],
        [500, reason, [brought]],
      );
    });

    test("of a failed pipe", async () => {
      const reason = new Error("The pipe has failed");
      const outcome = Promise.withResolvers<unknown>();
      const captured = capture();
      const app = new Binden({
        logger: captured.logger,
        log_error_details: true,
      }).use(async (context: Context) => {
        const source = new PassThrough();
        context.send(source).then(outcome.resolve, outcome.resolve);
        // Told that its response is closed once the pipe below has failed,
        // which has recorded the cancellation of its sends, before the
        // framework carries it out
        context.response.on("close", () => {
          source.destroy(new Error(brought));
        });
        const piped = new PassThrough();
        piped.pipe(context.response);
        piped.prependListener("end", () => {
          throw reason;
        });
        piped.end();
        await never();
      });
      const [status, logged] = await replied(app, captured, outcome.promise);
      deepStrictEqual(
        [status, await outcome.promise, logged],
        [500, reason, [brought]],
      );
    });
  },
);
