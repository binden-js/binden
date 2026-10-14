import { afterEach, beforeEach, describe, it } from "node:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { deepEqual, equal, match } from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

// A fake npm CLI (run as `npm_execpath`) whose `npm pack --json` prints FAKE_NPM_PACK
const fakeNpm = `process.stdout.write(process.env.FAKE_NPM_PACK);\n`;

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
        env: {
          ...process.env,
          npm_execpath: join(root, "npm.cjs"),
          FAKE_NPM_PACK: packed(files),
        },
      },
    );

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "binden-pack-check-"));
    mkdirSync(join(root, "scripts"));
    for (const script of ["pack-check.mjs", "npm.mjs"]) {
      copyFileSync(
        join(import.meta.dirname, script),
        join(root, "scripts", script),
      );
    }
    writeFileSync(join(root, "npm.cjs"), fakeNpm);
    writeFileSync(
      join(root, "scripts/pack-files.json"),
      JSON.stringify({ a: ["LICENSE", "dist/index.js"] }),
    );
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  it("passes with the expected files", () => {
    const { status, stderr } = check({ a: ["dist/index.js", "LICENSE"] });
    equal(status, 0);
    match(stderr, /1 workspaces with the expected files/u);
  });

  it("fails with an unexpected or a missing file", () => {
    const { status, stderr } = check({ a: ["LICENSE", "dist/test/a.test.js"] });
    equal(status, 1);
    match(stderr, /a: unexpected dist\/test\/a\.test\.js/u);
    match(stderr, /a: missing dist\/index\.js/u);
  });

  it("fails with an unexpected workspace", () => {
    const { status, stderr } = check({
      a: ["LICENSE", "dist/index.js"],
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
});
