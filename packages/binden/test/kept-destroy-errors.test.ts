import {
  type IStreamLikeMethods,
  readStreamLike,
  streamLikeOf,
} from "../src/stream-like.js";
import { suite, test } from "node:test";
import { EventEmitter } from "node:events";
import { deepStrictEqual } from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Runs the fixture of a source that keeps its destroy error in a process of
 * its own, whose collections the test controls (`--expose-gc`)
 */
function kept(how: string): {
  status: number | null;
  stderr: string;
  result: Record<string, unknown>;
} {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [
      "--expose-gc",
      "--no-warnings",
      "--import",
      "tsx",
      join(import.meta.dirname, "fixtures", "kept-destroy-errors.ts"),
      how,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  return {
    status,
    stderr,
    result: JSON.parse(stdout === "" ? "{}" : stdout) as Record<
      string,
      unknown
    >,
  };
}

/** A stream-like source of its own, which records the arguments of each destroy */
class Source extends EventEmitter {
  public readonly destroys: unknown[][] = [];

  public pause(): this {
    return this;
  }

  public resume(): this {
    return this;
  }

  public destroy(...args: unknown[]): this {
    this.destroys.push(args);
    return this;
  }
}

suite(
  "A stream-like source that keeps the error that it is destroyed with (as minipass 7 keeps the error that it emits), which the application keeps",
  () => {
    for (const [how, when] of [
      ["gone", "once the client has gone away"],
      ["deadline", "at the deadline"],
      ["writer", "once another writer has ended the response"],
    ] as const) {
      test(`released ${when}: keeps neither the request nor the response (R2 R21-H1)`, () => {
        const { status, stderr, result } = kept(how);
        const { alive, settled, sources } = result;
        deepStrictEqual(
          { status, stderr, alive, settled, sources },
          { status: 0, stderr: "", alive: 0, settled: 30, sources: 30 },
        );
        if (how !== "writer") {
          // Destroyed with the reason of the cancellation, which it keeps
          deepStrictEqual(result.kept, 30);
        }
      });
    }
  },
);

suite(
  "A readable of a stream-like source released with a reason whose stack cannot be read (a getter of its own that throws)",
  () => {
    test("destroys the source with that reason as it is, and calls back without an error", () => {
      const reason = new Error("Cancelled");
      Object.defineProperty(reason, "stack", {
        get(): never {
          throw new Error("No stack");
        },
      });
      const source = new Source();
      const readable = readStreamLike(
        source,
        streamLikeOf(source) as IStreamLikeMethods,
        () => reason,
        () => null,
      ).on("error", () => null);
      readable.destroy();
      deepStrictEqual([readable.errored, source.destroys], [null, [[reason]]]);
    });
  },
);
