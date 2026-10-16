import { afterEach, beforeEach, describe, it } from "node:test";
import { deepEqual, equal, match, ok } from "node:assert/strict";
import { delimiter, join } from "node:path";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

// Prints what `npmTar()` (scripts/npm.mjs) loads: the `marker` of a fake tar, or
// whether it is the tar of the npm that comes with Node.js (it throws for a CLI that
// is not an npm installation)
function tarOf(env) {
  const script = `import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { npmTar } from ${JSON.stringify(launcher)};
const tar = npmTar();
const npm = process.platform === "win32"
  ? join(dirname(process.execPath), "node_modules", "npm")
  : join(dirname(dirname(process.execPath)), "lib", "node_modules", "npm");
const bundled = createRequire(join(npm, "package.json"))("tar");
process.stdout.write(tar === npmTar() && tar === bundled ? "bundled" : String(tar.marker));`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env,
  });
}

// An npm installation in `dir` (`<dir>/npm`) whose tar is a fake: its CLI
function fakeInstallation(dir) {
  const npm = join(dir, "npm");
  const tar = join(npm, "node_modules", "tar");
  mkdirSync(join(npm, "bin"), { recursive: true });
  mkdirSync(tar, { recursive: true });
  writeFileSync(join(npm, "package.json"), JSON.stringify({ name: "npm" }));
  writeFileSync(join(npm, "bin", "npm-cli.js"), "");
  writeFileSync(join(tar, "package.json"), JSON.stringify({ name: "tar" }));
  writeFileSync(join(tar, "index.js"), 'module.exports = { marker: "fake" };');
  return join(npm, "bin", "npm-cli.js");
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

  it("loads the tar of the npm installation of `npm_execpath`", () => {
    const { status, stdout } = tarOf({
      ...process.env,
      npm_execpath: fakeInstallation(dir),
    });
    equal(status, 0);
    equal(stdout, "fake");
  });

  it("refuses a CLI that is not an npm installation, instead of another tar", () => {
    const cli = join(dir, "npm-cli.cjs");
    writeFileSync(cli, "");
    // A package of another name, with a tar of its own
    const other = join(dir, "other");
    const tar = join(other, "node_modules", "tar");
    mkdirSync(join(other, "bin"), { recursive: true });
    mkdirSync(tar, { recursive: true });
    writeFileSync(
      join(other, "package.json"),
      JSON.stringify({ name: "yarn" }),
    );
    writeFileSync(join(other, "bin", "cli.js"), "");
    writeFileSync(
      join(tar, "index.js"),
      'module.exports = { marker: "other" };',
    );
    for (const execpath of [
      cli,
      join(dir, "missing.js"),
      join(other, "bin", "cli.js"),
    ]) {
      const { status, stdout, stderr } = tarOf({
        ...process.env,
        npm_execpath: execpath,
      });
      equal(status, 1, execpath);
      equal(stdout, "", execpath);
      match(
        stderr,
        /The npm CLI \(.+\) is not an npm installation, whose tar must read the archives: run this script with npm/u,
        execpath,
      );
      ok(stderr.includes(execpath), execpath);
    }
  });

  it(
    "loads the tar of the npm on the PATH without `npm_execpath`, or refuses",
    // Windows runs the npm that comes with Node.js (`npm` is `npm.cmd` there)
    { skip: process.platform === "win32" },
    () => {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      symlinkSync(fakeInstallation(dir), join(bin, "npm"));
      const env = {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
      };
      delete env.npm_execpath;
      const { status, stdout } = tarOf(env);
      equal(status, 0);
      equal(stdout, "fake");

      // A version-manager shim, which runs an npm that cannot be found
      const shims = join(dir, "shims");
      mkdirSync(shims);
      writeFileSync(join(shims, "npm"), '#!/bin/sh\nexec npm "$@"\n', {
        mode: 0o755,
      });
      env.PATH = `${shims}${delimiter}${process.env.PATH}`;
      const shimmed = tarOf(env);
      equal(shimmed.status, 1);
      match(
        shimmed.stderr,
        /The npm CLI \(.+shims.npm\) is not an npm installation/u,
      );

      // Without npm on the PATH
      env.PATH = join(dir, "empty");
      const none = tarOf(env);
      equal(none.status, 1);
      match(
        none.stderr,
        /The npm CLI \(none on the PATH\) is not an npm installation/u,
      );
    },
  );

  it(
    "loads the tar of the npm of Node.js on Windows without `npm_execpath`",
    // The npm that `npm()` runs there
    { skip: process.platform !== "win32" },
    () => {
      const env = { ...process.env };
      delete env.npm_execpath;
      const { status, stdout, stderr } = tarOf(env);
      equal(status, 0, stderr);
      equal(stdout, "bundled");
    },
  );

  it("runs npm without `npm_execpath`", () => {
    const env = { ...process.env };
    delete env.npm_execpath;
    const { status, stdout } = run(["--version"], env);
    equal(status, 0);
    match(stdout, /^\d+\.\d+\.\d+/u);
  });
});
