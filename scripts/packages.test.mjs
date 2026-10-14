import { deepEqual, equal } from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";

// The manifests that the workspaces publish
const root = join(import.meta.dirname, "..");
const readJSON = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const { workspaces } = readJSON("package.json");
const packages = workspaces.map((dir) => ({
  dir,
  manifest: readJSON(`${dir}/package.json`),
}));

describe("the manifests of the workspaces", () => {
  it("publish their sources and their maps, but not their tests", () => {
    const { compilerOptions } = readJSON("tsconfig.base.json");
    equal(compilerOptions.sourceMap, true);
    equal(compilerOptions.declarationMap, true);
    for (const { dir, manifest } of packages) {
      deepEqual(
        manifest.files.slice(0, 3),
        ["dist", "!dist/test", "index.ts"],
        dir,
      );
    }
  });
});
