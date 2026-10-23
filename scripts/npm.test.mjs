import { afterEach, beforeEach, describe, it } from "node:test";
import { deepEqual, equal, match, ok } from "node:assert/strict";
import { delimiter, join } from "node:path";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
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

// An npm installation in `dir` (`<dir>/<name>`) whose tar is a fake (of the marker
// `name`): its CLI, an executable file (of the given mode) that prints `name` (or the
// path that it runs as, for `path`)
function fakeInstallation(dir, name = "npm", mode = 0o755) {
  const npm = join(dir, name);
  const tar = join(npm, "node_modules", "tar");
  mkdirSync(join(npm, "bin"), { recursive: true });
  mkdirSync(tar, { recursive: true });
  writeFileSync(join(npm, "package.json"), JSON.stringify({ name: "npm" }));
  const cli = join(npm, "bin", "npm-cli.js");
  writeFileSync(
    cli,
    `#!${process.execPath}\nprocess.stdout.write(process.argv[2] === "path" ? process.argv[1] : ${JSON.stringify(name === "npm" ? "fake" : name)});\n`,
    { mode },
  );
  writeFileSync(join(tar, "package.json"), JSON.stringify({ name: "tar" }));
  writeFileSync(
    join(tar, "index.js"),
    `module.exports = { marker: ${JSON.stringify(name === "npm" ? "fake" : name)} };`,
  );
  return cli;
}

// What `npm([])` prints and the marker of the tar that `npmTar()` loads (or their
// errors), in a process of the given environment (with `between` run between them)
function resolution(env, { cwd, between = "" } = {}) {
  const script = `import { npm, npmTar } from ${JSON.stringify(launcher)};
const result = {};
try {
  result.cli = npm([], { encoding: "utf8" });
} catch (error) {
  result.cliError = error.message;
}
${between}
try {
  result.tar = String(npmTar().marker);
} catch (error) {
  result.tarError = error.message;
}
process.stdout.write(JSON.stringify(result));`;
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { cwd, encoding: "utf8", env },
  );
  equal(status, 0, stderr);
  return JSON.parse(stdout);
}

// The environment without `npm_execpath`, with only the given directories on the PATH
function onlyOnPath(...dirs) {
  const env = { ...process.env, PATH: dirs.join(delimiter) };
  delete env.npm_execpath;
  return env;
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

  // Windows runs the npm that comes with Node.js (`npm` is `npm.cmd` there), and
  // POSIX execute permissions do not exist there
  const posix = { skip: process.platform === "win32" };

  it(
    "loads the tar of the npm on the PATH without `npm_execpath`, or refuses",
    posix,
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

      // Without npm on the PATH, or without a PATH
      env.PATH = join(dir, "empty");
      const none = tarOf(env);
      equal(none.status, 1);
      match(
        none.stderr,
        /The npm CLI \(none on the PATH\) is not an npm installation/u,
      );
      // Not the current directory either (it has an npm installation)
      delete env.PATH;
      symlinkSync(join(dir, "npm", "bin", "npm-cli.js"), join(dir, "npm-link"));
      const cwd = join(dir, "cwd");
      mkdirSync(cwd);
      symlinkSync(join(dir, "npm-link"), join(cwd, "npm"));
      deepEqual(resolution(env, { cwd }), {
        cliError: none.stderr.match(/The npm CLI .+$/mu)[0],
        tarError: none.stderr.match(/The npm CLI .+$/mu)[0],
      });
    },
  );

  it(
    "runs the first regular executable `npm` of the PATH and loads its tar",
    posix,
    () => {
      // Two installations: the `npm` of the first is a link to a CLI that cannot
      // be executed, which execvp() skips
      const first = join(dir, "first", "bin");
      const second = join(dir, "second", "bin");
      symlinkSync(fakeInstallation(dir, "first", 0o644), join(first, "npm"));
      symlinkSync(fakeInstallation(dir, "second"), join(second, "npm"));
      // By its real path (not the link of the PATH)
      const between = `result.path = npm(["path"], { encoding: "utf8" });`;
      deepEqual(resolution(onlyOnPath(first, second), { between }), {
        cli: "second",
        path: realpathSync(join(second, "npm-cli.js")),
        tar: "second",
      });

      // An `npm` of mode 644 in an npm installation, and a directory named `npm`
      const plain = join(dir, "plain");
      fakeInstallation(dir, "plain");
      writeFileSync(join(plain, "bin", "npm"), "#!/bin/sh\necho plain\n", {
        mode: 0o644,
      });
      const directory = join(dir, "directory");
      mkdirSync(join(directory, "npm"), { recursive: true });
      // A link to nothing
      const dangling = join(dir, "dangling");
      mkdirSync(dangling);
      symlinkSync(join(dir, "missing"), join(dangling, "npm"));
      deepEqual(
        resolution(onlyOnPath(join(plain, "bin"), directory, dangling, second)),
        { cli: "second", tar: "second" },
      );

      // An empty entry is the current directory, as for execvp()
      const cwd = join(dir, "cwd");
      mkdirSync(cwd);
      symlinkSync(join(second, "npm-cli.js"), join(cwd, "npm"));
      deepEqual(
        resolution(onlyOnPath(join(dir, "empty"), "", first), { cwd }),
        {
          cli: "second",
          tar: "second",
        },
      );
    },
  );

  it(
    "refuses to run the npm of the PATH that is not an npm installation",
    posix,
    () => {
      // The npm that runs is a shim, after an installation that cannot be executed:
      // neither runs, and no tar is loaded
      const first = join(dir, "first", "bin");
      symlinkSync(fakeInstallation(dir, "first", 0o644), join(first, "npm"));
      const shims = join(dir, "shims");
      mkdirSync(shims);
      writeFileSync(
        join(shims, "npm"),
        `#!${process.execPath}\nprocess.stdout.write("shim");\n`,
        { mode: 0o755 },
      );
      const refusal = `The npm CLI (${join(shims, "npm")}) is not an npm installation, whose tar must read the archives: run this script with npm (\`npm run\` or \`npm exec\`, which set npm_execpath)`;
      deepEqual(resolution(onlyOnPath(first, shims)), {
        cliError: refusal,
        tarError: refusal,
      });
    },
  );

  it("resolves the npm that runs once, for its CLI and its tar", posix, () => {
    const first = join(dir, "first", "bin");
    const second = join(dir, "second", "bin");
    symlinkSync(fakeInstallation(dir, "first"), join(first, "npm"));
    symlinkSync(fakeInstallation(dir, "second"), join(second, "npm"));
    // The resolved CLI runs, not the `npm` of the PATH at the time of the call
    const between = `process.env.PATH = ${JSON.stringify(second)};
process.env.npm_execpath = ${JSON.stringify(join(second, "npm-cli.js"))};
result.again = npm([], { encoding: "utf8" });`;
    deepEqual(resolution(onlyOnPath(first), { between }), {
      cli: "first",
      again: "first",
      tar: "first",
    });
  });

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
