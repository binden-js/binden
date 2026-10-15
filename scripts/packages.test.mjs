import { deepEqual, equal, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// The manifests that the workspaces publish, and how Node.js resolves the workspaces
// (linked into node_modules) through them, as it resolves the installed packages
const root = join(import.meta.dirname, "..");
const readJSON = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const { engines, workspaces } = readJSON("package.json");
const packages = workspaces.map((dir) => ({
  dir,
  manifest: readJSON(`${dir}/package.json`),
}));

describe("the manifests of the workspaces", () => {
  it("export the root and package.json only", () => {
    for (const { dir, manifest } of packages) {
      deepEqual(
        manifest.exports,
        {
          ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
          "./package.json": "./package.json",
        },
        dir,
      );
      // For the tools that do not read `exports`
      equal(manifest.main, "dist/index.js", dir);
      equal(manifest.types, "dist/index.d.ts", dir);
    }
  });

  it("resolve the root and package.json, and no other module", () => {
    for (const { dir, manifest } of packages) {
      const { name } = manifest;
      // The workspace itself, whatever links (or junctions on Windows) lead to it
      const resolve = (specifier) =>
        realpathSync(fileURLToPath(import.meta.resolve(specifier)));
      equal(
        resolve(name),
        realpathSync(join(root, dir, "dist/index.js")),
        name,
      );
      equal(
        resolve(`${name}/package.json`),
        realpathSync(join(root, dir, "package.json")),
        name,
      );
      for (const path of [
        "dist/index.js",
        "dist/src/a.js",
        "index.ts",
        "src",
      ]) {
        throws(
          () => import.meta.resolve(`${name}/${path}`),
          { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" },
          `${name}/${path}`,
        );
      }
    }
  });

  it("have no side effects", () => {
    for (const { dir, manifest } of packages) {
      equal(manifest.sideEffects, false, dir);
    }
  });

  it("require Node.js only (npm is a requirement of this repository)", () => {
    equal(typeof engines.npm, "string");
    for (const { dir, manifest } of packages) {
      deepEqual(manifest.engines, { node: engines.node }, dir);
    }
  });

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
