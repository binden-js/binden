import { afterEach, beforeEach, describe, it } from "node:test";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { deepEqual, doesNotMatch, equal, match } from "node:assert/strict";
import { dirname, join } from "node:path";
import { integrity, manifestFile } from "./tarballs.mjs";
import { npmInstallation } from "./fixtures/npm-installation.mjs";
import { npmTarball } from "./fixtures/tar.mjs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

// A fake npm CLI (run as the CLI of an npm installation, `npm_execpath`: see
// fixtures/npm-installation.mjs) that logs its arguments to FAKE_NPM_LOG, whose
// `npm pack --json` prints FAKE_NPM_PACK, whose `npm run` does nothing, and that fails
// for anything else
const fakeNpm = `const { appendFileSync } = require("node:fs");
appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[2] === "run") process.exit(0);
if (process.argv[2] !== "pack") process.exit(1);
process.stdout.write(process.env.FAKE_NPM_PACK);\n`;

// A source map of `sources`, with a relative `sourceRoot` as `tsc` writes it
const map = (sources, extra = {}) =>
  JSON.stringify({
    version: 3,
    sources,
    sourceRoot: "",
    mappings: "",
    ...extra,
  });

// The files of a workspace whose maps point to its published sources
const mapped = {
  "dist/index.js": "export {};\n//# sourceMappingURL=index.js.map\n",
  "dist/index.js.map": map(["../index.ts"]),
  "index.ts": "export {};\n",
  "package.json": "{}",
};

const packed = (files) =>
  JSON.stringify(
    Object.entries(files).map(([name, paths]) => ({
      name,
      files: paths.map((path) => ({ path })),
    })),
  );

describe(".github/secret_scanning.yml", () => {
  it("excludes the key of the tests of binden, and nothing else", () => {
    const repository = join(import.meta.dirname, "..");
    const config = readFileSync(
      join(repository, ".github/secret_scanning.yml"),
      "utf8",
    );
    const entries = config
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("#"));
    deepEqual(entries, [
      "paths-ignore:",
      `  - "packages/binden/test/cert/key.pem"`,
    ]);
    match(
      readFileSync(
        join(repository, "packages/binden/test/cert/key.pem"),
        "utf8",
      ),
      /^-----BEGIN /u,
    );
  });
});

describe("scripts/pack-check.mjs", () => {
  let root = "";
  // The CLI of the npm installation of the fake
  let cli = "";
  // The workspaces of the root
  const names = new Set();

  const check = (files, ...args) =>
    spawnSync(
      process.execPath,
      [join(root, "scripts/pack-check.mjs"), ...args],
      {
        encoding: "utf8",
        timeout: 60_000,
        env: {
          ...process.env,
          npm_execpath: cli,
          FAKE_NPM_PACK: packed(files),
          FAKE_NPM_LOG: join(root, "npm.log"),
        },
      },
    );

  // The commands that the fake npm ran
  const npmCalls = () =>
    readFileSync(join(root, "npm.log"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line));

  // A workspace `packages/<name>` of the root with `files` ({ path: content }): every
  // packed file is read from the disk (the links to source maps of each one are checked)
  const workspace = (name, files) => {
    names.add(name);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        workspaces: [...names].map(
          (workspaceName) => `packages/${workspaceName}`,
        ),
      }),
    );
    for (const [path, content] of Object.entries({
      ...files,
      "package.json": JSON.stringify({ name }),
    })) {
      mkdirSync(join(root, "packages", name, dirname(path)), {
        recursive: true,
      });
      writeFileSync(join(root, "packages", name, path), content);
    }
  };

  // Archives prepared by `scripts/release.mjs pack` (only the parts that are checked):
  // the files of each package as a list of paths (`{}` as their content), or as
  // { path: content }
  const prepare = (files) => {
    const dir = join(root, "release");
    mkdirSync(dir);
    const packages = Object.entries(files).map(([name, paths]) => {
      const file = `${name}-1.0.0.tgz`;
      const data = npmTarball(
        Array.isArray(paths)
          ? Object.fromEntries(paths.map((path) => [path, "{}"]))
          : paths,
      );
      writeFileSync(join(dir, file), data);
      return {
        name,
        version: "1.0.0",
        sha: "0",
        integrity: integrity(data),
        file,
      };
    });
    writeFileSync(join(dir, manifestFile), JSON.stringify({ packages }));
    return dir;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "binden-pack-check-"));
    names.clear();
    mkdirSync(join(root, "scripts"));
    for (const script of [
      "pack-check.mjs",
      "pack-rules.mjs",
      "npm.mjs",
      "tarballs.mjs",
    ]) {
      copyFileSync(
        join(import.meta.dirname, script),
        join(root, "scripts", script),
      );
    }
    writeFileSync(join(root, "npm.cjs"), fakeNpm);
    cli = npmInstallation(root, join(root, "npm.cjs"));
    writeFileSync(
      join(root, "scripts/pack-files.json"),
      JSON.stringify({ a: ["LICENSE", "dist/index.js", "package.json"] }),
    );
    workspace("a", { "dist/index.js": "export {};\n", LICENSE: "MIT\n" });
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  it("passes with the expected files", () => {
    const { status, stderr } = check({
      a: ["dist/index.js", "package.json", "LICENSE"],
    });
    equal(status, 0);
    match(stderr, /1 workspaces with the expected files/u);
  });

  it("copies the documents of the workspaces before packing them", () => {
    const { status } = check({
      a: ["dist/index.js", "package.json", "LICENSE"],
    });
    equal(status, 0);
    deepEqual(npmCalls(), [
      ["run", "documents", "--workspaces", "--if-present"],
      ["pack", "--dry-run", "--json", "--workspaces", "--ignore-scripts"],
    ]);
  });

  it("fails when the documents cannot be copied", () => {
    writeFileSync(
      join(root, "npm.cjs"),
      `process.exit(process.argv[2] === "run" ? 1 : 0);\n`,
    );
    const { status, stderr } = check({
      a: ["dist/index.js", "package.json", "LICENSE"],
    });
    equal(status, 1);
    match(stderr, /Command failed: .*run documents --workspaces --if-present/u);
  });

  it("refuses tests, certificates and secrets even when they are expected", () => {
    workspace("a", { "README.md": "# a\n" });
    const files = {
      a: ["dist/test/a.test.js", "key.pem", ".npmrc", "README.md"],
    };
    writeFileSync(join(root, "scripts/pack-files.json"), JSON.stringify(files));
    const { status, stderr } = check(files);
    equal(status, 1);
    match(stderr, /break the rules of scripts\/pack-rules\.mjs/u);
    match(stderr, /a: dist\/test\/a\.test\.js: a file of a test\/ directory/u);
    match(stderr, /a: key\.pem: a certificate or a key must not be published/u);
    match(
      stderr,
      /a: \.npmrc: an npm configuration file must not be published/u,
    );
    doesNotMatch(stderr, /README/u);
    doesNotMatch(stderr, /differ from scripts\/pack-files\.json/u);
  });

  it("reports the rules together with the differences", () => {
    const { status, stderr } = check({ a: ["LICENSE", "a.pem"] });
    equal(status, 1);
    match(stderr, /a: unexpected a\.pem/u);
    match(stderr, /a: missing dist\/index\.js/u);
    match(stderr, /a: a\.pem: a certificate or a key must not be published/u);
  });

  it("checks the source maps of the workspaces on disk", () => {
    workspace("a", mapped);
    const files = { a: Object.keys(mapped) };
    writeFileSync(join(root, "scripts/pack-files.json"), JSON.stringify(files));
    const passed = check(files);
    equal(passed.status, 0, passed.stderr);

    workspace("a", {
      ...mapped,
      "dist/index.js.map": map(["/Users/dev/binden/index.ts"]),
    });
    const { status, stderr } = check(files);
    equal(status, 1);
    match(
      stderr,
      /a: dist\/index\.js\.map: source "\/Users\/dev\/binden\/index\.ts" is not a relative path inside the package/u,
    );
  });

  it("checks the links to source maps of every packed file on disk", () => {
    workspace("a", {
      ...mapped,
      "index.ts": "export {};\n//# sourceMappingURL=/Users/dev/index.ts.map\n",
    });
    const files = { a: Object.keys(mapped) };
    writeFileSync(join(root, "scripts/pack-files.json"), JSON.stringify(files));
    const { status, stderr } = check(files);
    equal(status, 1);
    match(
      stderr,
      /a: index\.ts: sourceMappingURL "\/Users\/dev\/index\.ts\.map" is not a relative path to a map inside the package/u,
    );
  });

  it("fails to read the files of a package that is not a workspace", () => {
    workspace("a", mapped);
    const { status, stderr } = check({ b: ["dist/index.js.map"] });
    equal(status, 1);
    match(stderr, /b is not a workspace/u);
  });

  it("--update writes nothing when the files break the rules", () => {
    const { status, stderr } = check(
      { a: ["LICENSE", "dist/index.js", "fixtures/a.json", "package.json"] },
      "--update",
    );
    equal(status, 1);
    match(stderr, /a: fixtures\/a\.json: a file of a fixtures\/ directory/u);
    deepEqual(
      JSON.parse(readFileSync(join(root, "scripts/pack-files.json"), "utf8")),
      { a: ["LICENSE", "dist/index.js", "package.json"] },
    );
  });

  it("fails with an unexpected or a missing file", () => {
    const { status, stderr } = check({
      a: ["LICENSE", "dist/test/a.test.js", "package.json"],
    });
    equal(status, 1);
    match(stderr, /a: unexpected dist\/test\/a\.test\.js/u);
    match(stderr, /a: missing dist\/index\.js/u);
  });

  it("fails with the key of the tests, even when it is expected", () => {
    const files = [
      "LICENSE",
      "dist/index.js",
      "package.json",
      "test/cert/key.pem",
    ];
    writeFileSync(
      join(root, "scripts/pack-files.json"),
      JSON.stringify({ a: files }),
    );
    const { status, stderr } = check({ a: files });
    equal(status, 1);
    match(stderr, /a: test\/cert\/key\.pem: \S.* must not be published/u);
    // Nor written as expected
    const update = check({ a: files }, "--update");
    equal(update.status, 1);
    match(
      update.stderr,
      /a: test\/cert\/key\.pem: \S.* must not be published/u,
    );
    deepEqual(
      JSON.parse(readFileSync(join(root, "scripts/pack-files.json"), "utf8")),
      { a: files },
    );
  });

  it("fails with an unexpected workspace", () => {
    workspace("b", { x: "" });
    const { status, stderr } = check({
      a: ["LICENSE", "dist/index.js", "package.json"],
      b: ["x"],
    });
    equal(status, 1);
    match(stderr, /b: unexpected x/u);
  });

  it("--update writes the current files", () => {
    workspace("a", { a: "", b: "" });
    const { status } = check({ a: ["b", "a"] }, "--update");
    equal(status, 0);
    deepEqual(
      JSON.parse(readFileSync(join(root, "scripts/pack-files.json"), "utf8")),
      { a: ["a", "b"] },
    );
  });

  describe("--tarballs", () => {
    it("checks the prepared archives without packing", () => {
      const dir = prepare({ a: ["package.json", "LICENSE", "dist/index.js"] });
      const { status, stderr } = check({}, "--tarballs", dir);
      equal(status, 0, stderr);
      match(stderr, /1 workspaces with the expected files/u);
    });

    it("fails with an unexpected or a missing file or archive", () => {
      const dir = prepare({
        a: ["package.json", "LICENSE", "secret.pem"],
        b: ["package.json"],
      });
      const expected = { a: ["LICENSE", "dist/index.js", "package.json"] };
      const { status, stderr } = check(expected, "--tarballs", dir);
      equal(status, 1);
      match(stderr, /a: unexpected secret\.pem/u);
      match(stderr, /a: missing dist\/index\.js/u);
      match(stderr, /b: unexpected package\.json/u);
    });

    it("checks the source maps inside the archives", () => {
      writeFileSync(
        join(root, "scripts/pack-files.json"),
        JSON.stringify({ a: Object.keys(mapped).sort() }),
      );
      const passed = check({}, "--tarballs", prepare({ a: mapped }));
      equal(passed.status, 0, passed.stderr);

      rmSync(join(root, "release"), { force: true, recursive: true });
      const dir = prepare({
        a: { ...mapped, "dist/index.js.map": map(["../../src/index.ts"]) },
      });
      const { status, stderr } = check({}, "--tarballs", dir);
      equal(status, 1);
      match(
        stderr,
        /a: dist\/index\.js\.map: source "\.\.\/\.\.\/src\/index\.ts" is not a relative path inside the package/u,
      );
    });

    it("refuses certificates inside the archives even when they are expected", () => {
      const files = ["LICENSE", "package.json", "test/cert/key.pem"];
      writeFileSync(
        join(root, "scripts/pack-files.json"),
        JSON.stringify({ a: files }),
      );
      const { status, stderr } = check({}, "--tarballs", prepare({ a: files }));
      equal(status, 1);
      match(stderr, /a: test\/cert\/key\.pem: a file of a test\/ directory/u);
    });

    it("fails when an archive changed after it was prepared", () => {
      const dir = prepare({ a: ["package.json", "LICENSE", "dist/index.js"] });
      appendFileSync(join(dir, "a-1.0.0.tgz"), "x");
      const { status, stderr } = check({}, "--tarballs", dir);
      equal(status, 1);
      match(stderr, /a-1\.0\.0\.tgz: integrity sha512-\S+ differs from/u);
    });

    it("--update writes the files of the archives", () => {
      const dir = prepare({ a: ["package.json", "b"] });
      const { status } = check({}, "--tarballs", dir, "--update");
      equal(status, 0);
      deepEqual(
        JSON.parse(readFileSync(join(root, "scripts/pack-files.json"), "utf8")),
        { a: ["b", "package.json"] },
      );
    });

    it("fails without a directory", () => {
      for (const args of [
        ["--tarballs"],
        ["--tarballs", ""],
        ["--tarballs", "--update"],
      ]) {
        const { status, stderr } = check({}, ...args);
        equal(status, 1);
        match(stderr, /Usage: scripts\/pack-check\.mjs --tarballs <dir>/u);
      }
    });
  });
});
