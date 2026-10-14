import { deepStrictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { suite, test } from "node:test";

/**
 * Runs a fixture (`test/fixtures`) in a process of its own: a crash (e.g. an
 * unhandled `error` event) is its exit code and output, not a failure of the
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

suite("Process safety", () => {
  test("a discarded source that fails to close does not crash the process", () => {
    deepStrictEqual(run("discarded-source.ts"), {
      status: 0,
      stdout: "200 204 200\n",
      stderr: "",
    });
  });

  test("the error serializer ends on a chain of prototypes that does not", () => {
    deepStrictEqual(run("cyclic-prototype.ts"), {
      status: 0,
      stdout: `[{"type":"object"},{"type":"object"}]\n`,
      stderr: "",
    });
  });

  test("a logger whose `child()` throws does not crash the process", () => {
    deepStrictEqual(run("throwing-logger.ts"), {
      status: 0,
      stdout: "200 ok true\n",
      stderr: "",
    });
  });
});
