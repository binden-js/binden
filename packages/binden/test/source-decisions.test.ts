import { Binden, type Context, releasedFailure } from "../index.js";
import { capture, ioTurn, listen, pollUntil, send } from "./helpers.js";
import { suite, test } from "node:test";
import { Readable } from "node:stream";
import { deepStrictEqual } from "node:assert/strict";

/** How a send has settled: resolved, or the message of its error */
function outcomeOf(sent: Promise<void>): Promise<string> {
  return sent.then(
    () => "resolved",
    (error: unknown) => `rejected:${(error as Error).message}`,
  );
}

/** The messages of the late errors (and of the release failures) that have been logged */
function logged(records: Record<string, unknown>[]): unknown[] {
  return records
    .filter(
      ({ msg }) =>
        msg === releasedFailure || msg === "The release of a stream has failed",
    )
    .map(
      ({ msg, failure }) =>
        `${String(msg)}: ${String((failure as { message?: unknown }).message)}`,
    );
}

suite(
  "The send of a Node.js `Readable` destroyed with an error before it",
  () => {
    for (const [how, emits] of [
      ["emits that error", true],
      ["throws that error", false],
    ] as const) {
      test(`rejects with it, which is decided while its guard is installed: code of the source that ${how} meanwhile (for the listener of \`close\` of the guard) is not logged, and another error is`, async () => {
        for (const same of [true, false]) {
          const failure = new Error("Destroyed with it");
          const other = new Error("Another error");
          const captured = capture();
          const outcomes: string[] = [];
          const listening = await listen(
            new Binden({
              logger: captured.logger,
              log_error_details: true,
            }).use(async (context: Context) => {
              const source = new Readable({
                read(): void {
                  // Never read
                },
              });
              // Its `error` event comes on the next tick
              source.destroy(failure);
              source.on("error", () => null);
              let armed = true;
              source.on("newListener", (event: string) => {
                if (armed && event === "close") {
                  armed = false;
                  const error = same ? failure : other;
                  if (emits) {
                    source.emit("error", error);
                  } else {
                    throw error;
                  }
                }
              });
              outcomes.push(await outcomeOf(context.send(source)));
              throw new Error("Replied");
            }),
          );
          try {
            const { status } = await send(listening.port);
            await ioTurn();
            const expected = emits
              ? `${releasedFailure}: ${other.message}`
              : `The release of a stream has failed: ${other.message}`;
            deepStrictEqual(
              [status, outcomes, logged(captured.records)],
              [500, [`rejected:${failure.message}`], same ? [] : [expected]],
            );
          } finally {
            await listening.close();
          }
        }
      });
    }
  },
);

suite("An error of the application that decides the send of one source", () => {
  for (const [how, when] of [
    ["emitted while it is sent", "sent"],
    ["that it has been destroyed with before its send", "destroyed"],
  ] as const) {
    test(`(${how}) is still logged once as a late error of another source (released to \`HEAD\`), never of the source whose send it has decided`, async () => {
      // E.g. one error that the application destroys each of its streams with
      const failure = new Error("Shut down");
      const captured = capture();
      const outcomes: Record<string, string> = {};
      const listening = await listen(
        new Binden({ logger: captured.logger, log_error_details: true }).use(
          async (context: Context) => {
            if (context.request.method === "HEAD") {
              // Released at once, its destroy fails later
              const released = new Readable({
                read(): void {
                  // Never read
                },
                destroy(_error, callback): void {
                  setTimeout(callback, 50, failure);
                },
              });
              outcomes.released = await outcomeOf(context.send(released));
              return;
            }
            const source = new Readable({
              read(): void {
                // Never read
              },
            });
            if (when === "destroyed") {
              source.destroy(failure);
            } else {
              setImmediate(() => {
                source.destroy(failure);
              });
            }
            outcomes.decided = await outcomeOf(context.send(source));
            throw new Error("Replied");
          },
        ),
      );
      try {
        const [released, decided] = await Promise.all([
          send(listening.port, { method: "HEAD" }),
          send(listening.port),
        ]);
        await pollUntil(() => logged(captured.records).length > 0);
        await ioTurn();
        deepStrictEqual(
          [released.status, decided.status, outcomes, logged(captured.records)],
          [
            200,
            500,
            { released: "resolved", decided: `rejected:${failure.message}` },
            [`${releasedFailure}: ${failure.message}`],
          ],
        );
      } finally {
        await listening.close();
      }
    });
  }
});
