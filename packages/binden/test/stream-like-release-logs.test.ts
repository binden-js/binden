import { Binden, type Context } from "../index.js";
import { capture, ioTurn, listen, send } from "./helpers.js";
import { suite, test } from "node:test";
import { EventEmitter } from "node:events";
import { deepStrictEqual } from "node:assert/strict";

/** A stream-like source: an emitter with `pause()` and `resume()` */
class Source extends EventEmitter {
  public pause(): this {
    return this;
  }

  public resume(): this {
    return this;
  }
}

/**
 * Sends a stream-like source (made for the context, with `timeout` ms of
 * deadline, `0` for none) to a method: the status that the client gets, and
 * each record of a release of a stream (`<message>: <message of its
 * failure>`)
 */
async function released(
  source: (context: Context) => Source,
  { method = "GET", timeout = 0 } = {},
): Promise<[number, string[]]> {
  const captured = capture();
  const listening = await listen(
    new Binden({
      logger: captured.logger,
      log_error_details: true,
      timeout,
    }).use(async (context: Context) => {
      await context.send(source(context));
    }),
  );
  try {
    const { status } = await send(listening.port, { method });
    // Any later record (e.g. of the deferred removal of a listener)
    await ioTurn();
    const records = captured.records
      .filter(({ msg }) =>
        [
          "The release of a stream has failed",
          "The removal of a listener of a stream has failed",
          "A released stream has failed",
        ].includes(String(msg)),
      )
      .map(
        ({ msg, failure }) =>
          `${String(msg)}: ${String((failure as { message?: unknown }).message)}`,
      );
    return [status, records];
  } finally {
    await listening.close();
  }
}

suite(
  "Code of a stream-like source that throws while send() releases it",
  () => {
    test("a refusal of its guard is logged as the release of a Node.js `Readable` that has failed, not as a late error", async () => {
      for (const method of ["HEAD", "GET"]) {
        const [status, records] = await released(
          () => {
            const source = new Source();
            source.on("newListener", (event: string) => {
              if (event === "error") {
                throw new Error(`No listener of error (${method})`);
              }
            });
            return source;
          },
          { method },
        );
        // To `HEAD`, released without being read; to `GET`, the listener
        // of its send is refused as well (the send rejects with it)
        deepStrictEqual(
          [status, records],
          [
            method === "HEAD" ? 200 : 500,
            [
              `The release of a stream has failed: No listener of error (${method})`,
            ],
          ],
        );
      }
    });

    test("a removal of a listener of the send that throws is logged as for a Node.js `Readable`, not as a late error", async () => {
      const [status, records] = await released(() => {
        const source = new Source();
        Object.assign(source, {
          removeListener(event: string, listener: () => void): Source {
            if (event === "end") {
              throw new Error("No removal of end");
            }
            EventEmitter.prototype.removeListener.call(source, event, listener);
            return source;
          },
        });
        setImmediate(() => {
          source.emit("data", "ok");
          source.emit("end");
        });
        return source;
      });
      deepStrictEqual(
        [status, records],
        [
          200,
          [
            "The removal of a listener of a stream has failed: No removal of end",
          ],
        ],
      );
    });

    test("a pause() that throws once it is cancelled (without destroy()) is logged as the release of a Node.js `Readable` that has failed, not as a late error", async () => {
      const [status, records] = await released(
        () => {
          let pauses = 0;
          const source = new Source();
          Object.assign(source, {
            pause(): never {
              pauses += 1;
              throw new Error(`Its pause #${String(pauses)} has failed`);
            },
          });
          return source;
        },
        { timeout: 50 },
      );
      deepStrictEqual(
        [status, records],
        [503, ["The release of a stream has failed: Its pause #1 has failed"]],
      );
    });
  },
);
