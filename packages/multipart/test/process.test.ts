import { suite, test } from "node:test";
import { deepStrictEqual } from "node:assert";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Runs a fixture (`test/fixtures`) in a process of its own: a crash (e.g. an
 * `unhandledRejection`) is its exit code and output, not a failure of the
 * test runner
 */
function run(
  fixture: string,
  { flags = [], args = [] }: { flags?: string[]; args?: string[] } = {},
): Record<string, unknown> {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [
      ...flags,
      "--import",
      "tsx",
      join(import.meta.dirname, "fixtures", fixture),
      ...args,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  return { status, stdout, stderr };
}

suite("Multipart (process safety)", () => {
  test("callbacks that hang or fail once the request is aborted do not crash the process", () => {
    deepStrictEqual(run("late-rejections.ts"), {
      status: 0,
      stdout: "503 503 503 503\n",
      stderr: "",
    });
  });

  test("the stream storage keeps a bounded memory, whatever the size of the files", () => {
    const flags = ["--expose-gc"];
    deepStrictEqual(run("stream-memory.ts", { flags }), {
      status: 0,
      stdout: "200 128 bounded\n",
      stderr: "",
    });
    // Unlike the memory storage, which keeps them
    deepStrictEqual(run("stream-memory.ts", { flags, args: ["memory"] }), {
      status: 0,
      stdout: "200 0 unbounded\n",
      stderr: "",
    });
  });
});
