#!/usr/bin/env node
// Copies documents of the root of the repository into the current workspace (its
// `documents` script, which its `prepack` runs after the build), so that its tarball
// ships them: `binden` ships MIGRATION-4.md and PRODUCTION.md. The copies are ignored
// by git and removed by `scripts/clean.mjs`. A missing document fails `npm pack` (and
// `scripts/release.mjs pack`), so a release cannot be packed without it.
//
//   node ../../scripts/copy-documents.mjs <file>...
import { basename, join } from "node:path";
import { copyFileSync, statSync } from "node:fs";

const root = join(import.meta.dirname, "..");
const files = process.argv.slice(2);

if (files.length === 0) {
  throw new Error("Usage: scripts/copy-documents.mjs <file>...");
}
for (const file of files) {
  if (basename(file) !== file || file === "." || file === "..") {
    throw new Error(`Not a file name of the root of the repository: ${file}`);
  }
}

// Every document is checked before the first one is copied
const missing = files.filter(
  (file) =>
    !(statSync(join(root, file), { throwIfNoEntry: false })?.isFile() ?? false),
);
if (missing.length > 0) {
  throw new Error(
    `Missing at the root of the repository, but published by this package: ${missing.join(", ")}`,
  );
}

for (const file of files) {
  copyFileSync(join(root, file), file);
  process.stderr.write(`[documents] ${file}\n`);
}
