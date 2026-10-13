import { afterEach, beforeEach, describe, it } from "node:test";
import { equal, match, ok } from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const runner = join(import.meta.dirname, "test.mjs");
const root = join(import.meta.dirname, "..");

// The nested test runner must not report to this one
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;

function run(cwd, args = []) {
  return spawnSync(process.execPath, [runner, ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
}

describe("scripts/test.mjs", () => {
  it("forwards test runner options (before the test files)", () => {
    const { status, stdout } = run(join(root, "packages/logger"), [
      "--test-name-pattern=ENV_VARIABLE_NAME",
    ]);
    equal(status, 0);
    match(stdout, /✔ \.ENV_VARIABLE_NAME/u);
    ok(!stdout.includes("serializes errors"));
  });

  it("forwards the reporter", () => {
    const { status, stdout } = run(join(root, "packages/logger"), [
      "--test-reporter=tap",
      "--test-name-pattern=ENV_VARIABLE_NAME",
    ]);
    equal(status, 0);
    match(stdout, /^TAP version 13/u);
  });

  describe("with a fixture workspace", () => {
    let fixture = "";

    beforeEach(() => {
      fixture = mkdtempSync(join(tmpdir(), "binden-test-runner-"));
      symlinkSync(join(root, "node_modules"), join(fixture, "node_modules"));
      mkdirSync(join(fixture, "test"));
      writeFileSync(
        join(fixture, "test/setup.ts"),
        "(globalThis as Record<string, unknown>).setup = true;\n",
      );
      writeFileSync(
        join(fixture, "test/fixture.test.ts"),
        [
          'import { ok } from "node:assert/strict";',
          'import { test } from "node:test";',
          'test("loads test/setup.ts", () => {',
          "  ok((globalThis as Record<string, unknown>).setup);",
          "});",
          'test("fails", () => {',
          '  throw new Error("expected");',
          "});",
          "",
        ].join("\n"),
      );
    });

    afterEach(() => {
      rmSync(fixture, { force: true, recursive: true });
    });

    it("loads test/setup.ts and exits with the status of the tests", () => {
      const { status, stdout } = run(fixture);
      equal(status, 1);
      match(stdout, /✔ loads test\/setup\.ts/u);
      match(stdout, /✖ fails/u);
    });
  });
});
