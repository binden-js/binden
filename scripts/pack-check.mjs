#!/usr/bin/env node
// Checks the files that `npm pack` puts in the tarball of every workspace against
// `scripts/pack-files.json`: a file that is missing (e.g. a module not built) or that
// should not be published (e.g. tests, sources or secrets) fails the check.
// The workspaces must be built before (`npm run build`): their `prepack` does not run.
//
//   node scripts/pack-check.mjs            check
//   node scripts/pack-check.mjs --update   write the current files as the expected ones
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { npm } from "./npm.mjs";

const root = join(import.meta.dirname, "..");
const expectedFile = join(root, "scripts", "pack-files.json");

const packed = JSON.parse(
  npm(["pack", "--dry-run", "--json", "--workspaces", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }),
);
const actual = Object.fromEntries(
  packed.map(({ name, files }) => [name, files.map(({ path }) => path).sort()]),
);

if (process.argv.includes("--update")) {
  writeFileSync(expectedFile, `${JSON.stringify(actual, null, 2)}\n`);
  process.stderr.write(`[pack] ${expectedFile} updated\n`);
} else {
  const expected = JSON.parse(readFileSync(expectedFile, "utf8"));
  const errors = [];
  for (const name of new Set([
    ...Object.keys(expected),
    ...Object.keys(actual),
  ])) {
    const want = new Set(expected[name] ?? []);
    const have = new Set(actual[name] ?? []);
    for (const file of have.difference(want)) {
      errors.push(`${name}: unexpected ${file}`);
    }
    for (const file of want.difference(have)) {
      errors.push(`${name}: missing ${file}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `The packed files differ from scripts/pack-files.json (run \`node scripts/pack-check.mjs --update\` if this is expected):\n  ${errors.join("\n  ")}`,
    );
  }
  process.stderr.write(
    `[pack] ${Object.keys(actual).length} workspaces with the expected files\n`,
  );
}
