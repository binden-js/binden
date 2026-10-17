import { Binden, type Context } from "../index.js";
import { capture, ioTurn, listen, pollUntil, within } from "./helpers.js";
import { converse, get } from "./connection.js";
import { suite, test } from "node:test";
import { Readable } from "node:stream";
import { deepStrictEqual } from "node:assert/strict";

/**
 * A `Readable` of `ok` (or of nothing, never ended: `silent`) whose listener
 * of `newListener` emits an `error` while the second listener of its `error`
 * is added: the one of its guard, once its send has settled
 */
function emitting(failure: Error, silent: boolean): Readable {
  let listeners = 0;
  const source = new Readable({
    read(): void {
      if (!silent) {
        this.push("ok");
        this.push(null);
      }
    },
  });
  source.on("newListener", (event: string) => {
    if (event === "error") {
      listeners += 1;
      if (listeners === 2) {
        source.emit("error", failure);
      }
    }
  });
  return source;
}

suite("An error that a source emits while its guard is installed", () => {
  for (const ended of [false, true]) {
    test(`is logged once as a late error, never taken by the send that has settled${ended ? " (ended by another writer)" : " (sent whole)"}: the reply is complete, and the next one is served`, async () => {
      const failure = new Error("Emitted while guarded");
      const captured = capture();
      const outcomes: string[] = [];
      const listening = await listen(
        new Binden({ logger: captured.logger, log_error_details: true }).use(
          async (context: Context) => {
            if (context.url.pathname === "/next") {
              await context.send("next");
              return;
            }
            const sent = context.send(emitting(failure, ended));
            if (ended) {
              // By a source that sends nothing: the send settles as the
              // response has ended, once it has finished
              context.response.end("ok");
            }
            outcomes.push(
              await sent.then(
                () => "resolved",
                (error: unknown) => (error as Error).message,
              ),
            );
          },
        ),
      );
      try {
        const { received } = await converse(
          listening.port,
          `${get("/")}${get("/next")}`,
          { complete: (text) => text.endsWith("next") },
        );
        const late = (): unknown[] =>
          captured.records.filter(
            ({ msg, failure: logged }) =>
              msg === "A released stream has failed" &&
              (logged as { message?: unknown }).message === failure.message,
          );
        await within(pollUntil(() => late().length > 0, 5_000));
        // Any other report of it
        await ioTurn();
        deepStrictEqual(
          [
            received.match(/HTTP\/1\.1 \d+/gu),
            // Whole (chunked when sent, by its length otherwise), then the next
            received.includes(
              ended
                ? "\r\n\r\nokHTTP/1.1 200"
                : "\r\n\r\n2\r\nok\r\n0\r\n\r\nHTTP/1.1 200",
            ),
            received.endsWith("next"),
            outcomes,
            late().length,
            captured.records
              .filter(({ level }) => (level as number) >= 40)
              .map(({ msg }) => msg),
          ],
          [["HTTP/1.1 200", "HTTP/1.1 200"], true, true, ["resolved"], 1, []],
        );
      } finally {
        await listening.close();
      }
    });
  }
});
