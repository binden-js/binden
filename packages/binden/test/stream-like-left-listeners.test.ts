import { EventEmitter, once } from "node:events";
import {
  type IStreamLikeMethods,
  readStreamLike,
  streamLikeOf,
} from "../src/stream-like.js";
import { ioTurn, within } from "./helpers.js";
import { suite, test } from "node:test";
import { deepStrictEqual } from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Runs a fixture (`test/fixtures`) in a process of its own, with `--expose-gc`
 * and arguments
 */
function fixture(name: string, ...args: string[]): Record<string, unknown> {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--expose-gc",
      "--import",
      "tsx",
      join(import.meta.dirname, "fixtures", name),
      ...args,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  return { status, stdout, stderr };
}

suite(
  "The listeners of a send that a removal that throws leaves on a stream-like source (Codex R23, 8b)",
  () => {
    test("of its data, its end or its close, on sources that the application keeps: the responses are collected", () => {
      for (const [event, left] of [
        ["data", 200],
        ["end", 200],
        // And the one of its guard
        ["close", 400],
      ] as const) {
        deepStrictEqual(
          fixture("left-listeners.ts", event),
          { status: 0, stdout: `collected ${left}\n`, stderr: "" },
          event,
        );
      }
    });

    test("of its data: one that the source emits once it has ended changes nothing (the source is not paused)", async () => {
      let pauses = 0;
      const source = Object.assign(new EventEmitter(), {
        pause(): void {
          pauses += 1;
        },
        resume(): void {
          // Flows
        },
        removeListener(event: string, listener: () => void): void {
          if (event === "data") {
            throw new Error("The listener cannot be removed");
          }
          EventEmitter.prototype.removeListener.call(source, event, listener);
        },
      });
      const readable = readStreamLike(
        source,
        streamLikeOf(source) as IStreamLikeMethods,
        () => new Error("Cancelled"),
        () => null,
      );
      const closed = once(readable, "close");
      readable.resume();
      source.emit("data", Buffer.from("ok"));
      source.emit("end");
      await within(closed);
      // Left on the source
      source.emit("data", Buffer.from("late"));
      await ioTurn();
      deepStrictEqual(
        [source.listenerCount("data"), pauses, readable.errored],
        [1, 0, null],
      );
    });
  },
);
