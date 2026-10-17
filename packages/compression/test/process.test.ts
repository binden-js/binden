import { suite, test } from "node:test";
import { deepStrictEqual } from "node:assert";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Runs a fixture (`test/fixtures`) in a process of its own: a crash (e.g. an
 * unhandled rejection) is its exit code and output, not a failure of the
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
  test("a `filter` that returns a rejected promise does not crash the process", () => {
    deepStrictEqual(run("filter-rejection.ts"), {
      status: 0,
      stdout: "500 500\n",
      stderr: "",
    });
  });

  test("a refused chunk once the compression has ended the response does not crash the process", () => {
    deepStrictEqual(run("ended-chunk.ts"), {
      status: 0,
      stdout: [
        "/write-end HTTP/1.1 406 Not Acceptable",
        "/write-end-object HTTP/1.1 406 Not Acceptable",
        "/write-write HTTP/1.1 406 Not Acceptable",
        "/head-end HTTP/1.1 406 Not Acceptable",
        "/head-end-object HTTP/1.1 406 Not Acceptable",
        "/head-write HTTP/1.1 406 Not Acceptable",
        "/compressed HTTP/1.1 200 OK",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  test("a head that Node.js refuses under a decision does not crash the process", () => {
    deepStrictEqual(run("refused-head.ts"), {
      status: 0,
      stdout: "HTTP/1.1 500 Internal Server Error (0 bytes) (19)\n",
      stderr: "",
    });
  });
});
