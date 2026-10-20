import { Binden, type Context, releasedFailure } from "../index.js";
import { capture, ioTurn, listen, within } from "./helpers.js";
import { converse, get } from "./connection.js";
import { suite, test } from "node:test";
import { PassThrough } from "node:stream";
import { deepStrictEqual } from "node:assert/strict";

/** The message of the failure of a release of a source */
const releaseFailure = "The release of a stream has failed";

/**
 * Sends a source to a response that the application ends while its send
 * listens (it waits for the response before it on its connection, `/slow`,
 * so that it has not finished): then the source emits an error, and a
 * listener of its `newListener` throws that same error for the listener of
 * `event` that the guard of the stopped send adds. Resolves with how the
 * send has settled, and the messages of the late errors and of the failed
 * releases that have been logged
 */
async function stopped(
  event: "close" | "error",
): Promise<[string, unknown[], unknown[]]> {
  const failure = new Error("Emitted, then thrown for the guard");
  const captured = capture();
  const slow = Promise.withResolvers<null>();
  const outcome = Promise.withResolvers<string>();
  const app = new Binden({
    logger: captured.logger,
    log_error_details: true,
  }).use(async (context: Context) => {
    if (context.url.pathname === "/slow") {
      await slow.promise;
      await context.text("slow");
      return;
    }
    const source = new PassThrough();
    const sent = context.send(source).then(
      () => "resolved",
      (error: unknown) => `rejected:${(error as Error).message}`,
    );
    context.response.end("complete");
    setImmediate(() => {
      let armed = true;
      source.on("newListener", (name: string) => {
        if (armed && name === event) {
          armed = false;
          throw failure;
        }
      });
      source.emit("error", failure);
      slow.resolve(null);
    });
    outcome.resolve(await sent);
  });
  const listening = await listen(app);
  try {
    await converse(listening.port, `${get("/slow")}${get("/ended")}`, {
      complete: (received) => received.endsWith("\r\n\r\ncomplete"),
    });
    const settled = await within(outcome.promise);
    // The report of a stopped send comes on a later turn
    await ioTurn();
    const messages = (message: string): unknown[] =>
      captured.records
        .filter(({ msg }) => msg === message)
        .map(
          ({ failure: logged }) => (logged as { message?: unknown }).message,
        );
    return [settled, messages(releasedFailure), messages(releaseFailure)];
  } finally {
    await listening.close();
  }
}

suite(
  "The error of a source that has stopped its send (the response has ended), which code of the source throws again for a listener of the guard that the send installs",
  () => {
    for (const event of ["error", "close"] as const) {
      test(`is logged once, as a late error, not as a refusal of the guard as well (for its listener of \`${event}\`)`, async () => {
        const [settled, late, refusals] = await stopped(event);
        deepStrictEqual(
          [settled, late, refusals],
          ["resolved", ["Emitted, then thrown for the guard"], []],
        );
      });
    }
  },
);
