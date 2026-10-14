import { suite, test } from "node:test";
import { deepStrictEqual } from "node:assert";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Runs a fixture (`test/fixtures`) in a process of its own: a crash (e.g. an
 * `unhandledRejection`) is its exit code and output, not a failure of the
 * test runner
 */
function run(fixture: string): Record<string, unknown> {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    ["--import", "tsx", join(import.meta.dirname, "fixtures", fixture)],
    { encoding: "utf8", timeout: 30_000 },
  );
  return { status, stdout, stderr };
}

suite("Multipart (process safety)", () => {
  test("callbacks that hang or fail once the request is aborted do not crash the process", () => {
    deepStrictEqual(run("late-rejections.ts"), {
      status: 0,
      stdout: "503 503\n",
      stderr: "",
    });
  });
});
