import { afterEach, beforeEach, describe, it } from "node:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
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

// A fake `npm` that logs its arguments and emulates `npm view` (E404 unless the
// package version is listed in FAKE_NPM_PUBLISHED, or a network error with
// FAKE_NPM_OFFLINE). Every other command succeeds without doing anything.
const fakeNpm = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "view") {
  if (process.env.FAKE_NPM_OFFLINE) {
    process.stderr.write("npm error code ECONNREFUSED\\n");
    process.exit(1);
  }
  const spec = args[1];
  const published = (process.env.FAKE_NPM_PUBLISHED ?? "").split(",");
  if (published.includes(spec)) {
    process.stdout.write(JSON.stringify(spec.slice(spec.lastIndexOf("@") + 1)));
  } else {
    process.stdout.write(JSON.stringify({ error: { code: "E404" } }));
    process.exit(1);
  }
}
`;

const manifests = {
  "packages/a": { name: "@fixture/a", version: "1.0.0" },
  "packages/b": {
    name: "@fixture/b",
    version: "1.0.0",
    dependencies: { "@fixture/a": "^1.0.0" },
  },
  "packages/c": {
    name: "@fixture/c",
    version: "1.0.0",
    peerDependencies: { "@fixture/b": "^1.0.0" },
    devDependencies: { "left-pad": "^1.3.0" },
  },
};

describe("scripts/release.mjs", () => {
  let root = "";

  const writeJSON = (file, data) => {
    writeFileSync(join(root, file), `${JSON.stringify(data, null, 2)}\n`);
  };
  const readJSON = (file) => JSON.parse(readFileSync(join(root, file), "utf8"));

  const release = (args, env = {}) =>
    spawnSync(process.execPath, [join(root, "scripts/release.mjs"), ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
        FAKE_NPM_LOG: join(root, "npm.log"),
        ...env,
      },
    });

  const npmCalls = (command) => {
    const log = join(root, "npm.log");
    return existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line))
          .filter(([name]) => name === command)
      : [];
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "binden-release-"));
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "bin"));
    copyFileSync(
      join(import.meta.dirname, "release.mjs"),
      join(root, "scripts/release.mjs"),
    );
    writeFileSync(join(root, "bin/npm"), fakeNpm);
    chmodSync(join(root, "bin/npm"), 0o755);
    writeJSON("package.json", {
      private: true,
      workspaces: Object.keys(manifests),
    });
    for (const [dir, manifest] of Object.entries(manifests)) {
      mkdirSync(join(root, dir), { recursive: true });
      writeJSON(`${dir}/package.json`, manifest);
    }
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  it("check passes when the workspaces are in lockstep", () => {
    const { status, stderr } = release(["check"]);
    equal(status, 0);
    match(stderr, /3 workspaces in lockstep at 1\.0\.0/u);
  });

  it("check fails on a version drift", () => {
    writeJSON("packages/c/package.json", {
      ...manifests["packages/c"],
      version: "1.0.1",
    });
    const { status, stderr } = release(["check"]);
    equal(status, 1);
    match(stderr, /packages\/c: version 1\.0\.1 != 1\.0\.0/u);
  });

  it("check fails on an internal range drift", () => {
    writeJSON("packages/b/package.json", {
      ...manifests["packages/b"],
      dependencies: { "@fixture/a": "^0.9.0" },
    });
    const { status, stderr } = release(["check"]);
    equal(status, 1);
    match(
      stderr,
      /dependencies\.@fixture\/a is \^0\.9\.0, expected \^1\.0\.0/u,
    );
  });

  it("verify passes when no workspace is published (E404)", () => {
    const { status, stderr } = release(["verify", "2.0.0"]);
    equal(status, 0);
    match(stderr, /no workspace is published at 2\.0\.0 yet/u);
  });

  it("verify fails when a workspace is already published", () => {
    const env = { FAKE_NPM_PUBLISHED: "@fixture/b@2.0.0" };
    const { status, stderr } = release(["verify", "2.0.0"], env);
    equal(status, 1);
    match(stderr, /Already published at 2\.0\.0: @fixture\/b/u);
  });

  it("verify fails on registry errors (not only on E404)", () => {
    const env = { FAKE_NPM_OFFLINE: "1" };
    const { status, stderr } = release(["verify", "2.0.0"], env);
    equal(status, 1);
    match(stderr, /ECONNREFUSED/u);
  });

  it("verify and version reject an invalid version", () => {
    for (const command of ["verify", "version"]) {
      const { status, stderr } = release([command, "2.x"]);
      equal(status, 1);
      match(stderr, /Invalid version: 2\.x/u);
    }
  });

  it("version updates every workspace and the lockfile", () => {
    const { status } = release(["version", "2.0.0"]);
    equal(status, 0);
    deepEqual(readJSON("packages/a/package.json").version, "2.0.0");
    deepEqual(readJSON("packages/b/package.json").dependencies, {
      "@fixture/a": "^2.0.0",
    });
    const c = readJSON("packages/c/package.json");
    deepEqual(c.version, "2.0.0");
    deepEqual(c.peerDependencies, { "@fixture/b": "^2.0.0" });
    deepEqual(c.devDependencies, { "left-pad": "^1.3.0" });
    deepEqual(npmCalls("install"), [
      ["install", "--package-lock-only", "--ignore-scripts"],
    ]);
  });

  it("publish publishes every workspace in the workspaces order", () => {
    const { status } = release(["publish"]);
    equal(status, 0);
    deepEqual(
      npmCalls("publish"),
      Object.keys(manifests).map((dir) => ["publish", "--workspace", dir]),
    );
  });

  it("publish refuses to publish workspaces out of lockstep", () => {
    writeJSON("packages/b/package.json", {
      ...manifests["packages/b"],
      version: "1.0.1",
    });
    const { status, stderr } = release(["publish", "--skip-existing"]);
    equal(status, 1);
    match(stderr, /not in lockstep/u);
    deepEqual(npmCalls("publish"), []);
  });

  it("publish --skip-existing skips published workspaces", () => {
    const env = { FAKE_NPM_PUBLISHED: "@fixture/a@1.0.0" };
    const { status } = release(["publish", "--skip-existing"], env);
    equal(status, 0);
    deepEqual(npmCalls("publish"), [
      ["publish", "--workspace", "packages/b"],
      ["publish", "--workspace", "packages/c"],
    ]);
  });

  it("fails on an unknown command", () => {
    const { status, stderr } = release(["deploy"]);
    equal(status, 1);
    match(stderr, /Unknown command: deploy/u);
  });
});
