import { deepEqual, equal } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  importsOf,
  packageOf,
  typesOf,
  undeclaredImports,
} from "./imports.mjs";

describe("scripts/imports.mjs", () => {
  it("importsOf() finds the static, dynamic and type imports", () => {
    const source = `import a from "a";
import { b,
  c } from "@scope/b/sub";
import type { D } from "d";
import "side-effect";
export * from "./relative.js";
export { e } from "e";
export * as f from "node:fs";
export const g = "not-an-import";
const h = await import("h");
type I = import("i").I;
/// <reference types="j" />
/**
 * import k from "k";
 */
import.meta.dirname;
`;
    deepEqual(importsOf(source).sort(), [
      "./relative.js",
      "@scope/b/sub",
      "a",
      "d",
      "e",
      "h",
      "i",
      "j",
      "node:fs",
      "side-effect",
    ]);
  });

  it("packageOf() is the package of a bare specifier", () => {
    deepEqual(
      [
        "pino",
        "pino/file",
        "@binden/logger",
        "@binden/logger/dist/index.js",
        "node:fs/promises",
        "./index.js",
        "../index.js",
        "/abs.js",
        "file:///x.js",
      ].map(packageOf),
      [
        "pino",
        "pino",
        "@binden/logger",
        "@binden/logger",
        "node:",
        null,
        null,
        null,
        null,
      ],
    );
  });

  it("typesOf() is the `@types/` package of a package", () => {
    equal(typesOf("busboy"), "@types/busboy");
    equal(typesOf("@scope/name"), "@types/scope__name");
  });

  it("undeclaredImports() checks the modules and declarations of dist", () => {
    const manifest = {
      name: "@scope/package",
      dependencies: { dep: "^1.0.0", "@types/typed": "^1.0.0" },
      peerDependencies: { peer: "^1.0.0" },
      optionalDependencies: { optional: "^1.0.0" },
    };
    const files = new Map(
      Object.entries({
        "package.json": 'import "ignored-not-dist";',
        "dist/index.js": [
          'import "dep";',
          'import "peer/sub";',
          'import "optional";',
          'import "node:fs";',
          'import "./local.js";',
          'import "@scope/package/other";',
          'import "hoisted";',
          'import "fs";',
          'import "typed";',
        ].join("\n"),
        "dist/index.d.ts":
          'import type { T } from "typed";\nimport "types-only";',
        "dist/index.js.map": 'import "ignored-map";',
        "src/index.ts": 'import "ignored-src";',
      }).map(([path, content]) => [path, Buffer.from(content)]),
    );
    deepEqual(undeclaredImports(manifest, files), [
      "@scope/package: dist/index.js imports hoisted, which is not declared",
      "@scope/package: dist/index.js imports fs, which is not declared",
      "@scope/package: dist/index.js imports typed, which is not declared",
      "@scope/package: dist/index.d.ts imports types-only, which is not declared",
    ]);
    // Without dependencies: every bare import but the builtins (7 + 2)
    equal(undeclaredImports({ name: "empty" }, files).length, 9);
  });
});
