#!/usr/bin/env node
// Runs the `node:test` suite of the current workspace (`npm test` in `packages/*`).
// Extra arguments are Node.js test runner options, placed before the test files:
//
//   npm test -w packages/body -- --test-name-pattern="JSON"
//   npm test -- --test-reporter=dot
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const setup = existsSync("test/setup.ts")
  ? ["--import", "./test/setup.ts"]
  : [];

const { status, signal } = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    ...setup,
    "--test",
    "--test-concurrency=1",
    "--test-timeout=60000",
    ...process.argv.slice(2),
    "test/**/*.test.ts",
  ],
  { stdio: "inherit" },
);

if (signal !== null) {
  process.kill(process.pid, signal);
}
process.exitCode = status ?? 1;
