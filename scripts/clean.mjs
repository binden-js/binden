#!/usr/bin/env node
// Removes the `dist` directory of the current workspace (its `prebuild` script), and
// the files given as arguments (the documents that `scripts/copy-documents.mjs` copies
// into it), without a shell command (`rm -rf` does not exist on Windows)
//
//   node ../../scripts/clean.mjs [<file>...]
import { basename } from "node:path";
import { rmSync } from "node:fs";

const files = process.argv.slice(2);

// Only names in the workspace: nothing outside of it is removed
for (const file of files) {
  if (basename(file) !== file || file === "." || file === "..") {
    throw new Error(`Not a file name of the workspace: ${file}`);
  }
}

for (const path of ["dist", ...files]) {
  rmSync(path, { force: true, recursive: true });
}
