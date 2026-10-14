#!/usr/bin/env node
// Checks the files that the tarball of every workspace contains against
// `scripts/pack-files.json`: a file that is missing (e.g. a module not built) or that
// should not be published (e.g. tests, sources or secrets) fails the check.
//
//   node scripts/pack-check.mjs                    `npm pack --dry-run` of the workspaces,
//                                                  which must be built before (their
//                                                  `prepack` does not run)
//   node scripts/pack-check.mjs --tarballs <dir>   the archives that `scripts/release.mjs
//                                                  pack <dir>` prepared, without packing
//                                                  again (their integrity is checked)
//   --update                                       write the current files as the expected
//                                                  ones
import { compareFiles, inspectTarball, readRelease } from "./tarballs.mjs";
import { join, resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { npm } from "./npm.mjs";

const root = join(import.meta.dirname, "..");
const expectedFile = join(root, "scripts", "pack-files.json");
const args = process.argv.slice(2);
const tarballs = args.indexOf("--tarballs");

function packedFiles() {
  const packed = JSON.parse(
    npm(["pack", "--dry-run", "--json", "--workspaces", "--ignore-scripts"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
  return Object.fromEntries(
    packed.map(({ name, files }) => [
      name,
      files.map(({ path }) => path).sort(),
    ]),
  );
}

function preparedFiles(dir) {
  if (typeof dir === "undefined" || dir === "" || dir.startsWith("--")) {
    throw new Error("Usage: scripts/pack-check.mjs --tarballs <dir>");
  }
  return Object.fromEntries(
    readRelease(resolve(dir)).map(({ name, path }) => [
      name,
      inspectTarball(readFileSync(path)).files,
    ]),
  );
}

const actual =
  tarballs === -1 ? packedFiles() : preparedFiles(args[tarballs + 1]);

if (args.includes("--update")) {
  writeFileSync(expectedFile, `${JSON.stringify(actual, null, 2)}\n`);
  process.stderr.write(`[pack] ${expectedFile} updated\n`);
} else {
  const expected = JSON.parse(readFileSync(expectedFile, "utf8"));
  const errors = compareFiles(expected, actual);
  if (errors.length > 0) {
    throw new Error(
      `The packed files differ from scripts/pack-files.json (run \`node scripts/pack-check.mjs --update\` if this is expected):\n  ${errors.join("\n  ")}`,
    );
  }
  process.stderr.write(
    `[pack] ${Object.keys(actual).length} workspaces with the expected files\n`,
  );
}
