import { deepEqual, equal } from "node:assert/strict";
import { deniedReason, packageErrors, resolveInside } from "./pack-rules.mjs";
import { describe, it } from "node:test";
import { Script } from "node:vm";

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

    it("refuses more credentials, keys, tests and mocks", () => {
      for (const [path, reason] of [
        ["_netrc", "a credential file"],
        ["src/_netrc", "a credential file"],
        [".yarnrc.yml", "a credential file"],
        [".aws/credentials", "a credential file"],
        ["src/.aws/credentials", "a credential file"],
        [".pgpass", "a credential file"],
        ["src/.htpasswd", "a credential file"],
        ["credentials.json", "a credential file"],
        ["src/credentials.json", "a credential file"],
        [".docker/config.json", "a credential file"],
        ["src/.kube/config", "a credential file"],
        [".envrc", "an environment file"],
        ["src/.envrc", "an environment file"],
        ["release.asc", "a certificate or a key"],
        ["secring.gpg", "a certificate or a key"],
        ["client.pkcs12", "a certificate or a key"],
        ["chain.p7b", "a certificate or a key"],
        ["vault.kdbx", "a certificate or a key"],
        ["client.ovpn", "a certificate or a key"],
        ["dist/a-test.js", "a test"],
        ["dist/a-test.d.ts", "a test"],
        ["test.js", "a test"],
        ["dist/test.js", "a test"],
        ["dist/test.d.mts", "a test"],
        ["dist/a.e2e.js", "a test"],
        ["src/a.e2e.ts", "a test"],
        ["dist/spec/a.js", "a file of a spec/ directory"],
        ["dist/e2e/a.js", "a file of a e2e/ directory"],
        ["dist/__fixtures__/a.js", "a file of a __fixtures__/ directory"],
        ["dist/fixture/a.json", "a file of a fixture/ directory"],
        ["dist/testdata/a.txt", "a file of a testdata/ directory"],
        ["dist/mocks/a.js", "a file of a mocks/ directory"],
        ["dist/a.mock.js", "a mock"],
        ["src/server.mock.ts", "a mock"],
      ]) {
        equal(deniedReason(path), reason, path);
      }
    });

    // id_rsa, id_dsa, id_ecdsa and id_ed25519, their security-key (`_sk`) and public
    // (`.pub`) variants: other names that start with `id_` are modules
    it("refuses the keys of SSH by their names only", () => {
      for (const type of ["rsa", "dsa", "ecdsa", "ed25519"]) {
        for (const name of [
          `id_${type}`,
          `src/id_${type}.pub`,
          `id_${type}_sk`,
          `src/id_${type}_sk.pub`,
          `src/ID_${type.toUpperCase()}_SK.PUB`,
        ]) {
          equal(deniedReason(name), "a certificate or a key", name);
        }
      }
      for (const path of [
        "dist/id_token.js",
        "dist/src/id_token.d.ts",
        "src/id_card.ts",
        "dist/id_rsa_utils.js",
        "dist/id_ed25519.pubkey.js",
        "id_",
      ]) {
        equal(deniedReason(path), null, path);
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
        ["src/_NETRC", "a credential file"],
        [".YarnRC.YML", "a credential file"],
        [".AWS/Credentials", "a credential file"],
        [".PGPASS", "a credential file"],
        [".HTPasswd", "a credential file"],
        ["Credentials.JSON", "a credential file"],
        [".Docker/Config.json", "a credential file"],
        [".KUBE/CONFIG", "a credential file"],
        [".ENV", "an environment file"],
        [".Env.Local", "an environment file"],
        [".ENVRC", "an environment file"],
        ["a.ASC", "a certificate or a key"],
        ["a.Gpg", "a certificate or a key"],
        ["a.PKCS12", "a certificate or a key"],
        ["a.P7B", "a certificate or a key"],
        ["a.KDBX", "a certificate or a key"],
        ["a.OVPN", "a certificate or a key"],
        ["dist/a-TEST.js", "a test"],
        ["dist/Test.js", "a test"],
        ["dist/a.E2E.js", "a test"],
        ["dist/a.Mock.js", "a mock"],
        ["dist/SPEC/a.js", "a file of a spec/ directory"],
        ["dist/E2E/a.js", "a file of a e2e/ directory"],
        ["dist/__Fixtures__/a.js", "a file of a __fixtures__/ directory"],
        ["dist/Fixture/a.js", "a file of a fixture/ directory"],
        ["dist/TestData/a.js", "a file of a testdata/ directory"],
        ["dist/Mocks/a.js", "a file of a mocks/ directory"],
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
        "dist/mock.js",
        "dist/src/mockup.js",
        "dist/specification/a.js",
        "dist/e2e-helpers.js",
        "dist/testdata.js",
        "dist/src/tested.js",
        "dist/a-test-utils.js",
        "dist/fixtures.js",
        "src/credentials.ts",
        "src/aws/credentials.ts",
        "src/kube/config.ts",
        "src/docker/config.json",
        "dist/netrc.js",
        "src/yarnrc.ts",
        "src/envrc.ts",
        "src/keys.ts",
        "src/ascii.ts",
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

    // A link is a URL (ECMA-426): it is resolved against the URL of its file, then decoded
    it("resolves the links as URLs, into decoded paths", () => {
      for (const [from, target, path] of [
        ["dist/index.js.map", "a%20b.ts", "dist/a b.ts"],
        ["dist/index.js.map", "a b.ts", "dist/a b.ts"],
        ["dist/index.js.map", "%C3%A9.ts", "dist/é.ts"],
        ["dist/index.js.map", "é.ts", "dist/é.ts"],
        ["dist/index.js.map", "a%25.ts", "dist/a%.ts"],
        ["dist/index.js.map", "./a/../b/./c.ts", "dist/b/c.ts"],
        ["dist/a b/%.js.map", "../%23.ts", "dist/#.ts"],
        ["dist/a?#.js", "./a%3F%23.js.map", "dist/a?#.js.map"],
      ]) {
        equal(resolveInside(from, target), path, target);
      }
    });

    // A URL parser decodes `%2e` into a dot (`%2e%2e` is a `..` segment) and reads a
    // backslash as a slash, drops tabs and newlines and trims spaces: these are refused
    it("refuses the links that a URL parser reads otherwise than a path", () => {
      for (const target of [
        "%2e%2e/%2e%2e/escape.js.map",
        "%2E%2E/%2E%2E/escape.js.map",
        ".%2E/.%2e/escape.js.map",
        "%2e./index.ts",
        "%2e/index.ts",
        "a/%2e%2e/b.ts",
        "..%2f..%2fescape.js.map",
        "..%2F..%2Fescape.js.map",
        "..%5c..%5cescape.js.map",
        "..%5C..%5Cescape.js.map",
        "a\\b.ts",
        "index.js.map?raw",
        "index.js.map#x",
        "a\u0000b.ts",
        "a%00b.ts",
        "a%09b.ts",
        "a%7Fb.ts",
        ".\t./.\n./escape.js.map",
        "a\u007fb.ts",
        " ../index.ts",
        "../index.ts ",
        "//host/index.ts",
        "a%zz.ts",
        "%E9.ts",
      ]) {
        equal(resolveInside("dist/index.js.map", target), null, target);
      }
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

    // The path where the generated file was built is a local path too
    it("refuses a file that is not relative to the map", () => {
      deepEqual(
        errors({
          "index.ts": "",
          "dist/a.js": "",
          "dist/a.js.map": map(["../index.ts"], { file: "a.js" }),
          "dist/b.js": "",
          "dist/b.js.map": map(["../index.ts"], { file: "" }),
          "dist/c.js": "",
          "dist/c.js.map": map(["../index.ts"], {
            file: "/Users/me/dist/c.js",
          }),
          "dist/d.js": "",
          "dist/d.js.map": map(["../index.ts"], { file: "file:///me/d.js" }),
          "dist/e.js": "",
          "dist/e.js.map": map(["../index.ts"], { file: "../../e.js" }),
          "dist/f.js": "",
          "dist/f.js.map": map(["../index.ts"], { file: 1 }),
        }),
        [
          'dist/c.js.map: file "/Users/me/dist/c.js" is not a relative path inside the package',
          'dist/d.js.map: file "file:///me/d.js" is not a relative path inside the package',
          'dist/e.js.map: file "../../e.js" is not a relative path inside the package',
          "dist/f.js.map: file 1 is not a relative path inside the package",
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

    // The paths of the encoded dot segments exist as files: as URLs, they point elsewhere
    it("refuses encoded dot segments in links and in maps", () => {
      const dots = "%2e%2e/%2e%2e";
      deepEqual(
        errors({
          "index.ts": "",
          [`dist/${dots}/index.ts`]: "",
          // Literal names, which their own links reach
          [`dist/${dots}/a.js.map`]: map(["index.ts"]),
          [`dist/${dots}/a.js`]: "",
          "dist/a.js": `//# sourceMappingURL=${dots}/a.js.map\n`,
          "dist/b.js": "",
          "dist/b.js.map": map([`${dots}/index.ts`]),
          "dist/c.js": "",
          "dist/c.js.map": map(["../index.ts"], { file: `${dots}/c.js` }),
          "dist/d.js": "",
          "dist/d.js.map": map(["../index.ts"], { file: ".%2E/d.js" }),
        }),
        [
          `dist/a.js: sourceMappingURL "${dots}/a.js.map" is not a relative path to a map inside the package`,
          `dist/b.js.map: source "${dots}/index.ts" is not a relative path inside the package`,
          `dist/c.js.map: file "${dots}/c.js" is not a relative path inside the package`,
          'dist/d.js.map: file ".%2E/d.js" is not a relative path inside the package',
        ],
      );
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

    // Every link is checked, not only the last one
    it("checks every link of a file, in both comment forms", () => {
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
          "dist/e.js: sourceMappingURL dist/e.js.map is not published",
          'dist/e.js: sourceMappingURL "/abs/e.js.map" is not a relative path to a map inside the package',
          "dist/f.d.ts: sourceMappingURL dist/f.d.ts.map is not published",
          'dist/f.d.ts: sourceMappingURL "" is not a relative path to a map inside the package',
        ],
      );
    });

    it("accepts links to published maps, in both comment forms", () => {
      deepEqual(
        errors({
          "index.ts": "",
          "dist/a.js":
            "//# sourceMappingURL=a.js.map\nexport {};\n//# sourceMappingURL=a.js.map\n",
          "dist/a.js.map": map(["../index.ts"]),
          "dist/b.js": "export {};\n/*# sourceMappingURL=b.js.map */\n",
          "dist/b.js.map": map(["../index.ts"]),
          "dist/c.js": "export {};\n/*@ sourceMappingURL=c.js.map*/",
          "dist/c.js.map": map(["../index.ts"]),
          "dist/d.js": "export {};\r\n//# sourceMappingURL=d.js.map\r\n",
          "dist/d.js.map": map(["../index.ts"]),
          "dist/e.css": "a {}\n/*# sourceMappingURL=e.css.map */\n",
          "dist/e.css.map": map(["../index.ts"]),
        }),
        [],
      );
    });

    // V8 takes the last COMMENT: a string or a template literal after it hides it from a
    // search of the last match, and anything after the URL in its comment makes V8 ignore
    // that comment (so another one may be followed)
    it("refuses an absolute link that a later match or a trailing token hides", () => {
      const files = {
        "index.ts": "",
        "dist/index.js.map": map(["../index.ts"]),
        "dist/index.js": "x\n//# sourceMappingURL=index.js.map\n",
        "dist/m8.js":
          'x\n//# sourceMappingURL=/abs/m8.js.map\nconst s = "//# sourceMappingURL=index.js.map";\n',
        "dist/m9.js":
          "x\n//# sourceMappingURL=/abs/m9.js.map\nconst s = `/*# sourceMappingURL=index.js.map */`;\n",
        "dist/m13.js": "x\n//# sourceMappingURL=index.js.map /abs/x.map\n",
        "dist/m14.js": "x\n/*# sourceMappingURL=index.js.map\n/abs/x.map */\n",
        "dist/m15.js": "x\n//# sourceMappingURL=/abs/m15.js.map\u2028x\n",
      };
      // What V8 follows for the first two
      for (const [path, url] of [
        ["dist/m8.js", "/abs/m8.js.map"],
        ["dist/m9.js", "/abs/m9.js.map"],
      ]) {
        equal(new Script(files[path].replace("x\n", "0;\n")).sourceMapURL, url);
      }
      deepEqual(errors(files), [
        'dist/m8.js: sourceMappingURL "/abs/m8.js.map" is not a relative path to a map inside the package',
        'dist/m8.js: sourceMappingURL "index.js.map\\";" is not a relative path to a map inside the package',
        'dist/m9.js: sourceMappingURL "/abs/m9.js.map" is not a relative path to a map inside the package',
        'dist/m13.js: sourceMappingURL "index.js.map /abs/x.map" is not a relative path to a map inside the package',
        'dist/m14.js: sourceMappingURL "index.js.map\\n/abs/x.map" is not a relative path to a map inside the package',
        'dist/m15.js: sourceMappingURL "/abs/m15.js.map" is not a relative path to a map inside the package',
      ]);
    });

    // A string that looks like a link is checked too (the safe side), in every file: Node.js
    // runs TypeScript sources, and bundlers or browsers read other files than JavaScript
    it("checks the links of every file, not only of the generated ones", () => {
      deepEqual(
        errors({
          "dist/a.js":
            'const a = "//# sourceMappingURL=/abs/a.js.map";\nexport { a };\n',
          "README.md": "//# sourceMappingURL=/abs/a.js.map",
          "index.ts": "//# sourceMappingURL=/abs/index.ts.map",
          "dist/b.jsx": "x\n//# sourceMappingURL=/abs/b.map\n",
          "dist/c.css": "x\n/*# sourceMappingURL=/abs/c.css.map */",
          LICENSE: "MIT",
        }),
        [
          'dist/a.js: sourceMappingURL "/abs/a.js.map\\";" is not a relative path to a map inside the package',
          'README.md: sourceMappingURL "/abs/a.js.map" is not a relative path to a map inside the package',
          'index.ts: sourceMappingURL "/abs/index.ts.map" is not a relative path to a map inside the package',
          'dist/b.jsx: sourceMappingURL "/abs/b.map" is not a relative path to a map inside the package',
          'dist/c.css: sourceMappingURL "/abs/c.css.map" is not a relative path to a map inside the package',
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

    // The cases of the second review (pack-sneak2): each one, added to a valid package, is
    // refused, and the package stays valid without it
    it("refuses every file that the second review slipped through", () => {
      const valid = {
        "dist/index.js": "x\n//# sourceMappingURL=index.js.map\n",
        "dist/index.js.map": map(["../index.ts"]),
        "index.ts": "x",
      };
      const base64 = (value) =>
        Buffer.from(JSON.stringify(value)).toString("base64");
      const candidates = {
        "src/x.asc": "",
        "src/x.gpg": "",
        "src/x.kdbx": "",
        "src/x.pkcs12": "",
        "src/x.p7b": "",
        "src/credentials.json": "",
        ".aws/credentials": "",
        "src/.pgpass": "",
        "src/.htpasswd": "",
        "src/.yarnrc.yml": "",
        "src/.envrc": "",
        "src/_netrc": "",
        "src/.docker/config.json": "",
        "src/.kube/config": "",
        "src/x.ovpn": "",
        "dist/a-test.js": "",
        "dist/test.js": "",
        "dist/a.e2e.js": "",
        "dist/spec/a.js": "",
        "dist/e2e/a.js": "",
        "dist/__fixtures__/a.js": "",
        "dist/fixture/a.js": "",
        "dist/testdata/a.js": "",
        "dist/mocks/a.js": "",
        "dist/a.mock.js": "",
        "dist/m1.js": "x\n//@ sourceMappingURL=/abs/m1.js.map\n",
        "dist/m2.cjs": "x\n/*@ sourceMappingURL=/abs/m2.cjs.map */",
        "dist/m3.d.mts": "x\n//#sourceMappingURL=/abs/m3.map",
        "dist/m4.js": "x\n//# sourceMappingURL=file:///abs/m4.js.map",
        "dist/m5.js": "x\n//# sourceMappingURL=//host/m5.js.map",
        "dist/m6.js": "x\n//# sourceMappingURL=C:\\abs\\m6.js.map",
        "dist/m7.js": `x\n//# sourceMappingURL=data:application/json;base64,${base64({ version: 3, sources: ["/Users/me/src/x.ts"] })}`,
        "dist/m8.js":
          'x\n//# sourceMappingURL=/abs/m8.js.map\nconst s = "//# sourceMappingURL=index.js.map";\n',
        "dist/m9.js":
          "x\n//# sourceMappingURL=/abs/m9.js.map\nconst s = `/*# sourceMappingURL=index.js.map */`;\n",
        "dist/m10.jsx": "x\n//# sourceMappingURL=/abs/m10.map\n",
        "dist/m11.ts": "x\n//# sourceMappingURL=/abs/m11.map\n",
        "dist/m12.css": "x\n/*# sourceMappingURL=/abs/m12.css.map */",
        "dist/m13.js": "x\n//# sourceMappingURL=index.js.map /abs/x.map\n",
        "dist/m14.js.MAP": map(["/abs/x.ts"]),
        "dist/m15.js.map": map(["../index.ts"], { sourceRoot: "/Users/me" }),
        "dist/m16.js.map": map(["../index.ts"], {
          file: "/Users/me/dist/m16.js",
        }),
      };
      deepEqual(errors(valid), []);
      for (const [path, content] of Object.entries(candidates)) {
        const files = { ...valid, [path]: content };
        if (/\.map$/iu.test(path)) {
          files[path.slice(0, -".map".length)] = "x";
        }
        const refused = errors(files);
        equal(refused.length > 0, true, path);
        for (const error of refused) {
          equal(error.startsWith(`${path}: `), true, error);
        }
      }
    });
  });
});
