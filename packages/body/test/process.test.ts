import { deepStrictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { suite, test } from "node:test";

/**
 * Runs a fixture (`test/fixtures`) in a process of its own: a crash (e.g. an
 * unhandled rejection) is its exit code and output, not a failure of the test
 * runner
 */
function run(fixture: string): Record<string, unknown> {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    ["--import", "tsx", join(import.meta.dirname, "fixtures", fixture)],
    { encoding: "utf8", timeout: 30_000 },
  );
  return { status, stdout, stderr };
}

suite("BodyParser (process safety)", () => {
  test("late rejections of `parse` and `type` do not crash the process", () => {
    deepStrictEqual(run("late-rejections.ts"), {
      status: 0,
      stdout: "503 500\n",
      stderr: "",
    });
  });
});
