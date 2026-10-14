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
import { deepEqual, equal, match } from "node:assert/strict";
import { integrity, manifestFile } from "./tarballs.mjs";
import { join } from "node:path";
import { npmTarball } from "./fixtures/tar.mjs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

// A fake npm CLI (run as `npm_execpath`) whose `npm pack --json` prints FAKE_NPM_PACK,
// and that fails for anything else
const fakeNpm = `if (process.argv[2] !== "pack") process.exit(1);
process.stdout.write(process.env.FAKE_NPM_PACK);\n`;

const packed = (files) =>
  JSON.stringify(
    Object.entries(files).map(([name, paths]) => ({
      name,
      files: paths.map((path) => ({ path })),
    })),
  );

describe("scripts/pack-check.mjs", () => {
  let root = "";

  const check = (files, ...args) =>
    spawnSync(
      process.execPath,
      [join(root, "scripts/pack-check.mjs"), ...args],
      {
        encoding: "utf8",
        timeout: 60_000,
        env: {
          ...process.env,
          npm_execpath: join(root, "npm.cjs"),
          FAKE_NPM_PACK: packed(files),
        },
      },
    );

  // Archives prepared by `scripts/release.mjs pack` (only the parts that are checked)
  const prepare = (files) => {
    const dir = join(root, "release");
    mkdirSync(dir);
    const packages = Object.entries(files).map(([name, paths]) => {
      const file = `${name}-1.0.0.tgz`;
      const data = npmTarball(
        Object.fromEntries(paths.map((path) => [path, "{}"])),
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
    mkdirSync(join(root, "scripts"));
    for (const script of ["pack-check.mjs", "npm.mjs", "tarballs.mjs"]) {
      copyFileSync(
        join(import.meta.dirname, script),
        join(root, "scripts", script),
      );
    }
    writeFileSync(join(root, "npm.cjs"), fakeNpm);
    writeFileSync(
      join(root, "scripts/pack-files.json"),
      JSON.stringify({ a: ["LICENSE", "dist/index.js", "package.json"] }),
    );
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

  it("fails with an unexpected or a missing file", () => {
    const { status, stderr } = check({
      a: ["LICENSE", "dist/test/a.test.js", "package.json"],
    });
    equal(status, 1);
    match(stderr, /a: unexpected dist\/test\/a\.test\.js/u);
    match(stderr, /a: missing dist\/index\.js/u);
  });

  it("fails with an unexpected workspace", () => {
    const { status, stderr } = check({
      a: ["LICENSE", "dist/index.js", "package.json"],
      b: ["x"],
    });
    equal(status, 1);
    match(stderr, /b: unexpected x/u);
  });

  it("--update writes the current files", () => {
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
