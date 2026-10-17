// Runs npm portably: Node.js runs the npm CLI that runs the current script
// (`npm_execpath`, which `npx` sets as well), or on Windows the one next to
// Node.js. There, `npm` is `npm.cmd`, which `execFile()` cannot run without a
// shell (https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows).
// Elsewhere, without `npm_execpath`, it is the `npm` that a shell would run (the
// first regular executable file of the PATH), by its real path. The CLI that runs
// and the tar that reads its archives (`npmTar()`) come from one resolution.
import {
  accessSync,
  constants,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

// The npm installation that comes with Node.js
function bundled() {
  return process.platform === "win32"
    ? join(dirname(process.execPath), "node_modules", "npm")
    : join(dirname(dirname(process.execPath)), "lib", "node_modules", "npm");
}

// The npm installation of a CLI (`<npm>/bin/npm-cli.js`, or a link to it), or null
// when it is not one (e.g. a version-manager shim, or the CLI of another package manager)
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

// The `npm` that execvp() runs, with its real path: the first one on the PATH that
// is a regular executable file (an empty entry is the current directory), or null.
// Without a PATH, none (not the default path of execvp(), such as /usr/bin:/bin)
function onPath() {
  const { PATH } = process.env;
  for (const entry of typeof PATH === "string" ? PATH.split(delimiter) : []) {
    const path = resolve(entry, "npm");
    try {
      if (statSync(path).isFile()) {
        accessSync(path, constants.X_OK);
        return { path, real: realpathSync(path) };
      }
    } catch {
      // Missing, or not executable: execvp() tries the next entry
    }
  }
  return null;
}

let resolution = null;

// The npm that runs, resolved once: the command and the leading arguments that run
// its CLI (no command for a PATH entry that is not an npm installation, whose real
// path may not run as npm), and its installation (null when it is not one)
function resolved() {
  if (resolution === null) {
    const { npm_execpath: execpath } = process.env;
    if (execpath || process.platform === "win32") {
      const cli = execpath || join(bundled(), "bin", "npm-cli.js");
      const dir = installation(cli);
      resolution = { cli, command: process.execPath, prefix: [cli], dir };
    } else {
      const found = onPath();
      const dir = found === null ? null : installation(found.real);
      resolution = {
        cli: found?.path ?? null,
        command: dir === null ? null : found.real,
        prefix: [],
        dir,
      };
    }
  }
  return resolution;
}

function refuse({ cli }) {
  return new Error(
    `The npm CLI (${cli ?? "none on the PATH"}) is not an npm installation, whose tar must read the archives: run this script with npm (\`npm run\` or \`npm exec\`, which set npm_execpath)`,
  );
}

/**
 * Same as `execFileSync("npm", args, options)`, with the npm of `npmTar()`. Without
 * `npm_execpath`, outside Windows, the npm of the PATH is refused when it is not an
 * npm installation (e.g. a version-manager shim).
 */
export function npm(args, options = {}) {
  const { command, prefix } = resolved();
  if (command === null) {
    throw refuse(resolved());
  }
  return execFileSync(command, [...prefix, ...args], options);
}

let tar = null;

/**
 * The `tar` package (node-tar) of the npm installation that `npm()` runs, which
 * reads the archives that it publishes (e.g. their package.json). Loaded once.
 * When that CLI is not an npm installation (e.g. a version-manager shim, which
 * runs an npm that cannot be found), it throws: the archives are never read by
 * the tar of another npm, such as the one that comes with Node.js.
 */
export function npmTar() {
  if (tar === null) {
    const { dir } = resolved();
    if (dir === null) {
      throw refuse(resolved());
    }
    tar = createRequire(join(dir, "package.json"))("tar");
  }
  return tar;
}
