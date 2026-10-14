import { afterEach, beforeEach, describe, it } from "node:test";
import {
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

// A fake npm CLI (run as `npm_execpath`, see scripts/npm.mjs) that logs its
// arguments and emulates `npm view` (E404 unless the package version is listed in
// FAKE_NPM_PUBLISHED, or a network error with FAKE_NPM_OFFLINE), whose `gitHead`
// is FAKE_NPM_GITHEAD, and `npm publish`, which fails for the workspace in
// FAKE_NPM_FAIL_PUBLISH. Every other command succeeds without doing anything.
const fakeNpm = `const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "view") {
  if (process.env.FAKE_NPM_OFFLINE) {
    process.stderr.write("npm error code ECONNREFUSED\\n");
    process.exit(1);
  }
  const spec = args[1];
  const published = (process.env.FAKE_NPM_PUBLISHED ?? "").split(",");
  if (!published.includes(spec)) {
    process.stdout.write(JSON.stringify({ error: { code: "E404" } }));
    process.exit(1);
  } else if (args[2] === "gitHead") {
    const head = process.env.FAKE_NPM_GITHEAD;
    process.stdout.write(head ? JSON.stringify(head) : "");
  } else {
    process.stdout.write(JSON.stringify(spec.slice(spec.lastIndexOf("@") + 1)));
  }
} else if (args[0] === "publish" && args[2] === process.env.FAKE_NPM_FAIL_PUBLISH) {
  process.stderr.write("npm error code E500\\n");
  process.exit(1);
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
        npm_execpath: join(root, "npm.cjs"),
        FAKE_NPM_LOG: join(root, "npm.log"),
        ...env,
      },
    });

  // A repository whose HEAD is the tagged release (without the hooks and the
  // signing of the user)
  const git = (...args) => {
    const { status, stdout, stderr } = spawnSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "tag.gpgsign=false",
        "-c",
        "init.defaultBranch=main",
        ...args,
      ],
      { cwd: root, encoding: "utf8" },
    );
    equal(status, 0, stderr);
    return stdout.trim();
  };
  const tagRelease = () => {
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "--no-verify", "-m", "release");
    git("tag", "v1.0.0");
    return git("rev-parse", "HEAD");
  };

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
    for (const script of ["release.mjs", "npm.mjs"]) {
      copyFileSync(
        join(import.meta.dirname, script),
        join(root, "scripts", script),
      );
    }
    writeFileSync(join(root, "npm.cjs"), fakeNpm);
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

  it("publish stops at the first workspace that fails", () => {
    const env = { FAKE_NPM_FAIL_PUBLISH: "packages/b" };
    const { status, stderr } = release(["publish"], env);
    equal(status, 1);
    match(stderr, /E500/u);
    deepEqual(npmCalls("publish"), [
      ["publish", "--workspace", "packages/a"],
      ["publish", "--workspace", "packages/b"],
    ]);
  });

  it("publish --skip-existing publishes the rest of the tagged release", () => {
    const head = tagRelease();
    const env = {
      FAKE_NPM_PUBLISHED: "@fixture/a@1.0.0",
      FAKE_NPM_GITHEAD: head,
    };
    const { status } = release(["publish", "--skip-existing"], env);
    equal(status, 0);
    deepEqual(npmCalls("publish"), [
      ["publish", "--workspace", "packages/b"],
      ["publish", "--workspace", "packages/c"],
    ]);
  });

  it("publish --skip-existing refuses packages of another commit", () => {
    tagRelease();
    for (const head of ["0".repeat(40), ""]) {
      const env = {
        FAKE_NPM_PUBLISHED: "@fixture/a@1.0.0",
        FAKE_NPM_GITHEAD: head,
      };
      const { status, stderr } = release(["publish", "--skip-existing"], env);
      equal(status, 1);
      match(stderr, /@fixture\/a@1\.0\.0 was published from/u);
    }
    deepEqual(npmCalls("publish"), []);
  });

  it("publish --skip-existing publishes from the commit of the tag only", () => {
    tagRelease();
    writeFileSync(join(root, "later"), "");
    git("add", "-A");
    git("commit", "-q", "--no-verify", "-m", "later");
    const { status, stderr } = release(["publish", "--skip-existing"]);
    equal(status, 1);
    match(stderr, /is not the commit of v1\.0\.0/u);
    deepEqual(npmCalls("publish"), []);

    git("tag", "-d", "v1.0.0");
    const untagged = release(["publish", "--skip-existing"]);
    equal(untagged.status, 1);
    deepEqual(npmCalls("publish"), []);
  });

  it("fails on an unknown command", () => {
    const { status, stderr } = release(["deploy"]);
    equal(status, 1);
    match(stderr, /Unknown command: deploy/u);
  });
});
