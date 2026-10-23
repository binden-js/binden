import { emitterMethods, guard } from "../src/stream-like.js";
import { suite, test } from "node:test";
import { EventEmitter } from "node:events";
import { deepStrictEqual } from "node:assert/strict";
import { ioTurn } from "./helpers.js";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Runs a fixture (`test/fixtures`) in a process of its own, without a handler
 * of the process, with these flags of Node.js: a crash (e.g. an unhandled
 * `error` event) is its exit code and output, not a failure of the test
 * runner
 */
function fixture(name: string, ...flags: string[]): Record<string, unknown> {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [
      ...flags,
      "--no-warnings",
      "--import",
      "tsx",
      join(import.meta.dirname, "fixtures", name),
    ],
    { encoding: "utf8", timeout: 40_000 },
  );
  return { status, stdout, stderr };
}

/** The listeners of `error` and `close` of a source */
function counts(source: EventEmitter): number[] {
  return [source.listenerCount("error"), source.listenerCount("close")];
}

suite(
  "The guard of a source whose state cannot tell that it has closed",
  () => {
    test("stays once it has closed (also installed once closed), and reports each later error once; it leaves on the turn after a close that its state tells", async () => {
      const reported: unknown[] = [];
      const report = (error: unknown): void => {
        reported.push((error as Error).message);
      };
      // An emitter, without the state of a stream
      const source = new EventEmitter();
      guard(source, emitterMethods, report);
      source.emit("close");
      await ioTurn();
      const later = new Error("After its close");
      source.emit("error", later);
      // The same error once more (e.g. of a second destroy): not again
      source.emit("error", later);
      source.emit("error", new Error("Another"));
      // A second close does not remove it either
      source.emit("close");
      await ioTurn();
      const kept = counts(source);
      // Installed by a send that has seen its close (`closed`)
      const closed = new EventEmitter();
      guard(closed, emitterMethods, report, true);
      await ioTurn();
      const installed = counts(closed);
      // Its state tells it now
      Object.assign(source, { _readableState: { closeEmitted: true } });
      source.emit("close");
      deepStrictEqual(counts(source), [1, 1]);
      await ioTurn();
      deepStrictEqual(
        [kept, installed, counts(source), reported],
        [
          [1, 1],
          [1, 1],
          [0, 0],
          ["After its close", "Another"],
        ],
      );
    });

    test("a later error of a source of readable-stream 2 or 3, through2 4, or an emitter of its own, once binden has cancelled, released or failed it, is logged once and does not crash the process", () => {
      // Without a listener of the application: a feed written by a timer of the
      // application once cancelled (by the deadline, or the client gone away),
      // an emitter that emits an error after its close, and sources that
      // refuse a listener of the send, then are destroyed with an error
      const lines = [
        // Committed by its first event: cut at the deadline
        "/through2-deadline 200",
        "/through2-gone 200",
        "/v2-gone 200",
        "/v3-gone 200",
        "/custom-0 500",
        "/custom-20 500",
        "/refused-end 500",
        "/refused-data 500",
      ].map((line) => `${line} later=true each logged once guard=1/1\n`);
      deepStrictEqual(fixture("kept-guards.ts"), {
        status: 0,
        stdout: lines.join(""),
        stderr: "",
      });
    });

    test("holds nothing but the report of a late error: the responses are collected", () => {
      // 200 `PassThrough`s of readable-stream 3 and 200 emitters whose destroy
      // emits `close`, cancelled at the deadline: each closed, without a
      // listener of its send, with its guard
      deepStrictEqual(fixture("kept-guard-retention.ts", "--expose-gc"), {
        status: 0,
        stdout: "collected 400 0 0 400 400\n",
        stderr: "",
      });
    });
  },
);
