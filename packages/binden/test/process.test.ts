import { suite, test } from "node:test";
import { deepStrictEqual } from "node:assert";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

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

  test("hung middlewares and error handlers, and their late failures, do not crash the process", () => {
    deepStrictEqual(run("hangs.ts"), {
      status: 0,
      stdout: "503 503 500 500 500\n",
      stderr: "",
    });
  });

  test("a reason phrase or a header that Node.js refuses does not crash the process", () => {
    deepStrictEqual(run("refused-head.ts"), {
      status: 0,
      stdout: "500 Internal Server Error (10)\n",
      stderr: "",
    });
  });

  test(
    "SIGTERM shuts the server down gracefully",
    // Windows has no SIGTERM handler: `kill("SIGTERM")` ends the process at once
    { skip: process.platform === "win32" },
    () => {
      deepStrictEqual(run("sigterm.ts"), {
        status: 0,
        stdout: "200 close done false\n",
        stderr: "",
      });
    },
  );

  test("a logger that rejects does not crash the process", () => {
    deepStrictEqual(run("async-logger.ts"), {
      status: 0,
      stdout: "200 500 400\n",
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
