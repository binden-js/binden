#!/usr/bin/env node
// Checks the files that the tarball of every workspace contains against
// `scripts/pack-files.json`: a file that is missing (e.g. a module not built) or that
// should not be published (e.g. tests, sources or secrets) fails the check. On top of
// the list, the rules of `scripts/pack-rules.mjs` refuse tests, fixtures, certificates
// and secrets whatever the list says, source maps that do not point to the published
// sources with relative paths, and links to source maps (in any file) that are not
// relative paths to published maps.
//
//   node scripts/pack-check.mjs                    `npm pack --dry-run` of the workspaces,
//                                                  which must be built before (their
//                                                  `prepack` does not run, only their
//                                                  `documents` script, which copies the
//                                                  documents of the root that they ship)
//   node scripts/pack-check.mjs --tarballs <dir>   the archives that `scripts/release.mjs
//                                                  pack <dir>` prepared, without packing
//                                                  again (their integrity is checked)
//   --update                                       write the current files as the expected
//                                                  ones (unless they break the rules)
import { compareFiles, readRelease, readTarball } from "./tarballs.mjs";
import { join, resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { npm } from "./npm.mjs";
import { packageErrors } from "./pack-rules.mjs";

const root = join(import.meta.dirname, "..");
const expectedFile = join(root, "scripts", "pack-files.json");
const args = process.argv.slice(2);
const tarballs = args.indexOf("--tarballs");

const readJSON = (path) => JSON.parse(readFileSync(path, "utf8"));

// The directory of each workspace, by package name
function workspaceDirs() {
  const { workspaces = [] } = readJSON(join(root, "package.json"));
  return new Map(
    workspaces.map((dir) => [
      readJSON(join(root, dir, "package.json")).name,
      join(root, dir),
    ]),
  );
}

// The packed files of each package, and how to read them: { name: { paths, read } }
function packedFiles() {
  npm(["run", "documents", "--workspaces", "--if-present"], {
    cwd: root,
    stdio: ["ignore", process.stderr, "inherit"],
  });
  const packed = JSON.parse(
    npm(["pack", "--dry-run", "--json", "--workspaces", "--ignore-scripts"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
  let dirs = null;
  return Object.fromEntries(
    packed.map(({ name, files }) => [
      name,
      {
        paths: files.map(({ path }) => path).sort(),
        read: (path) => {
          dirs ??= workspaceDirs();
          const dir = dirs.get(name);
          if (typeof dir === "undefined") {
            throw new Error(`${name} is not a workspace`);
          }
          return readFileSync(join(dir, path));
        },
      },
    ]),
  );
}

function preparedFiles(dir) {
  if (typeof dir === "undefined" || dir === "" || dir.startsWith("--")) {
    throw new Error("Usage: scripts/pack-check.mjs --tarballs <dir>");
  }
  return Object.fromEntries(
    readRelease(resolve(dir)).map(({ name, path }) => {
      const files = readTarball(readFileSync(path));
      return [
        name,
        { paths: [...files.keys()].sort(), read: (file) => files.get(file) },
      ];
    }),
  );
}

const packages =
  tarballs === -1 ? packedFiles() : preparedFiles(args[tarballs + 1]);
const actual = Object.fromEntries(
  Object.entries(packages).map(([name, { paths }]) => [name, paths]),
);
const refused = Object.entries(packages).flatMap(([name, { paths, read }]) =>
  packageErrors(paths, read).map((error) => `${name}: ${error}`),
);
const rules = `The packed files break the rules of scripts/pack-rules.mjs:\n  ${refused.join("\n  ")}`;

if (args.includes("--update")) {
  if (refused.length > 0) {
    throw new Error(rules);
  }
  writeFileSync(expectedFile, `${JSON.stringify(actual, null, 2)}\n`);
  process.stderr.write(`[pack] ${expectedFile} updated\n`);
} else {
  const errors = compareFiles(readJSON(expectedFile), actual);
  if (errors.length > 0) {
    throw new Error(
      `The packed files differ from scripts/pack-files.json (run \`node scripts/pack-check.mjs --update\` if this is expected):\n  ${errors.join("\n  ")}${refused.length > 0 ? `\n${rules}` : ""}`,
    );
  }
  if (refused.length > 0) {
    throw new Error(rules);
  }
  process.stderr.write(
    `[pack] ${Object.keys(actual).length} workspaces with the expected files\n`,
  );
}
