// Runs npm portably: Node.js runs the npm CLI that runs the current script
// (`npm_execpath`, which `npx` sets as well), or on Windows the one next to
// Node.js. There, `npm` is `npm.cmd`, which `execFile()` cannot run without a
// shell (https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows).
import { delimiter, dirname, join } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

// The npm installation that comes with Node.js
function bundled() {
  return process.platform === "win32"
    ? join(dirname(process.execPath), "node_modules", "npm")
    : join(dirname(dirname(process.execPath)), "lib", "node_modules", "npm");
}

function cli() {
  const { npm_execpath: execpath } = process.env;
  if (execpath) {
    return execpath;
  }
  return process.platform === "win32"
    ? join(bundled(), "bin", "npm-cli.js")
    : null;
}

/** Same as `execFileSync("npm", args, options)` */
export function npm(args, options = {}) {
  const path = cli();
  return path === null
    ? execFileSync("npm", args, options)
    : execFileSync(process.execPath, [path, ...args], options);
}

// The npm installation of a CLI (`<npm>/bin/npm-cli.js`, or a link to it), or null
// when it is not one (e.g. the fake npm of the tests)
function installation(path) {
  try {
    const dir = dirname(dirname(realpathSync(path)));
    const { name } = JSON.parse(
      readFileSync(join(dir, "package.json"), "utf8"),
    );
    return name === "npm" ? dir : null;
  } catch {
    return null;
  }
}

// The `npm` that `execFileSync("npm")` runs: the first one on the PATH
function onPath() {
  const dirs = (process.env.PATH ?? "").split(delimiter);
  const found = dirs.find((dir) => dir !== "" && existsSync(join(dir, "npm")));
  return typeof found === "undefined" ? null : join(found, "npm");
}

let tar = null;

/**
 * The `tar` package (node-tar) of the npm installation that `npm()` runs, which
 * reads the archives that it publishes (e.g. their package.json): when that CLI
 * is not an npm installation, the npm that comes with Node.js. Loaded once.
 */
export function npmTar() {
  if (tar === null) {
    const path = cli() ?? onPath();
    const dir = (path === null ? null : installation(path)) ?? bundled();
    tar = createRequire(join(dir, "package.json"))("tar");
  }
  return tar;
}
