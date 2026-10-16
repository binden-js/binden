import { suite, test } from "node:test";
import { deepStrictEqual } from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Runs the retention fixture in a process of its own, whose collections the
 * test controls (`--expose-gc`): whether the responses of its requests are
 * collected once they have completed
 */
function retained(fixture: string, ...args: string[]): Record<string, unknown> {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [
      "--expose-gc",
      "--no-warnings",
      "--import",
      "tsx",
      join(import.meta.dirname, "fixtures", fixture),
      ...args,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  return { status, stdout, stderr };
}

suite("A completed request", () => {
  test("is not kept by a long timer that a work of it has created", () => {
    deepStrictEqual(retained("retention.ts", "timers", "4000"), {
      status: 0,
      stdout: "collected\n",
      stderr: "",
    });
  });

  test("is not kept by a listener that a work of it has left on a long-lived source", () => {
    deepStrictEqual(retained("retention.ts", "shared", "4000"), {
      status: 0,
      stdout: "collected\n",
      stderr: "",
    });
  });

  test("that waits for the response before it, sealed, is finalized and collected once its client goes away", () => {
    // 100 clients
    deepStrictEqual(retained("queued-replies.ts"), {
      status: 0,
      stdout: "cleanups=100 collected shutdown resolved\n",
      stderr: "",
    });
  });
});
