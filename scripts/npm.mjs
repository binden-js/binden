// Runs npm portably: Node.js runs the npm CLI that runs the current script
// (`npm_execpath`, which `npx` sets as well), or on Windows the one next to
// Node.js. There, `npm` is `npm.cmd`, which `execFile()` cannot run without a
// shell (https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows).
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

function cli() {
  const { npm_execpath: execpath } = process.env;
  if (execpath) {
    return execpath;
  }
  return process.platform === "win32"
    ? join(
        dirname(process.execPath),
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      )
    : null;
}

/** Same as `execFileSync("npm", args, options)` */
export function npm(args, options = {}) {
  const path = cli();
  return path === null
    ? execFileSync("npm", args, options)
    : execFileSync(process.execPath, [path, ...args], options);
}
