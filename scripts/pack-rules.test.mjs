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

    it("refuses mocks, Go-style tests, keys and credential files", () => {
      for (const [path, reason] of [
        ["dist/__mocks__/a.js", "a file of a __mocks__/ directory"],
        ["__mocks__/fs.ts", "a file of a __mocks__/ directory"],
        ["dist/a_test.js", "a test"],
        ["src/server_test.ts", "a test"],
        ["dist/a_test.d.ts", "a test"],
        ["src/id_rsa", "a certificate or a key"],
        ["id_ed25519", "a certificate or a key"],
        ["src/id_ecdsa.pub", "a certificate or a key"],
        ["keys/release.jks", "a certificate or a key"],
        ["android.keystore", "a certificate or a key"],
        ["AuthKey_ABC123.p8", "a certificate or a key"],
        ["src/putty.ppk", "a certificate or a key"],
        [".netrc", "a credential file"],
        ["src/.netrc", "a credential file"],
        [".pypirc", "a credential file"],
        ["dist/.git-credentials", "a credential file"],
      ]) {
        equal(deniedReason(path), reason, path);
      }
    });

    // On the case-insensitive file systems of macOS and Windows, they are the same files
    it("compares the names without case", () => {
      for (const [path, reason] of [
        ["dist/Test/a.js", "a file of a test/ directory"],
        ["TESTS/a.ts", "a file of a tests/ directory"],
        ["src/__Tests__/a.ts", "a file of a __tests__/ directory"],
        ["src/__MOCKS__/a.ts", "a file of a __mocks__/ directory"],
        ["Fixtures/a.json", "a file of a fixtures/ directory"],
        ["Certs/a.txt", "a file of a certs/ directory"],
        ["CERT/a.txt", "a file of a cert/ directory"],
        ["Coverage/lcov.info", "a file of a coverage/ directory"],
        ["Node_Modules/a/index.js", "a file of a node_modules/ directory"],
        [".GIT/config", "a file of a .git/ directory"],
        ["src/a.Test.ts", "a test"],
        ["dist/a.SPEC.js", "a test"],
        ["dist/a_TEST.js", "a test"],
        ["src/server.PEM", "a certificate or a key"],
        ["src/ID_RSA", "a certificate or a key"],
        ["a.JKS", "a certificate or a key"],
        ["a.KeyStore", "a certificate or a key"],
        ["a.P8", "a certificate or a key"],
        ["a.PPK", "a certificate or a key"],
        [".NETRC", "a credential file"],
        [".PyPIrc", "a credential file"],
        [".Git-Credentials", "a credential file"],
        [".ENV", "an environment file"],
        [".Env.Local", "an environment file"],
        [".NPMRC", "an npm configuration file"],
        ["NPM-DEBUG.LOG", "a build artefact"],
        ["binden-1.0.0.TGZ", "a build artefact"],
        ["tsconfig.TsBuildInfo", "a build artefact"],
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
        "src/identity.ts",
        "dist/src/request-id.js",
        "dist/src/valid_id.js",
        "dist/src/latest_tests.js",
        "dist/src/contest.js",
        "dist/Testing/a.js",
        "dist/mocks/a.js",
        "src/credentials.ts",
        "dist/netrc.js",
        "src/keys.ts",
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

    // Node.js and the browsers follow the last link, wherever it is (not only at the end)
    it("checks the last link of a generated file, in both comment forms", () => {
      deepEqual(
        errors({
          "dist/a.js":
            "export {};\n//# sourceMappingURL=/abs/a.js.map\n// generated\n",
          "dist/b.js": "export {};\n/*# sourceMappingURL=/abs/b.js.map */\n",
          "dist/c.mjs": "/*@ sourceMappingURL=/abs/c.mjs.map*/",
          "dist/d.cjs": "/*#sourceMappingURL=/abs/d.cjs.map",
          "dist/e.js":
            "//# sourceMappingURL=e.js.map\n//# sourceMappingURL=/abs/e.js.map\n",
          "dist/f.d.ts":
            "/*# sourceMappingURL=f.d.ts.map */\n//@ sourceMappingURL=\n",
          "dist/g.js":
            "/* sourceMappingURL=/abs/g.js.map */\n// sourceMappingURL=/abs/g.js.map\n",
        }),
        [
          'dist/a.js: sourceMappingURL "/abs/a.js.map" is not a relative path to a map inside the package',
          'dist/b.js: sourceMappingURL "/abs/b.js.map" is not a relative path to a map inside the package',
          'dist/c.mjs: sourceMappingURL "/abs/c.mjs.map" is not a relative path to a map inside the package',
          'dist/d.cjs: sourceMappingURL "/abs/d.cjs.map" is not a relative path to a map inside the package',
          'dist/e.js: sourceMappingURL "/abs/e.js.map" is not a relative path to a map inside the package',
          'dist/f.d.ts: sourceMappingURL "" is not a relative path to a map inside the package',
        ],
      );
    });

    it("accepts a last link to a published map, in both comment forms", () => {
      deepEqual(
        errors({
          "index.ts": "",
          "dist/a.js":
            "//# sourceMappingURL=/abs/a.js.map\nexport {};\n//# sourceMappingURL=a.js.map\n",
          "dist/a.js.map": map(["../index.ts"]),
          "dist/b.js": "export {};\n/*# sourceMappingURL=b.js.map */\n",
          "dist/b.js.map": map(["../index.ts"]),
          "dist/c.js": "export {};\n/*@ sourceMappingURL=c.js.map*/",
          "dist/c.js.map": map(["../index.ts"]),
        }),
        [],
      );
    });

    // A string that looks like a link is checked too (the safe side): the generated files of
    // the packages have no such string
    it("checks a link inside a string of a generated file, not of other files", () => {
      deepEqual(
        errors({
          "dist/a.js":
            'const a = "//# sourceMappingURL=/abs/a.js.map";\nexport { a };\n',
          "README.md": "//# sourceMappingURL=/abs/a.js.map",
          "index.ts": "//# sourceMappingURL=/abs/index.ts.map",
        }),
        [
          'dist/a.js: sourceMappingURL "/abs/a.js.map\\";" is not a relative path to a map inside the package',
        ],
      );
    });

    it("recognises generated files and maps without case", () => {
      deepEqual(
        errors({
          "dist/A.JS": "//# sourceMappingURL=/abs/A.JS.map",
          "dist/B.D.TS": "export {};",
          "dist/B.D.TS.MAP": map(["/abs/b.ts"]),
          "dist/C.MJS": "//# sourceMappingURL=C.MJS.Map",
        }),
        [
          'dist/A.JS: sourceMappingURL "/abs/A.JS.map" is not a relative path to a map inside the package',
          'dist/B.D.TS.MAP: source "/abs/b.ts" is not a relative path inside the package',
          "dist/C.MJS: sourceMappingURL dist/C.MJS.Map is not published",
        ],
      );
    });

    // The cases of the review of the rules (pack-sneak): each one is refused next to a
    // package whose own maps are valid
    it("refuses every file that the review slipped through", () => {
      const valid = {
        "dist/index.js": "x\n//# sourceMappingURL=index.js.map\n",
        "dist/index.js.map": map(["../index.ts"]),
        "index.ts": "x",
      };
      deepEqual(errors(valid), []);
      for (const [path, content, error] of [
        ["src/server.PEM", "k", "a certificate or a key"],
        [
          "src/id_rsa",
          "-----BEGIN OPENSSH PRIVATE KEY-----",
          "a certificate or a key",
        ],
        ["src/.netrc", "machine x login y password z", "a credential file"],
        ["src/key.jks", "k", "a certificate or a key"],
        ["dist/Test/a.js", "x", "a file of a test/ directory"],
        ["dist/a_test.js", "x", "a test"],
        ["dist/__mocks__/a.js", "x", "a file of a __mocks__/ directory"],
        [
          "dist/abs.js",
          "x\n//# sourceMappingURL=/Users/me/abs.js.map\n// generated\n",
          'sourceMappingURL "/Users/me/abs.js.map"',
        ],
        [
          "dist/abs2.js",
          "x\n/*# sourceMappingURL=/Users/me/abs2.js.map */\n",
          'sourceMappingURL "/Users/me/abs2.js.map"',
        ],
        [
          "dist/abs3.js",
          "x\n//# sourceMappingURL=/Users/me/abs3.js.map\n",
          'sourceMappingURL "/Users/me/abs3.js.map"',
        ],
      ]) {
        const [refused, ...rest] = errors({ ...valid, [path]: content });
        deepEqual(rest, [], path);
        equal(refused?.startsWith(`${path}: `), true, path);
        equal(refused.includes(error), true, refused);
      }
    });
  });
});
