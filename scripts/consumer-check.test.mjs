import { afterEach, beforeEach, describe, it } from "node:test";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { deepEqual, equal, match } from "node:assert/strict";
import { integrity, manifestFile } from "./tarballs.mjs";
import { join } from "node:path";
import { npmInstallation } from "./fixtures/npm-installation.mjs";
import { npmTarball } from "./fixtures/tar.mjs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

// A fake npm CLI (run as the CLI of an npm installation, `npm_execpath`: see
// fixtures/npm-installation.mjs) that logs its arguments and fails, so that the check
// stops at its first npm command (before anything is installed)
const fakeNpm = `require("node:fs").appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(1);
`;

describe("scripts/consumer-check.mjs", () => {
  let dir = "";
  // The CLI of the npm installation of the fake
  let cli = "";

  const check = (...args) =>
    spawnSync(
      process.execPath,
      [join(import.meta.dirname, "consumer-check.mjs"), ...args],
      {
        encoding: "utf8",
        timeout: 60_000,
        env: {
          ...process.env,
          npm_execpath: cli,
          FAKE_NPM_LOG: join(dir, "npm.log"),
        },
      },
    );
  const npmCalls = () => {
    try {
      return readFileSync(join(dir, "npm.log"), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };

  // Archives prepared by `scripts/release.mjs pack`
  const prepare = () => {
    const packages = ["a", "b"].map((name) => {
      const file = `${name}-1.0.0.tgz`;
      const data = npmTarball({ "package.json": JSON.stringify({ name }) });
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
    return packages.map(({ file }) => join(dir, file));
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "binden-consumer-check-"));
    writeFileSync(join(dir, "npm.cjs"), fakeNpm);
    cli = npmInstallation(dir, join(dir, "npm.cjs"));
  });

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  it("--tarballs installs the prepared archives without packing", () => {
    const archives = prepare();
    const { status } = check("--tarballs", dir);
    equal(status, 1);
    const [[command, ...args], ...rest] = npmCalls();
    equal(command, "install");
    deepEqual(
      args.filter((arg) => arg.endsWith(".tgz")),
      archives,
    );
    deepEqual(rest, []);
  });

  it("packs the workspaces without --tarballs", () => {
    const { status } = check();
    equal(status, 1);
    deepEqual(
      npmCalls().map(([command]) => command),
      ["pack"],
    );
  });

  it("--tarballs refuses an archive that changed", () => {
    const [, b] = prepare();
    appendFileSync(b, "x");
    const { status, stderr } = check("--tarballs", dir);
    equal(status, 1);
    match(stderr, /b-1\.0\.0\.tgz: integrity sha512-\S+ differs from/u);
    deepEqual(npmCalls(), []);
  });

  it("--tarballs needs a directory", () => {
    for (const args of [
      ["--tarballs"],
      ["--tarballs", ""],
      ["--tarballs", "--x"],
    ]) {
      const { status, stderr } = check(...args);
      equal(status, 1);
      match(stderr, /Usage: scripts\/consumer-check\.mjs --tarballs <dir>/u);
    }
    deepEqual(npmCalls(), []);
  });
});
