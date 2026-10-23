// An npm installation for the tests of the release tooling, whose CLI is a fake:
// scripts/npm.mjs reads archives only with the tar of the npm installation that it
// runs (`npm_execpath`), and refuses any other CLI. Its tar is the real node-tar of
// the npm that comes with the Node.js that runs the tests.
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// The entry point of the node-tar of the npm that comes with Node.js (as `require()`
// loads it), which must be there
function realTar() {
  const npm =
    process.platform === "win32"
      ? join(dirname(process.execPath), "node_modules", "npm")
      : join(dirname(dirname(process.execPath)), "lib", "node_modules", "npm");
  return createRequire(join(npm, "package.json")).resolve("tar");
}

/**
 * Creates the installation `<dir>/npm`, whose `bin/npm-cli.js` runs the module
 * `cli` (its arguments are `process.argv.slice(2)`, as for npm), and returns the
 * path of that CLI (for `npm_execpath`)
 */
export function npmInstallation(dir, cli) {
  const npm = join(dir, "npm");
  const tar = join(npm, "node_modules", "tar");
  mkdirSync(join(npm, "bin"), { recursive: true });
  mkdirSync(tar, { recursive: true });
  writeFileSync(join(npm, "package.json"), JSON.stringify({ name: "npm" }));
  const path = join(npm, "bin", "npm-cli.js");
  writeFileSync(path, `import(${JSON.stringify(pathToFileURL(cli).href)});\n`);
  writeFileSync(join(tar, "package.json"), JSON.stringify({ name: "tar" }));
  writeFileSync(
    join(tar, "index.js"),
    `module.exports = require(${JSON.stringify(realTar())});\n`,
  );
  return path;
}
