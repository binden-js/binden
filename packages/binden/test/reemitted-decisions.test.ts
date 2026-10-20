import { Binden, type Context, releasedFailure } from "../index.js";
import { type ICaptured, capture, ioTurn, listen, send } from "./helpers.js";
import {
  type IStreamLikeMethods,
  readStreamLike,
  streamLikeOf,
} from "../src/stream-like.js";
import { suite, test } from "node:test";
import { EventEmitter } from "node:events";
import { deepStrictEqual } from "node:assert/strict";

/** The message of each late error logged so far */
function lateOf(captured: ICaptured): unknown[] {
  return captured.records
    .filter(({ msg }) => msg === releasedFailure)
    .map(({ failure }) => (failure as { message?: unknown }).message);
}

/**
 * A stream-like source that fails without being destroyed, and whose release
 * (its `destroy()`, or its `pause()` without one) emits these errors at once
 */
function reemitting(
  release: "destroy" | "pause",
  emitted: () => readonly Error[],
): EventEmitter {
  const source = new EventEmitter();
  let released = false;
  const emit = (): void => {
    if (!released) {
      released = true;
      for (const error of emitted()) {
        source.emit("error", error);
      }
    }
  };
  return Object.assign(source, {
    pause: release === "pause" ? emit : (): null => null,
    resume: (): null => null,
    ...(release === "destroy" ? { destroy: emit } : {}),
  });
}

suite(
  "A stream-like source whose release emits the error that has failed its send again",
  () => {
    for (const release of ["destroy", "pause"] as const) {
      test(`(its ${release}()): that error is not reported, another one that it emits then is, once (R22-C1)`, async () => {
        const failure = new Error("The source has failed");
        const another = new Error("Another");
        const reported: unknown[] = [];
        const source = reemitting(release, () => [failure, another, failure]);
        const readable = readStreamLike(
          source,
          streamLikeOf(source) as IStreamLikeMethods,
          () => new Error("Cancelled"),
          (error) => reported.push(error),
        );
        const errors: unknown[] = [];
        readable.on("error", (error) => errors.push(error));
        // Nothing reads the readable: no send decides the error for the
        // source
        source.emit("error", failure);
        await ioTurn();
        deepStrictEqual([errors, reported], [[failure], [another]]);
      });
    }

    for (const ended of [false, true]) {
      test(`sent${ended ? ", once another writer has ended the response" : ""}: ${ended ? "the send resolves, and that error is logged once" : "the send rejects with it, which is not logged"}`, async () => {
        const captured = capture();
        const failure = new Error("The source has failed");
        const outcomes: unknown[] = [];
        const app = new Binden({
          logger: captured.logger,
          log_error_details: true,
        }).use(async (context: Context) => {
          const source = reemitting("destroy", () => [failure]);
          // @ts-expect-error -- a stream-like source
          const sent = context.send(source).then(
            () => "resolved",
            (error: unknown) => (error as Error).message,
          );
          if (ended) {
            context.response.end("complete");
          }
          source.emit("error", failure);
          outcomes.push(await sent);
          if (!context.response.writableEnded) {
            await context.response.status(500).send("failed");
          }
        });
        const listening = await listen(app);
        try {
          const { status, body } = await send(listening.port);
          await ioTurn();
          deepStrictEqual(
            [status, body, outcomes, lateOf(captured)],
            ended
              ? [200, "complete", ["resolved"], [failure.message]]
              : [500, "failed", [failure.message], []],
          );
        } finally {
          await listening.close();
        }
      });
    }
  },
);
