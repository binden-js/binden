import { Binden, type Context } from "../index.js";
import { capture, ioTurn, listen, send } from "./helpers.js";
import { suite, test } from "node:test";
import { Readable } from "node:stream";
import { deepStrictEqual } from "node:assert/strict";

/** How a send has settled: resolved, or what it has rejected with */
function outcomeOf(promise: Promise<void>): Promise<unknown> {
  return promise.then(
    () => "resolved",
    (error: unknown) => error,
  );
}

/**
 * Sends a source (made for the context) once: the status and the body that
 * the client gets, how the send has settled, and the messages of the records
 * of what has been logged, sorted (each with the message of its failure, or
 * else its type, e.g. `string`)
 */
async function sent(
  source: (context: Context) => Readable,
): Promise<[number, string, unknown, string[]]> {
  const captured = capture();
  const outcomes: unknown[] = [];
  const listening = await listen(
    new Binden({ logger: captured.logger, log_error_details: true }).use(
      async (context: Context) => {
        outcomes.push(await outcomeOf(context.send(source(context))));
        if (!context.response.writableEnded) {
          throw outcomes[0];
        }
      },
    ),
  );
  try {
    const { status, body } = await send(listening.port);
    // Any later record (e.g. of the guard, once the source emits its error)
    await ioTurn();
    const records = captured.records
      .filter(({ failure }) => typeof failure !== "undefined")
      .map(({ msg, failure }) => {
        const { message, type } = failure as {
          message?: unknown;
          type?: unknown;
        };
        return `${String(msg)}: ${String(message ?? type)}`;
      })
      .sort();
    return [status, body, outcomes[0], records];
  } finally {
    await listening.close();
  }
}

suite("A guard that a Node.js `Readable` refuses", () => {
  test("is not logged with the object that has decided the send, thrown again by code of the source (for the listener of `close` of the guard); a primitive is", async () => {
    for (const thrown of [new Error("No listener of close"), "no close"]) {
      const [status, , outcome, records] = await sent(() => {
        // Its own `on()` throws the same value for every listener of `close`:
        // the one of the send (which rejects with it), then the one of its
        // guard
        const source = new Readable({
          read(): void {
            // Never read
          },
        });
        source.on("newListener", (event: string) => {
          if (event === "close") {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- also a primitive, as code of a source may throw
            throw thrown;
          }
        });
        return source;
      });
      deepStrictEqual(
        [status, outcome, records],
        [
          500,
          thrown,
          // A primitive is not recorded as decided: logged by the refusal,
          // and once the source emits it (destroyed with it)
          typeof thrown === "string"
            ? [
                "A released stream has failed: string",
                "The release of a stream has failed: string",
                "The request has failed: string",
              ]
            : ["The request has failed: No listener of close"],
        ],
      );
    }
  });

  test("is not logged with the error that a destroyed source rejects its send with, thrown again (for the listener of `error` of its guard), nor once the response has ended, when that error is a late one, logged once", async () => {
    for (const ended of [false, true]) {
      const failure = new Error(`Destroyed with it${ended ? " (ended)" : ""}`);
      const [status, body, outcome, records] = await sent(
        (context: Context) => {
          const source = new Readable({
            read(): void {
              // Never read
            },
          });
          source.destroy(failure);
          // Its error is in place: no `error` listener before the guard's
          source.on("error", () => null);
          source.on("newListener", (event: string) => {
            if (event === "error") {
              throw failure;
            }
          });
          if (ended) {
            // Its `errored`, read once by the send, ends the response first
            Object.defineProperty(source, "errored", {
              get(): Error {
                context.response.end("ended");
                return failure;
              },
            });
          }
          return source;
        },
      );
      deepStrictEqual(
        [status, body, outcome, records],
        ended
          ? [
              200,
              "ended",
              "resolved",
              [`A released stream has failed: ${failure.message}`],
            ]
          : [500, "", failure, [`The request has failed: ${failure.message}`]],
      );
    }
  });
});
