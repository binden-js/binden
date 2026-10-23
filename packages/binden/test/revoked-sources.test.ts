import { deepStrictEqual } from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("a revoked work is told, and its sources unpiped, without crashing the process, also when the cleanup of one throws, or the work is undefined (found by the fixture of the public surface)", () => {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      join(import.meta.dirname, "fixtures", "revoked-sources.ts"),
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  const message = "The unpipe of a source of an abandoned work has failed";
  deepStrictEqual(
    { status, stdout, stderr },
    {
      status: 0,
      stdout: `${JSON.stringify([
        1,
        [`${message}: A hostile unpipe`, `${message}: A hostile trap`],
      ])}\nan undefined work: revoked\n`,
      stderr: "",
    },
  );
});
