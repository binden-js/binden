import { afterEach, beforeEach, describe, it } from "node:test";
import { deepEqual, equal, match } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const launcher = pathToFileURL(join(import.meta.dirname, "npm.mjs")).href;

// Prints the output of `npm(<args>)` (scripts/npm.mjs)
function run(args, env) {
  const script = `import { npm } from ${JSON.stringify(launcher)};
process.stdout.write(npm(${JSON.stringify(args)}, { encoding: "utf8" }));`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env,
  });
}

describe("scripts/npm.mjs", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "binden-npm-"));
  });

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  it("runs the npm CLI of `npm_execpath` with Node.js", () => {
    const cli = join(dir, "npm-cli.cjs");
    writeFileSync(
      cli,
      "process.stdout.write(JSON.stringify([process.execPath, ...process.argv.slice(2)]));",
    );
    const { status, stdout } = run(["view", "binden"], {
      ...process.env,
      npm_execpath: cli,
    });
    equal(status, 0);
    deepEqual(JSON.parse(stdout), [process.execPath, "view", "binden"]);
  });

  it("runs npm without `npm_execpath`", () => {
    const env = { ...process.env };
    delete env.npm_execpath;
    const { status, stdout } = run(["--version"], env);
    equal(status, 0);
    match(stdout, /^\d+\.\d+\.\d+/u);
  });
});
