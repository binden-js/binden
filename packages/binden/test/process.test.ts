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

  test("a pipe whose write or end throws fails its work: one reply, no crash", () => {
    deepStrictEqual(run("pipe-failures.ts"), {
      status: 0,
      stdout:
        "500(open) 500(open) 500(open) 500(open) 500(open) 200(closed) 200(closed)\n" +
        "committed-pipeline:ERR_INVALID_ARG_TYPE empty-pipeline:ERR_INVALID_CHAR pipeline:ERR_INVALID_CHAR\n",
      stderr: "",
    });
  });

  test("a string whose length Node.js estimates is framed by its bytes: also odd hex on Node.js 24", () => {
    // Odd hex, invalid hex and base64, an empty body, any case, a strict
    // length: alone, behind another response and after early hints (3 × 10)
    deepStrictEqual(run("estimated-lengths.ts"), {
      status: 0,
      stdout: "30\n",
      stderr: "",
    });
  });

  test("a pipe of a work into the response of another request leaves its failures to its own exchange", () => {
    deepStrictEqual(run("foreign-pipes.ts"), {
      status: 0,
      stdout:
        "promise+foreign A=500(open): B=200(open):B\n" +
        "promise A=500(open): B=200(open):B\n" +
        "callback+foreign A=500(open): B=200(open):B\n" +
        "callback A=500(open): B=200(open):B\n" +
        "callback:ERR_INVALID_CHAR callback:ERR_INVALID_CHAR promise:ERR_INVALID_CHAR promise:ERR_INVALID_CHAR\n",
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
