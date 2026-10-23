import { suite, test } from "node:test";
import { deepStrictEqual } from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Runs a fixture (`test/fixtures`) in a process of its own, with these flags
 * of Node.js, without a handler of the process
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

suite("The readable of a stream-like source, once destroyed", () => {
  test("holds nothing of its response (its cancellation reason, its logs): what keeps it and its source, e.g. a pending report of a late error, keeps nothing of the response (R2's note)", () => {
    deepStrictEqual(fixture("released-readables.ts", "--expose-gc"), {
      status: 0,
      stdout:
        "cancelled true collected 1\n" +
        "failed true collected 1\n" +
        "ended true collected 1\n",
      stderr: "",
    });
  });
});
