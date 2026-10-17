import { Binden, type Context } from "../index.js";
import { capture, ioTurn, listen, send, within } from "./helpers.js";
import { emitterMethods, guard, reportLate } from "../src/stream-like.js";
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

/**
 * A `Readable` that never ends (`body`: pushed once read, then its end),
 * whose destroy never completes: it never closes, so that a guard stays on
 * it, and a later error of it is heard by the listeners that it still has
 */
function lasting(body: string | null = null): Readable {
  return new Readable({
    autoDestroy: false,
    read(): void {
      if (body !== null) {
        this.push(body);
        this.push(null);
      }
    },
    destroy(): void {
      // Never completes
    },
  });
}

/** The messages of the late errors that have been logged */
function late(records: Record<string, unknown>[]): unknown[] {
  return records
    .filter(({ msg }) => msg === "A released stream has failed")
    .map(({ failure }) => (failure as { message?: unknown }).message);
}

suite("The listener of `error` of a send of a Node.js `Readable`", () => {
  test("counts as hearing it: an error that fails the send is not reported by a guard that listens before (e.g. of another response that has released it), and a later one is, once the send has settled", async () => {
    const source = lasting();
    const reports: unknown[] = [];
    // The guard of another release, whose listener comes first
    guard(source, emitterMethods, (error: unknown) => {
      reports.push((error as Error).message);
    });
    const captured = capture();
    const outcomes: string[] = [];
    const listening = await listen(
      new Binden({ logger: captured.logger, log_error_details: true }).use(
        async (context: Context) => {
          const sent = context.send(source);
          setImmediate(() => {
            source.emit("error", new Error("Heard by the send"));
          });
          outcomes.push(await outcomeOf(sent));
          throw new Error("Replied");
        },
      ),
    );
    try {
      const { status } = await send(listening.port);
      // Once the send has settled: the guard reports it, once
      source.emit("error", new Error("Later"));
      await ioTurn();
      deepStrictEqual(
        [status, outcomes, reports, late(captured.records)],
        [500, ["rejected:Heard by the send"], ["Later"], []],
      );
    } finally {
      await listening.close();
    }
  });

  test("an error that fails the send has decided it: a guard that listens after the send does not report it either", async () => {
    const source = lasting();
    const reports: unknown[] = [];
    const captured = capture();
    const outcomes: string[] = [];
    const listening = await listen(
      new Binden({ logger: captured.logger, log_error_details: true }).use(
        async (context: Context) => {
          const sent = context.send(source);
          // The guard of another release, whose listener comes after the
          // one of the send: the send settles (and no longer hears the
          // source) before the guard gets the error
          guard(source, emitterMethods, (error: unknown) => {
            reports.push((error as Error).message);
          });
          source.emit("error", new Error("Decided"));
          outcomes.push(await outcomeOf(sent));
          throw new Error("Replied");
        },
      ),
    );
    try {
      const { status } = await send(listening.port);
      await ioTurn();
      deepStrictEqual(
        [status, outcomes, reports, late(captured.records)],
        [500, ["rejected:Decided"], [], []],
      );
    } finally {
      await listening.close();
    }
  });

  test("of a send stopped by another writer reports an error that the source emits once, although a guard listens before", async () => {
    const source = lasting();
    const reports: unknown[] = [];
    guard(source, emitterMethods, (error: unknown) => {
      reports.push((error as Error).message);
    });
    const captured = capture();
    const outcomes: string[] = [];
    const listening = await listen(
      new Binden({ logger: captured.logger, log_error_details: true }).use(
        async (context: Context) => {
          const sent = context.send(source);
          context.response.end("ended");
          // Heard by the send, which no longer fails with it: reported by it
          source.emit("error", new Error("Once the response has ended"));
          outcomes.push(await outcomeOf(sent));
        },
      ),
    );
    try {
      const { status, body } = await send(listening.port);
      await ioTurn();
      deepStrictEqual(
        [status, body, outcomes, reports, late(captured.records)],
        [200, "ended", ["resolved"], [], ["Once the response has ended"]],
      );
    } finally {
      await listening.close();
    }
  });

  test("no longer hears it once its removal has thrown: a later error is reported by its guard", async () => {
    const source = lasting("ok");
    // Removes the listener of `error`, then throws
    const remove = source.removeListener.bind(source);
    Object.assign(source, {
      removeListener(event: string, listener: () => void): Readable {
        remove(event, listener);
        if (event === "error") {
          throw new Error("No removal of error");
        }
        return source;
      },
    });
    const captured = capture();
    const outcomes: string[] = [];
    const listening = await listen(
      new Binden({ logger: captured.logger, log_error_details: true }).use(
        async (context: Context) => {
          outcomes.push(await outcomeOf(context.send(source)));
        },
      ),
    );
    try {
      const { status, body } = await send(listening.port);
      await within(
        new Promise<void>((resolve) => {
          setImmediate(resolve);
        }),
      );
      source.emit("error", new Error("After its removal"));
      await ioTurn();
      deepStrictEqual(
        [
          status,
          body,
          outcomes,
          source.listenerCount("error"),
          late(captured.records),
          captured.records
            .filter(
              ({ msg }) =>
                msg === "The removal of a listener of a stream has failed",
            )
            .map(({ failure }) => (failure as { message?: unknown }).message),
        ],
        [
          200,
          "ok",
          ["resolved"],
          1,
          ["After its removal"],
          ["No removal of error"],
        ],
      );
    } finally {
      await listening.close();
    }
  });
});

suite("A Node.js `Readable` sent to two responses", () => {
  test("whose release by one fails (its `_destroy()`) rejects the send of the other that hears it, and is not logged as a late error", async () => {
    const failure = new Error("The shared source has failed");
    const shared = new Readable({
      read(): void {
        // Never read
      },
      destroy(_error, callback): void {
        process.nextTick(callback, failure);
      },
    });
    const { promise: listened, resolve: listens } =
      Promise.withResolvers<null>();
    const captured = capture();
    const outcomes = new Map<string, string>();
    const listening = await listen(
      new Binden({ logger: captured.logger, log_error_details: true }).use(
        async (context: Context) => {
          const method = String(context.request.method);
          if (method === "GET") {
            const sent = context.send(shared);
            listens(null);
            outcomes.set(method, await outcomeOf(sent));
            throw new Error("Replied");
          }
          // Released to `HEAD` (destroyed under its guard), once the send of
          // `GET` listens
          await listened;
          outcomes.set(method, await outcomeOf(context.send(shared)));
        },
      ),
    );
    try {
      const statuses = await Promise.all([
        send(listening.port).then(({ status }) => status),
        send(listening.port, { method: "HEAD" }).then(({ status }) => status),
      ]);
      await ioTurn();
      deepStrictEqual(
        [statuses, Object.fromEntries(outcomes), late(captured.records)],
        [
          [500, 200],
          { GET: `rejected:${failure.message}`, HEAD: "resolved" },
          [],
        ],
      );
    } finally {
      await listening.close();
    }
  });
});

suite("reportLate() of an error that the source has emitted", () => {
  test("while its guard listens is left to the guard; without a guard it is reported, once", () => {
    const reports: unknown[] = [];
    const report = (error: unknown): void => {
      reports.push((error as Error).message);
    };
    const guarded = new Readable();
    guard(guarded, emitterMethods, () => null);
    reportLate(guarded, new Error("Left to the guard"), true, report);
    const unguarded = new Readable();
    const failure = new Error("Reported");
    reportLate(unguarded, failure, true, report);
    reportLate(unguarded, failure, true, report);
    deepStrictEqual(reports, ["Reported"]);
  });
});
