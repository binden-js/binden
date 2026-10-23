import { Binden, type Context, releasedFailure } from "../index.js";
import { HOST, capture, ioTurn, listen, pollUntil, within } from "./helpers.js";
import {
  type IStreamLikeMethods,
  readStreamLike,
  streamLikeOf,
} from "../src/stream-like.js";
import { suite, test } from "node:test";
import { EventEmitter } from "node:events";
import { connect } from "node:net";
import { deepStrictEqual } from "node:assert/strict";

/** A stream-like source of its own */
class Source extends EventEmitter {
  public pause(): this {
    return this;
  }

  public resume(): this {
    return this;
  }
}

/**
 * A source whose own `on()` emits an error at once when the second listener
 * of its `error` is added (the one of its guard, once the send settles)
 */
class Emitting extends Source {
  #errors = 0;

  public override on(
    event: string,
    listener: (...args: unknown[]) => void,
  ): this {
    if (event === "error") {
      this.#errors += 1;
      if (this.#errors === 2) {
        this.emit("error", new Error("Emitted while guarded"));
      }
    }
    return super.on(event, listener);
  }
}

/** The methods of a stream-like source (see `streamLikeOf()`) */
function methodsOf(source: object): IStreamLikeMethods {
  return streamLikeOf(source) as IStreamLikeMethods;
}

/** The messages of the late errors that a report has been given */
function reporter(): [string[], (error: unknown) => void] {
  const reported: string[] = [];
  return [
    reported,
    (error): void => {
      reported.push((error as Error).message);
    },
  ];
}

/** Sends `GET /` then `GET /next` on one connection, and reads until it closes */
async function pipelined(port: number): Promise<string> {
  const socket = connect(port, HOST);
  let received = "";
  socket.setEncoding("latin1").on("data", (chunk: string) => {
    received += chunk;
  });
  socket.on("error", () => null);
  socket.write(
    "GET / HTTP/1.1\r\nHost: a\r\n\r\nGET /next HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n",
  );
  const closed = new Promise((resolve) => {
    socket.once("close", resolve);
  });
  try {
    await within(closed);
  } finally {
    socket.destroy();
  }
  return received;
}

suite(
  "A stream-like source whose code emits an error while its guard is installed",
  () => {
    test("once it has ended: the readable ends, and that error is reported once as a late error, never by the settled send", async () => {
      const [reported, report] = reporter();
      const source = new Emitting();
      const readable = readStreamLike(
        source,
        methodsOf(source),
        () => new Error("Cancelled"),
        report,
      );
      const outcome = new Promise((resolve) => {
        readable.once("end", () => {
          resolve("ended");
        });
        readable.once("error", (error: Error) => {
          resolve(error.message);
        });
      });
      readable.resume();
      source.emit("data", "ok");
      source.emit("end");
      deepStrictEqual(await within(outcome), "ended");
      await ioTurn();
      deepStrictEqual(reported, ["Emitted while guarded"]);
    });

    test("once cancelled: that error is reported once as a late error", async () => {
      const [reported, report] = reporter();
      const source = Object.assign(new Emitting(), {
        destroy: (): null => null,
      });
      const readable = readStreamLike(
        source,
        methodsOf(source),
        () => new Error("Cancelled"),
        report,
      );
      readable.on("error", () => null).destroy(new Error("Cancelled"));
      await ioTurn();
      deepStrictEqual(reported, ["Emitted while guarded"]);
    });

    test("sent whole: the reply is complete, the next one on the connection is sent, and that error is logged once", async () => {
      const captured = capture();
      const outcomes: string[] = [];
      const app = new Binden({
        logger: captured.logger,
        log_error_details: true,
      })
        .use("/next", (context: Context) => context.send("next"))
        .use(async (context: Context) => {
          const source = new Emitting();
          setImmediate(() => {
            source.emit("data", "ok");
            source.emit("end");
          });
          const sent = context.send(source);
          outcomes.push(
            await sent.then(
              () => "resolved",
              (error: unknown) => `rejected ${(error as Error).message}`,
            ),
          );
        });
      const listening = await listen(app);
      try {
        const received = await pipelined(listening.port);
        deepStrictEqual(
          [
            received.match(/HTTP\/1\.1 \d{3}/gu),
            received.includes("\r\n2\r\nok\r\n0\r\n\r\n"),
            received.endsWith("next"),
          ],
          [["HTTP/1.1 200", "HTTP/1.1 200"], true, true],
        );
        await pollUntil(() => outcomes.length === 1);
        await ioTurn();
        deepStrictEqual(
          [
            outcomes,
            captured.records
              .filter(({ msg }) => msg === releasedFailure)
              .map(({ failure }) => (failure as { message?: unknown }).message),
          ],
          [["resolved"], ["Emitted while guarded"]],
        );
      } finally {
        await listening.close();
      }
    });
  },
);

suite(
  "A stream-like source whose removal of the listener of `error` of the send throws",
  () => {
    for (const removes of [true, false]) {
      test(`${removes ? "once it has removed it" : "before it has removed it"}: the send no longer hears it, and a later error is reported once`, async () => {
        const [reported, report] = reporter();
        const source = Object.assign(new Source(), {
          removeListener(event: string, listener: () => void): Source {
            if (event === "error") {
              if (removes) {
                EventEmitter.prototype.removeListener.call(
                  source,
                  event,
                  listener,
                );
              }
              throw new Error("Removal failed");
            }
            EventEmitter.prototype.removeListener.call(source, event, listener);
            return source;
          },
        });
        const readable = readStreamLike(
          source,
          methodsOf(source),
          () => new Error("Cancelled"),
          report,
        );
        readable.resume();
        source.emit("end");
        // Once its listener of `error` is removed, on the next turn
        await ioTurn();
        source.emit("error", new Error("Later"));
        // Reported on a later turn
        await ioTurn();
        deepStrictEqual(
          [reported, source.listenerCount("error")],
          // Its guard, and the listener of the send that is left
          [["Removal failed", "Later"], removes ? 1 : 2],
        );
      });
    }
  },
);
