import { Binden, type Context, releasedFailure } from "../index.js";
import { type ICaptured, capture, ioTurn, listen, within } from "./helpers.js";
import { converse, get } from "./connection.js";
import {
  decided,
  emitterMethods,
  guard,
  readStreamLike,
  reportLate,
  streamLikeOf,
} from "../src/stream-like.js";
import { deepStrictEqual, ok } from "node:assert/strict";
import { suite, test } from "node:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

/** The message of each late error of a source logged so far */
function reported(captured: ICaptured): unknown[] {
  return captured.records
    .filter(({ msg }) => msg === releasedFailure)
    .map(({ failure }) => (failure as { message?: unknown }).message);
}

/** A `Readable` that is never read (its data is pushed by the test) */
function readable(): Readable {
  return new Readable({
    read(): void {
      // Pushed by the test, if at all
    },
  });
}

/**
 * Runs `scenario` as the middleware of `/` (`/next` replies `next`), with
 * `/` and `/next` pipelined on one connection: what the client receives, how
 * the scenario has settled, and the logger, once the reply of `/next` has
 * come and the pending I/O has run (see `ioTurn()`)
 */
async function run(
  scenario: (context: Context) => Promise<unknown>,
): Promise<[string, unknown, ICaptured]> {
  const captured = capture();
  const outcome = Promise.withResolvers<unknown>();
  const app = new Binden({
    logger: captured.logger,
    log_error_details: true,
  }).use(async (context: Context) => {
    if (context.url.pathname === "/next") {
      await context.text("next");
    } else {
      outcome.resolve(await scenario(context));
    }
  });
  const listening = await listen(app);
  try {
    const { received } = await converse(
      listening.port,
      `${get("/")}${get("/next")}`,
      { complete: (text) => text.endsWith("\r\n\r\nnext") },
    );
    const settled = await within(outcome.promise);
    await ioTurn();
    return [received.replaceAll(/\r\nDate: [^\r]*/gu, ""), settled, captured];
  } finally {
    await listening.close();
  }
}

/** How a send has settled: `resolved`, or the message of what it has rejected with */
function outcomeOf(promise: Promise<void>): Promise<unknown> {
  return promise.then(
    () => "resolved",
    (error: unknown) => (error as Error).message,
  );
}

suite("A late error of a source is reported once", () => {
  test("by its guard, then by its send (reportLate()): once", () => {
    const reports: unknown[] = [];
    const report = (error: unknown): void => {
      reports.push(error);
    };
    const source = new EventEmitter();
    const failure = new Error("The source has failed");
    guard(source, emitterMethods, report);
    source.emit("error", failure);
    reportLate(source, failure, false, report);
    deepStrictEqual(reports, [failure]);
  });

  test("by its send (reportLate()), then by its guard once the source emits it: once", () => {
    const reports: unknown[] = [];
    const report = (error: unknown): void => {
      reports.push(error);
    };
    const source = new EventEmitter();
    const failure = new Error("The source has failed");
    guard(source, emitterMethods, report);
    reportLate(source, failure, false, report);
    source.emit("error", failure);
    // Again (e.g. a source that emits its error twice)
    source.emit("error", failure);
    deepStrictEqual(reports, [failure]);
  });

  test("never once it has decided a send, by its send nor by its guard", () => {
    const reports: unknown[] = [];
    const report = (error: unknown): void => {
      reports.push(error);
    };
    const source = new EventEmitter();
    const failure = new Error("The body is too long");
    decided(failure);
    guard(source, emitterMethods, report);
    reportLate(source, failure, false, report);
    source.emit("error", failure);
    deepStrictEqual(reports, []);
  });

  test("once for each source that has failed with it", () => {
    const reports: unknown[] = [];
    const sources = [new EventEmitter(), new EventEmitter()];
    const failure = new Error("Shared");
    for (const source of sources) {
      guard(source, emitterMethods, (error) => {
        reports.push([source, error]);
      });
      source.emit("error", failure);
      reportLate(source, failure, false, (error) => {
        reports.push([source, error]);
      });
    }
    deepStrictEqual(reports, [
      [sources[0], failure],
      [sources[1], failure],
    ]);
  });

  test("a value that is not an object (which cannot be recorded) is reported each time", () => {
    const reports: unknown[] = [];
    const report = (error: unknown): void => {
      reports.push(error);
    };
    const source = new EventEmitter();
    guard(source, emitterMethods, report);
    reportLate(source, "failed", false, report);
    source.emit("error", "failed");
    deepStrictEqual(reports, ["failed", "failed"]);
  });

  test("by a stream-like source read once it has ended, which emits it again once its listeners are removed: once", async () => {
    const reports: unknown[] = [];
    const report = (error: unknown): void => {
      reports.push(error);
    };
    const source = Object.assign(new EventEmitter(), {
      pause(): void {
        // Never full
      },
      resume(): void {
        // Emits by the test
      },
    });
    const methods = streamLikeOf(source);
    ok(methods !== null);
    const read = readStreamLike(
      source,
      methods,
      () => new Error("Cancelled"),
      report,
    );
    read.resume();
    const failure = new Error("Failed after its end");
    source.emit("end");
    // Heard by its send until the next turn, then by its guard only
    source.emit("error", failure);
    await ioTurn();
    source.emit("error", failure);
    deepStrictEqual(reports, [failure]);
  });
});

suite("A late error of a source sent once its response has ended", () => {
  test("destroyed with an error before its send, which code of the source ends while it is checked: logged once, whatever reports it (R19-C3)", async () => {
    const failure = new Error("The source has failed before its send");
    const [received, outcome, captured] = await run(async (context) => {
      const source = readable();
      source.destroy(failure);
      // A getter of its own that ends the response once `send()` reads it:
      // its error is emitted after the send has settled
      Object.defineProperty(source, "destroyed", {
        get(): boolean {
          context.response.end("complete");
          return true;
        },
      });
      return outcomeOf(context.send(source));
    });
    deepStrictEqual(
      [
        received.match(/\r\n\r\n(?:complete|next)/gu),
        outcome,
        reported(captured),
      ],
      [
        ["\r\n\r\ncomplete", "\r\n\r\nnext"],
        "resolved",
        ["The source has failed before its send"],
      ],
    );
  });

  test("destroyed with the error of a send that it has decided, which code of the source ends while a second send checks it: never logged (R19-C3)", async () => {
    const [received, outcome, captured] = await run(async (context) => {
      const { response } = context;
      const source = readable();
      response.setHeader("Content-Length", 1);
      source.push("too long");
      // Its body is longer than its `Content-Length`: it decides the send,
      // which destroys the source with it
      const first = await outcomeOf(context.send(source));
      Object.defineProperty(source, "destroyed", {
        get(): boolean {
          response.end("complete");
          return true;
        },
      });
      return [first, await outcomeOf(context.send(source))];
    });
    deepStrictEqual(
      [
        received.match(/\r\n\r\n(?:8\r\ncomplete|next)/gu),
        outcome,
        reported(captured),
      ],
      [
        ["\r\n\r\n8\r\ncomplete", "\r\n\r\nnext"],
        [
          "The body (8 bytes) does not match its Content-Length (1 bytes)",
          "resolved",
        ],
        [],
      ],
    );
  });

  test("a source destroyed with an error before its send, which rejects with it: never logged", async () => {
    const failure = new Error("The source has failed before its send");
    const [received, outcome, captured] = await run(async (context) => {
      const source = readable();
      source.destroy(failure);
      const sent = await outcomeOf(context.send(source));
      await context.text("replied");
      return sent;
    });
    deepStrictEqual(
      [
        received.match(/\r\n\r\n(?:replied|next)/gu),
        outcome,
        reported(captured),
      ],
      [
        ["\r\n\r\nreplied", "\r\n\r\nnext"],
        "The source has failed before its send",
        [],
      ],
    );
  });
});
