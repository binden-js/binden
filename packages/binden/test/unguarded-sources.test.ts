import {
  type IStreamLikeMethods,
  readStreamLike,
  releaseStreamLike,
  streamLikeOf,
} from "../src/stream-like.js";
import { suite, test } from "node:test";
import { EventEmitter } from "node:events";
import { deepStrictEqual } from "node:assert/strict";
import { ioTurn } from "./helpers.js";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Runs a fixture (`test/fixtures`) in a process of its own, without a handler
 * of the process: a crash (e.g. an unhandled `error` event) is its exit code
 * and output, not a failure of the test runner
 */
function fixture(name: string): Record<string, unknown> {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--import",
      "tsx",
      join(import.meta.dirname, "fixtures", name),
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  return { status, stdout, stderr };
}

/** A stream-like source whose calls are recorded */
class Recorded extends EventEmitter {
  public readonly calls: string[] = [];

  public pause(): this {
    this.calls.push("pause");
    return this;
  }

  public resume(): this {
    this.calls.push("resume");
    return this;
  }

  public destroy(): this {
    this.calls.push("destroy");
    return this;
  }
}

/**
 * A source that refuses every listener of `error`: its own `on()` throws,
 * after it has added the first one (`added`), or before
 */
function refusing(added: boolean): Recorded {
  const source = new Recorded();
  let errors = 0;
  return Object.assign(source, {
    on(event: string, listener: () => void): Recorded {
      if (event === "error") {
        errors += 1;
        if (added && errors === 1) {
          EventEmitter.prototype.on.call(source, event, listener);
        }
        throw new Error(`No listener of error #${errors}`);
      }
      EventEmitter.prototype.on.call(source, event, listener);
      return source;
    },
  });
}

/** The methods of a stream-like source (see `streamLikeOf()`) */
function methodsOf(source: object): IStreamLikeMethods {
  return streamLikeOf(source) as IStreamLikeMethods;
}

suite("A stream-like source without a listener of `error` in place", () => {
  for (const added of [false, true]) {
    test(`sent, that refuses every one${added ? " (its on() has added the first, then thrown)" : ""}: left untouched, neither paused nor destroyed, and told`, async () => {
      const source = refusing(added);
      const told: string[] = [];
      const reports: unknown[] = [];
      const readable = readStreamLike(
        source,
        methodsOf(source),
        () => new Error("Cancelled"),
        (error) => reports.push((error as Error).message),
        () => told.push("unreleased"),
      );
      const failure = await new Promise((resolve) => {
        readable.once("error", resolve);
      });
      await ioTurn();
      deepStrictEqual(
        [
          (failure as Error).message,
          source.calls,
          told,
          reports,
          source.eventNames(),
        ],
        [
          "No listener of error #1",
          [],
          ["unreleased"],
          ["No listener of error #2"],
          [],
        ],
      );
    });
  }

  test("released, that refuses its guard: left untouched, without destroy() too, and told", () => {
    const told: string[] = [];
    for (const withDestroy of [true, false]) {
      const source = refusing(false);
      if (!withDestroy) {
        Object.assign(source, { destroy: null });
      }
      releaseStreamLike(
        source,
        methodsOf(source),
        () => null,
        () => told.push(`unreleased (${String(withDestroy)})`),
      );
      deepStrictEqual(source.calls, []);
    }
    deepStrictEqual(told, ["unreleased (true)", "unreleased (false)"]);
  });

  test("whose pause() and destroy() would fail asynchronously: sent or released (to HEAD, with 204, or for 103), it is never paused nor destroyed, and the process does not crash", () => {
    deepStrictEqual(fixture("unguarded-sources.ts"), {
      status: 0,
      stdout:
        "GET / 500 rejected:No listener of error\n" +
        "HEAD / 200 resolved\n" +
        "GET /204 204 resolved\n" +
        "GET /103 500 rejected:Status code 103 is informational (use writeEarlyHints())\n" +
        "calls=none left=4\n",
      stderr: "",
    });
  });
});
