import { afterEach, beforeEach, describe, it } from "node:test";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { deepEqual, doesNotMatch, equal, match, ok } from "node:assert/strict";
import { integrity, manifestFile } from "./tarballs.mjs";
import { join } from "node:path";
import { npmTarball } from "./fixtures/tar.mjs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const fakeNpm = join(import.meta.dirname, "fixtures", "fake-npm.mjs");

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
// The `workspaces` order is the reverse of the dependency order (c needs b, which needs a)
const workspaces = ["packages/c", "packages/b", "packages/a"];
const names = ["@fixture/a", "@fixture/b", "@fixture/c"];
const files = ["README.md", "index.js", "package.json"];

// SemVer 2.0.0 (https://semver.org), without build metadata (dropped by npm)
const validVersions = [
  "0.0.0",
  "1.2.3",
  "10.20.30",
  "999999999999.0.0",
  "1.0.0-0",
  "1.0.0-alpha",
  "1.0.0-alpha.1",
  "1.0.0-0.3.7",
  "1.0.0-x.7.z.92",
  "1.0.0-x-y-z.--",
  "1.0.0-0a",
  "1.0.0--1",
  "1.0.0-rc.1",
  "0.0.0-development",
];
const invalidVersions = [
  "1",
  "1.2",
  "1.2.3.4",
  "01.2.3",
  "1.02.3",
  "1.2.03",
  "-1.2.3",
  "1.2.x",
  "2.x",
  "v1.2.3",
  " 1.2.3",
  "1.2.3 ",
  "1.2.3\n",
  "1.2.3-",
  "1.2.3-01",
  "1.2.3-00",
  "1.2.3-a..b",
  "1.2.3-a.",
  "1.2.3-.a",
  "1.2.3-a_b",
  "1.2.3-ä",
  "1.2.3+",
  "1.2.3+a..b",
  "1.2.3+a_b",
  "1.2.3-a+",
];
// Valid SemVer, but npm publishes `1.0.0+a` as `1.0.0`
const buildVersions = ["1.0.0+build", "1.0.0+001", "1.0.0-rc.1+build.1-x"];

describe("scripts/release.mjs", () => {
  let root = "";
  let out = "";

  const path = (file) => join(root, file);
  const writeJSON = (file, data) => {
    writeFileSync(path(file), `${JSON.stringify(data, null, 2)}\n`);
  };
  const readJSON = (file) => JSON.parse(readFileSync(path(file), "utf8"));

  const release = (args, env = {}) =>
    spawnSync(process.execPath, [path("scripts/release.mjs"), ...args], {
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        npm_execpath: fakeNpm,
        FAKE_NPM_LOG: path("npm.log"),
        FAKE_NPM_REGISTRY: path("registry.json"),
        ...env,
      },
    });
  const succeed = (args, env) => {
    const { status, stderr } = release(args, env);
    equal(status, 0, stderr);
    return stderr;
  };

  // Without the hooks and the signing of the user
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
        "-c",
        "core.autocrlf=false",
        ...args,
      ],
      { cwd: root, encoding: "utf8", timeout: 60_000 },
    );
    equal(status, 0, stderr);
    return stdout.trim();
  };
  const commit = (message) => {
    git("add", "-A");
    git("commit", "-q", "--no-verify", "--allow-empty", "-m", message);
    return git("rev-parse", "HEAD");
  };

  const npmCalls = (...commands) => {
    const log = path("npm.log");
    return existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line))
          .filter(([name]) => commands.includes(name))
      : [];
  };
  function registry() {
    return existsSync(path("registry.json")) ? readJSON("registry.json") : {};
  }
  const release2 = () => readJSON(`release/${manifestFile}`).packages;

  // `version` and `pack` of 2.0.0, tagged as semantic-release does
  const prepare = () => {
    succeed(["version", "2.0.0"]);
    succeed(["pack", out]);
    git("tag", "v2.0.0");
    rmSync(path("npm.log"));
    return release2();
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "binden-release-"));
    out = path("release");
    mkdirSync(path("scripts"));
    for (const script of ["release.mjs", "npm.mjs", "tarballs.mjs"]) {
      copyFileSync(
        join(import.meta.dirname, script),
        path(`scripts/${script}`),
      );
    }
    writeJSON(
      "scripts/pack-files.json",
      Object.fromEntries(names.map((name) => [name, files])),
    );
    writeJSON("package.json", { private: true, workspaces });
    writeJSON("package-lock.json", { lockfileVersion: 3 });
    writeFileSync(path(".gitignore"), "npm.log\nregistry.json\nrelease/\n");
    for (const [dir, manifest] of Object.entries(manifests)) {
      mkdirSync(path(dir), { recursive: true });
      writeJSON(`${dir}/package.json`, manifest);
      writeFileSync(path(`${dir}/index.js`), `export const name = "${dir}";\n`);
      writeFileSync(path(`${dir}/README.md`), `# ${manifest.name}\n`);
    }
    git("init", "-q");
    commit("initial");
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  describe("check", () => {
    it("passes when the workspaces are in lockstep", () => {
      match(succeed(["check"]), /3 workspaces in lockstep at 1\.0\.0/u);
    });

    it("fails on a version drift", () => {
      writeJSON("packages/a/package.json", {
        ...manifests["packages/a"],
        version: "1.0.1",
      });
      const { status, stderr } = release(["check"]);
      equal(status, 1);
      match(stderr, /packages\/a: version 1\.0\.1 != 1\.0\.0/u);
    });

    it("fails on an internal range drift", () => {
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
  });

  describe("versions", () => {
    it("accepts SemVer versions", () => {
      for (const version of validVersions) {
        const { status, stderr } = release(["verify", version]);
        equal(status, 0, `${version}: ${stderr}`);
      }
    });

    it("refuses anything else", () => {
      for (const version of invalidVersions) {
        for (const command of ["verify", "version"]) {
          const { status, stderr } = release([command, version]);
          equal(status, 1, version);
          ok(stderr.includes(`Invalid version: ${version}`), stderr);
        }
      }
      deepEqual(npmCalls("view", "install"), []);
      equal(readJSON("packages/a/package.json").version, "1.0.0");
    });

    it("refuses build metadata, which npm drops", () => {
      for (const version of buildVersions) {
        for (const command of ["verify", "version"]) {
          const { status, stderr } = release([command, version]);
          equal(status, 1, version);
          ok(
            stderr.includes(
              `Build metadata is not supported by npm: ${version}`,
            ),
            stderr,
          );
        }
      }
      deepEqual(npmCalls("view", "install"), []);
    });
  });

  describe("verify", () => {
    it("passes when no workspace is published (E404)", () => {
      match(
        succeed(["verify", "2.0.0"]),
        /no workspace is published at 2\.0\.0 yet/u,
      );
      deepEqual(npmCalls("view").length, 3);
    });

    it("fails when a workspace is already published", () => {
      writeJSON("registry.json", { "@fixture/b@2.0.0": { version: "2.0.0" } });
      const { status, stderr } = release(["verify", "2.0.0"]);
      equal(status, 1);
      match(stderr, /Already published at 2\.0\.0: @fixture\/b/u);
    });

    it("fails on registry errors (not only on E404)", () => {
      for (const error of ["ECONNREFUSED", "E401", "E500", "crash"]) {
        const env = {
          FAKE_NPM_VIEW_ERROR: error,
          FAKE_NPM_VIEW_ERROR_SPEC: "@fixture/a@2.0.0",
        };
        const { status, stderr } = release(["verify", "2.0.0"], env);
        equal(status, 1, error);
        doesNotMatch(stderr, /no workspace is published/u);
      }
    });
  });

  describe("version", () => {
    it("updates every workspace, its gitHead and the lockfile", () => {
      const head = git("rev-parse", "HEAD");
      succeed(["version", "2.0.0"]);
      deepEqual(readJSON("packages/a/package.json"), {
        name: "@fixture/a",
        version: "2.0.0",
        gitHead: head,
      });
      deepEqual(readJSON("packages/b/package.json").dependencies, {
        "@fixture/a": "^2.0.0",
      });
      const c = readJSON("packages/c/package.json");
      deepEqual(c.version, "2.0.0");
      deepEqual(c.gitHead, head);
      deepEqual(c.peerDependencies, { "@fixture/b": "^2.0.0" });
      deepEqual(c.devDependencies, { "left-pad": "^1.3.0" });
      deepEqual(npmCalls("install"), [
        [
          "install",
          "--package-lock-only",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
        ],
      ]);
    });

    it("records the commit of HEAD", () => {
      succeed(["version", "2.0.0"]);
      const head = commit("later");
      succeed(["version", "2.0.1"]);
      equal(readJSON("packages/b/package.json").gitHead, head);
    });
  });

  describe("pack", () => {
    it("packs every workspace once and lists the archives in dependency order", () => {
      const head = git("rev-parse", "HEAD");
      succeed(["version", "2.0.0"]);
      succeed(["pack", out]);
      deepEqual(npmCalls("pack"), [
        ["pack", "--workspaces", "--pack-destination", out, "--loglevel=warn"],
      ]);
      deepEqual(
        release2(),
        names.map((name) => {
          const file = `${name.slice(1).replace("/", "-")}-2.0.0.tgz`;
          return {
            name,
            version: "2.0.0",
            sha: head,
            integrity: integrity(readFileSync(join(out, file))),
            file,
          };
        }),
      );
    });

    it("refuses a directory that is not empty", () => {
      succeed(["version", "2.0.0"]);
      mkdirSync(out);
      writeFileSync(join(out, "stale.tgz"), "");
      const { status, stderr } = release(["pack", out]);
      equal(status, 1);
      match(stderr, /release is not empty/u);
      deepEqual(npmCalls("pack"), []);
    });

    it("refuses changes that are not committed", () => {
      succeed(["version", "2.0.0"]);
      appendFileSync(path("packages/a/index.js"), "// changed\n");
      const { status, stderr } = release(["pack", out]);
      equal(status, 1);
      match(stderr, /Uncommitted changes: packages\/a\/index\.js\n/u);
      deepEqual(npmCalls("pack"), []);
    });

    it("refuses workspaces out of lockstep", () => {
      writeJSON("packages/b/package.json", {
        ...manifests["packages/b"],
        version: "1.0.1",
      });
      const { status, stderr } = release(["pack", out]);
      equal(status, 1);
      match(stderr, /not in lockstep/u);
      deepEqual(npmCalls("pack"), []);
    });

    it("refuses archives without the gitHead of HEAD", () => {
      const before = git("rev-parse", "HEAD");
      const { status, stderr } = release(["pack", out]);
      equal(status, 1);
      for (const name of names) {
        const file = `${name.slice(1).replace("/", "-")}-1.0.0.tgz`;
        ok(
          stderr.includes(`${file}: gitHead undefined, expected ${before}`),
          stderr,
        );
      }
      equal(existsSync(join(out, manifestFile)), false);

      succeed(["version", "2.0.0"]);
      const head = commit("later");
      rmSync(out, { recursive: true });
      const later = release(["pack", out]);
      equal(later.status, 1);
      match(
        later.stderr,
        new RegExp(
          `fixture-a-2\\.0\\.0\\.tgz: gitHead ${before}, expected ${head}`,
          "u",
        ),
      );
      equal(existsSync(join(out, manifestFile)), false);
    });

    it("refuses archives of another version or package", () => {
      succeed(["version", "2.0.0"]);
      for (const [patch, errors] of [
        [
          { "packages/b": { version: "2.0.1" } },
          [/fixture-b-2\.0\.0\.tgz: version 2\.0\.1, expected 2\.0\.0/u],
        ],
        [
          { "packages/c": { name: "@fixture/x" } },
          [
            /@fixture\/c: no archive/u,
            /fixture-c-2\.0\.0\.tgz: @fixture\/x is not a workspace/u,
          ],
        ],
        [
          { "packages/b": { name: "@fixture/a" } },
          [/another archive of @fixture\/a/u, /@fixture\/b: no archive/u],
        ],
      ]) {
        rmSync(out, { force: true, recursive: true });
        const env = { FAKE_NPM_PACK_PATCH: JSON.stringify(patch) };
        const { status, stderr } = release(["pack", out], env);
        equal(status, 1);
        for (const error of errors) {
          match(stderr, error);
        }
        equal(existsSync(join(out, manifestFile)), false);
      }
    });

    it("refuses archives with unexpected or missing files", () => {
      writeFileSync(path("packages/a/secret.pem"), "secret");
      writeJSON("scripts/pack-files.json", {
        "@fixture/a": files,
        "@fixture/b": [...files, "dist/index.js"],
        "@fixture/c": files,
      });
      commit("files");
      succeed(["version", "2.0.0"]);
      const { status, stderr } = release(["pack", out]);
      equal(status, 1);
      match(
        stderr,
        /fixture-a-2\.0\.0\.tgz: @fixture\/a: unexpected secret\.pem/u,
      );
      match(
        stderr,
        /fixture-b-2\.0\.0\.tgz: @fixture\/b: missing dist\/index\.js/u,
      );
      equal(existsSync(join(out, manifestFile)), false);
    });

    it("fails when npm cannot pack", () => {
      succeed(["version", "2.0.0"]);
      const { status } = release(["pack", out], { FAKE_NPM_FAIL_PACK: "1" });
      equal(status, 1);
      equal(existsSync(join(out, manifestFile)), false);
    });

    it("refuses circular dependencies", () => {
      writeJSON("packages/a/package.json", {
        ...manifests["packages/a"],
        peerDependencies: { "@fixture/c": "^1.0.0" },
      });
      commit("circular");
      succeed(["version", "2.0.0"]);
      const { status, stderr } = release(["pack", out]);
      equal(status, 1);
      match(
        stderr,
        /Circular dependencies between @fixture\/c, @fixture\/b, @fixture\/a/u,
      );
    });
  });

  describe("publish", () => {
    it("publishes the archives in dependency order once all are checked", () => {
      const packages = prepare();
      succeed(["publish", out]);
      deepEqual(npmCalls("view", "publish"), [
        ...names.map((name) => ["view", `${name}@2.0.0`, "--json"]),
        ...packages.map(({ file }) => ["publish", join(out, file)]),
      ]);
      deepEqual(
        registry(),
        Object.fromEntries(
          packages.map(({ name, sha, integrity: sum }) => [
            `${name}@2.0.0`,
            { name, version: "2.0.0", gitHead: sha, dist: { integrity: sum } },
          ]),
        ),
      );
    });

    it("--dry-run does not upload anything", () => {
      const packages = prepare();
      succeed(["publish", out, "--dry-run"]);
      deepEqual(
        npmCalls("publish"),
        packages.map(({ file }) => ["publish", join(out, file), "--dry-run"]),
      );
      deepEqual(registry(), {});
    });

    it("publishes nothing when a version is already published", () => {
      const [a] = prepare();
      const document = { gitHead: a.sha, dist: { integrity: a.integrity } };
      writeJSON("registry.json", { "@fixture/a@2.0.0": document });
      const { status, stderr } = release(["publish", out]);
      equal(status, 1);
      match(
        stderr,
        /Nothing is published:\n {2}@fixture\/a@2\.0\.0 is already published/u,
      );
      deepEqual(npmCalls("publish"), []);
    });

    it("publishes nothing when the registry has another archive", () => {
      const [, b] = prepare();
      for (const document of [
        { gitHead: "0".repeat(40), dist: { integrity: b.integrity } },
        { gitHead: b.sha, dist: { integrity: integrity("other") } },
        { dist: { integrity: b.integrity } },
        { gitHead: b.sha },
      ]) {
        writeJSON("registry.json", { "@fixture/b@2.0.0": document });
        for (const options of [[], ["--skip-existing"]]) {
          const { status, stderr } = release(["publish", out, ...options]);
          equal(status, 1);
          match(
            stderr,
            /@fixture\/b@2\.0\.0 is published from another archive/u,
          );
        }
      }
      deepEqual(npmCalls("publish"), []);
    });

    it("publishes nothing on registry errors (not only on E404)", () => {
      prepare();
      for (const error of ["ECONNREFUSED", "E401", "E500", "crash"]) {
        const env = {
          FAKE_NPM_VIEW_ERROR: error,
          FAKE_NPM_VIEW_ERROR_SPEC: "@fixture/c@2.0.0",
        };
        for (const options of [[], ["--skip-existing"]]) {
          const { status } = release(["publish", out, ...options], env);
          equal(status, 1, error);
        }
      }
      deepEqual(npmCalls("publish"), []);
      deepEqual(registry(), {});
    });

    it("recovers a release that stopped at any package", () => {
      const packages = prepare();
      const calls = packages.map(({ file }) => ["publish", join(out, file)]);
      for (const [index, { name }] of packages.entries()) {
        rmSync(path("registry.json"), { force: true });
        rmSync(path("npm.log"), { force: true });
        const failed = release(["publish", out], {
          FAKE_NPM_FAIL_PUBLISH: name,
        });
        equal(failed.status, 1);
        deepEqual(
          Object.keys(registry()),
          names.slice(0, index).map((published) => `${published}@2.0.0`),
        );

        rmSync(path("npm.log"));
        const stderr = succeed(["publish", out, "--skip-existing"]);
        deepEqual(npmCalls("publish"), calls.slice(index));
        for (const skipped of names.slice(0, index)) {
          ok(
            stderr.includes(`skip ${skipped}@2.0.0: already published`),
            stderr,
          );
        }
        deepEqual(
          Object.keys(registry()).sort(),
          names.map((published) => `${published}@2.0.0`),
        );
      }
    });

    it("publishes nothing when an archive changed after pack", () => {
      const [, b] = prepare();
      appendFileSync(join(out, b.file), "x");
      const { status, stderr } = release(["publish", out]);
      equal(status, 1);
      match(
        stderr,
        /fixture-b-2\.0\.0\.tgz: integrity sha512-\S+ differs from/u,
      );
      deepEqual(npmCalls("view", "publish"), []);
    });

    it("publishes nothing when an archive is not the one of the release", () => {
      const packages = prepare();
      const head = git("rev-parse", "HEAD");
      const manifest = (fields) =>
        JSON.stringify({ ...readJSON("packages/b/package.json"), ...fields });
      for (const [content, error] of [
        [
          { "package.json": manifest({ gitHead: "0".repeat(40) }) },
          new RegExp(
            `fixture-b-2\\.0\\.0\\.tgz: gitHead 0{40}, expected ${head}`,
            "u",
          ),
        ],
        [
          { "package.json": manifest({ version: "2.0.1" }) },
          /fixture-b-2\.0\.0\.tgz: version 2\.0\.1, expected 2\.0\.0/u,
        ],
        [
          { "package.json": manifest({ name: "@fixture/a" }) },
          /fixture-b-2\.0\.0\.tgz: name @fixture\/a, expected @fixture\/b/u,
        ],
        [
          { "package.json": manifest({}), "secret.pem": "" },
          /fixture-b-2\.0\.0\.tgz: @fixture\/b: unexpected secret\.pem/u,
        ],
      ]) {
        const data = npmTarball({
          "README.md": "",
          "index.js": "",
          ...content,
        });
        writeFileSync(join(out, packages[1].file), data);
        const [a, b, c] = packages;
        writeJSON(`release/${manifestFile}`, {
          packages: [a, { ...b, integrity: integrity(data) }, c],
        });
        const { status, stderr } = release(["publish", out]);
        equal(status, 1);
        match(stderr, error);
      }
      deepEqual(npmCalls("view", "publish"), []);
    });

    it("publishes nothing from another commit than the one of the archives", () => {
      prepare();
      const head = commit("later");
      const { status, stderr } = release(["publish", out]);
      equal(status, 1);
      match(
        stderr,
        new RegExp(
          `fixture-a-2\\.0\\.0\\.tgz: 2\\.0\\.0 from [\\da-f]{40}, expected 2\\.0\\.0 from ${head} \\(HEAD\\)`,
          "u",
        ),
      );
      deepEqual(npmCalls("view", "publish"), []);
    });

    it("publishes nothing when the manifest is not the one of the workspaces", () => {
      const packages = prepare();
      const head = git("rev-parse", "HEAD");
      for (const [manifest, error] of [
        [packages.slice(0, 2), /@fixture\/c: not in release-manifest\.json/u],
        [[...packages, packages[0]], /another archive of @fixture\/a/u],
        [
          [...packages, { ...packages[0], name: "@fixture/x" }],
          /fixture-a-2\.0\.0\.tgz: @fixture\/x is not a workspace/u,
        ],
        [
          packages.map((entry) => ({ ...entry, version: "2.0.1" })),
          /: 2\.0\.1 from [\da-f]{40}, expected 2\.0\.0 from/u,
        ],
        [
          packages.map((entry) => ({ ...entry, sha: "0".repeat(40) })),
          new RegExp(
            `: 2\\.0\\.0 from 0{40}, expected 2\\.0\\.0 from ${head} \\(HEAD\\)`,
            "u",
          ),
        ],
      ]) {
        writeJSON(`release/${manifestFile}`, { packages: manifest });
        const { status, stderr } = release(["publish", out]);
        equal(status, 1);
        match(stderr, error);
      }
      deepEqual(npmCalls("view", "publish"), []);
    });

    it("refuses workspaces out of lockstep", () => {
      prepare();
      writeJSON("packages/b/package.json", {
        ...readJSON("packages/b/package.json"),
        version: "2.0.1",
      });
      const { status, stderr } = release(["publish", out, "--skip-existing"]);
      equal(status, 1);
      match(stderr, /not in lockstep/u);
      deepEqual(npmCalls("view", "publish"), []);
    });

    it("--skip-existing publishes from the commit of the tag only", () => {
      prepare();
      commit("later");
      const { status, stderr } = release(["publish", out, "--skip-existing"]);
      equal(status, 1);
      match(stderr, /is not the commit of v2\.0\.0/u);

      git("tag", "-d", "v2.0.0");
      const untagged = release(["publish", out, "--skip-existing"]);
      equal(untagged.status, 1);
      deepEqual(npmCalls("view", "publish"), []);
    });

    it("fails without the manifest", () => {
      succeed(["version", "2.0.0"]);
      const { status, stderr } = release(["publish", out]);
      equal(status, 1);
      match(stderr, /ENOENT/u);
      deepEqual(npmCalls("view", "publish"), []);
    });
  });

  // The commands that semantic-release runs are the ones that the rehearsal runs
  it(".releaserc.json verifies, then versions and packs, then publishes the archives", () => {
    const { plugins } = JSON.parse(
      readFileSync(join(import.meta.dirname, "../.releaserc.json"), "utf8"),
    );
    const [, exec] = plugins.find(
      (plugin) =>
        Array.isArray(plugin) && plugin[0] === "@semantic-release/exec",
    );
    match(
      exec.verifyReleaseCmd,
      /^node scripts\/release\.mjs verify \$\{nextRelease\.version\}$/u,
    );
    match(
      exec.prepareCmd,
      /^node scripts\/release\.mjs version \$\{nextRelease\.version\} && node scripts\/release\.mjs pack "\$RELEASE_DIR"$/u,
    );
    equal(exec.publishCmd, 'node scripts/release.mjs publish "$RELEASE_DIR"');
  });

  describe("arguments", () => {
    it("fails on an unknown command", () => {
      const { status, stderr } = release(["deploy"]);
      equal(status, 1);
      match(stderr, /Unknown command: deploy/u);
    });

    it("fails on an unknown option", () => {
      for (const args of [
        ["pack", "release", "--skip-existing"],
        ["publish", "release", "--force"],
        ["version", "2.0.0", "--dry-run"],
      ]) {
        const { status, stderr } = release(args);
        equal(status, 1);
        match(stderr, /Unknown option: --/u);
      }
      deepEqual(npmCalls("view", "install", "pack", "publish"), []);
    });

    it("fails without exactly one operand", () => {
      for (const [command, operand] of [
        ["verify", "version"],
        ["version", "version"],
        ["pack", "dir"],
        ["publish", "dir"],
      ]) {
        for (const args of [
          [command],
          [command, ""],
          [command, "1.0.0", "2.0.0"],
        ]) {
          const { status, stderr } = release(args);
          equal(status, 1);
          ok(
            stderr.includes(
              `Usage: scripts/release.mjs ${command} <${operand}>`,
            ),
            stderr,
          );
        }
      }
      deepEqual(npmCalls("view", "install", "pack", "publish"), []);
    });
  });
});
