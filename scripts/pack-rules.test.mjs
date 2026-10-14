import { deepEqual, equal } from "node:assert/strict";
import { deniedReason, packageErrors, resolveInside } from "./pack-rules.mjs";
import { describe, it } from "node:test";

const map = (sources, extra = {}) =>
  JSON.stringify({ version: 3, sources, mappings: "", ...extra });

// The errors of a package made of `files` ({ path: content })
const errors = (files) =>
  packageErrors(Object.keys(files), (path) => Buffer.from(files[path]));

describe("scripts/pack-rules.mjs", () => {
  describe("deniedReason()", () => {
    it("refuses tests, fixtures, certificates and secrets", () => {
      for (const [path, reason] of [
        ["dist/test/index.test.js", "a file of a test/ directory"],
        ["test/helpers.ts", "a file of a test/ directory"],
        ["src/tests/a.ts", "a file of a tests/ directory"],
        ["src/__tests__/a.ts", "a file of a __tests__/ directory"],
        ["test-data/fixtures/a.json", "a file of a fixtures/ directory"],
        ["cert/a.txt", "a file of a cert/ directory"],
        ["certs/a.txt", "a file of a certs/ directory"],
        ["coverage/lcov.info", "a file of a coverage/ directory"],
        ["node_modules/a/index.js", "a file of a node_modules/ directory"],
        [".git/config", "a file of a .git/ directory"],
        ["src/a.test.ts", "a test"],
        ["dist/a.spec.js", "a test"],
        ["key.pem", "a certificate or a key"],
        ["dist/server.KEY", "a certificate or a key"],
        ["a.crt", "a certificate or a key"],
        ["a.cer", "a certificate or a key"],
        ["a.csr", "a certificate or a key"],
        ["a.der", "a certificate or a key"],
        ["a.p12", "a certificate or a key"],
        ["a.pfx", "a certificate or a key"],
        [".env", "an environment file"],
        ["dist/.env.production", "an environment file"],
        [".npmrc", "an npm configuration file"],
        ["src/.npmrc", "an npm configuration file"],
        ["npm-debug.log", "a build artefact"],
        ["binden-1.0.0.tgz", "a build artefact"],
        ["tsconfig.tsbuildinfo", "a build artefact"],
      ]) {
        equal(deniedReason(path), reason, path);
      }
    });

    it("accepts the files of a package", () => {
      for (const path of [
        "LICENSE",
        "README.md",
        "MIGRATION-4.md",
        "package.json",
        "index.ts",
        "src/headers/content-type.ts",
        "dist/index.js",
        "dist/index.js.map",
        "dist/index.d.ts",
        "dist/index.d.ts.map",
        "dist/src/testing.js",
        "dist/src/attest.js",
        "src/certificate.ts",
        "src/environment.ts",
        "dist/src/.envelope.js",
      ]) {
        equal(deniedReason(path), null, path);
      }
    });
  });

  describe("resolveInside()", () => {
    it("resolves relative paths inside the package", () => {
      equal(resolveInside("dist/index.js.map", "../index.ts"), "index.ts");
      equal(
        resolveInside("dist/src/headers/a.js.map", "../../../src/headers/a.ts"),
        "src/headers/a.ts",
      );
      equal(resolveInside("index.js", "index.js.map"), "index.js.map");
      equal(resolveInside("dist/a.js", "./a.js.map"), "dist/a.js.map");
    });

    it("refuses absolute paths, URLs and paths outside the package", () => {
      for (const target of [
        "",
        "/Users/dev/binden/index.ts",
        "C:/dev/binden/index.ts",
        "C:\\dev\\binden\\index.ts",
        "..\\index.ts",
        "file:///dev/binden/index.ts",
        "webpack://binden/index.ts",
        "data:application/json;base64,e30=",
        "../../index.ts",
        "../../../packages/binden/index.ts",
        "..",
        "../dist/..",
      ]) {
        equal(resolveInside("dist/index.js.map", target), null, target);
      }
    });
  });

  describe("packageErrors()", () => {
    it("accepts maps that point to the published sources", () => {
      deepEqual(
        errors({
          "index.ts": "export {};",
          "src/a.ts": "export {};",
          "dist/index.js": "export {};\n//# sourceMappingURL=index.js.map\n",
          "dist/index.js.map": map(["../index.ts"], {
            file: "index.js",
            sourceRoot: "",
          }),
          "dist/index.d.ts": "export {};\n//# sourceMappingURL=index.d.ts.map",
          "dist/index.d.ts.map": map(["../index.ts"]),
          "dist/src/a.js": "//# sourceMappingURL=a.js.map",
          "dist/src/a.js.map": map(["../../src/a.ts"]),
          "dist/plain.js": "export {};",
          "package.json": "{}",
        }),
        [],
      );
    });

    it("refuses files that must not be published, without reading them", () => {
      deepEqual(
        packageErrors(["dist/test/a.js.map", "secret.pem"], () => {
          throw new Error("read");
        }),
        [
          "dist/test/a.js.map: a file of a test/ directory must not be published",
          "secret.pem: a certificate or a key must not be published",
        ],
      );
    });

    it("refuses maps with absolute or outside sources", () => {
      deepEqual(
        errors({
          "index.ts": "",
          "dist/index.js": "",
          "dist/index.js.map": map([
            "/Users/dev/binden/index.ts",
            "../../index.ts",
            "file:///dev/index.ts",
            null,
          ]),
        }),
        [
          'dist/index.js.map: source "/Users/dev/binden/index.ts" is not a relative path inside the package',
          'dist/index.js.map: source "../../index.ts" is not a relative path inside the package',
          'dist/index.js.map: source "file:///dev/index.ts" is not a relative path inside the package',
          "dist/index.js.map: source null is not a relative path inside the package",
        ],
      );
    });

    it("refuses maps whose sources are not published", () => {
      deepEqual(
        errors({
          "dist/index.js": "",
          "dist/index.js.map": map(["../index.ts", "../test/a.ts"]),
        }),
        [
          "dist/index.js.map: source index.ts is not published",
          "dist/index.js.map: source test/a.ts is not published",
        ],
      );
    });

    it("refuses a sourceRoot", () => {
      deepEqual(
        errors({
          "index.ts": "",
          "dist/index.js": "",
          "dist/index.js.map": map(["../index.ts"], {
            sourceRoot: "/Users/dev/binden/",
          }),
        }),
        [
          'dist/index.js.map: sourceRoot "/Users/dev/binden/" (the sources must be relative to the map)',
        ],
      );
    });

    it("refuses maps without their generated file or without sources", () => {
      deepEqual(
        errors({
          "index.ts": "",
          "dist/index.js.map": map(["../index.ts"]),
          "dist/a.js": "",
          "dist/a.js.map": map([]),
        }),
        [
          "dist/index.js.map: its generated file is not published",
          "dist/a.js.map: no sources",
        ],
      );
    });

    it("refuses invalid maps", () => {
      for (const content of [
        "{",
        "null",
        JSON.stringify({ version: 2, sources: ["../index.ts"] }),
        JSON.stringify({ version: 3, sources: "../index.ts" }),
      ]) {
        deepEqual(
          errors({ "index.ts": "", "dist/index.js": "", "a.map": content }),
          ["a.map: invalid source map"],
          content,
        );
      }
    });

    it("refuses links to maps that are not published or not relative", () => {
      deepEqual(
        errors({
          "dist/a.js": "//# sourceMappingURL=a.js.map\n",
          "dist/b.mjs": "//# sourceMappingURL=/Users/dev/dist/b.mjs.map",
          "dist/c.d.ts":
            "//@ sourceMappingURL=data:application/json;base64,e30=",
          "dist/d.cjs": "//# sourceMappingURL=../../d.cjs.map",
          "dist/e.d.mts": "//# sourceMappingURL=e.d.mts.js",
          "dist/f.js": "//# sourceMappingURL=\n",
        }),
        [
          "dist/a.js: sourceMappingURL dist/a.js.map is not published",
          'dist/b.mjs: sourceMappingURL "/Users/dev/dist/b.mjs.map" is not a relative path to a map inside the package',
          'dist/c.d.ts: sourceMappingURL "data:application/json;base64,e30=" is not a relative path to a map inside the package',
          'dist/d.cjs: sourceMappingURL "../../d.cjs.map" is not a relative path to a map inside the package',
          'dist/e.d.mts: sourceMappingURL "e.d.mts.js" is not a relative path to a map inside the package',
          'dist/f.js: sourceMappingURL "" is not a relative path to a map inside the package',
        ],
      );
    });

    it("only reads the link at the end of a generated file", () => {
      deepEqual(
        errors({
          "dist/a.js":
            'const a = "//# sourceMappingURL=/abs/a.js.map";\nexport { a };\n',
          "README.md": "//# sourceMappingURL=/abs/a.js.map",
        }),
        [],
      );
    });
  });
});
