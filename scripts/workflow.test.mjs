import { after, before, describe, it } from "node:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { deepEqual, equal, match, ok } from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const workflow = readFileSync(
  join(import.meta.dirname, "../.github/workflows/ci.yml"),
  "utf8",
);

/** The lines of a job of the CI workflow (its key included) */
function job(name) {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  ok(start !== -1, name);
  const end = lines.findIndex(
    (line, index) => index > start && /^ {2}\S/u.test(line),
  );
  return lines.slice(start, end === -1 ? lines.length : end);
}

// The lines that follow `lines[index]` and are indented more than it
function block(lines, index) {
  const indent = lines[index].search(/\S/u);
  const body = [];
  for (const line of lines.slice(index + 1)) {
    if (line.trim() !== "" && line.search(/\S/u) <= indent) {
      break;
    }
    body.push(line);
  }
  const margin = Math.min(
    ...body
      .filter((line) => line.trim() !== "")
      .map((line) => line.search(/\S/u)),
  );
  return body.map((line) => line.slice(margin)).filter((line) => line !== "");
}

/**
 * The steps of a job: `{ name, uses, with, env, run, text }` (`with` and `env` as
 * { key: value }, `run` as its script, `text` the lines of the step without comments)
 */
function steps(name) {
  const lines = job(name);
  const start = lines.indexOf("    steps:");
  ok(start !== -1, `${name}: steps`);
  const items = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("      - ")) {
      items.push([line.replace("      - ", "        ")]);
    } else if (line.trim() !== "" && !line.trim().startsWith("#")) {
      items.at(-1).push(line);
    }
  }
  const map = (stepLines, key) => {
    const index = stepLines.findIndex((line) => line.trim() === `${key}:`);
    return index === -1
      ? {}
      : Object.fromEntries(
          // Without the lines of the block scalars (`path: |`)
          block(stepLines, index)
            .filter((line) => !line.startsWith(" "))
            .map((line) => {
              const separator = line.indexOf(": ");
              return [line.slice(0, separator), line.slice(separator + 2)];
            }),
        );
  };
  return items.map((item) => {
    const field = (key) =>
      item
        .find((line) => line.startsWith(`        ${key}: `))
        ?.slice(`        ${key}: `.length) ?? null;
    const run = item.findIndex((line) => line === "        run: |");
    return {
      name: field("name"),
      uses: field("uses"),
      with: map(item, "with"),
      env: map(item, "env"),
      run: run === -1 ? field("run") : block(item, run).join("\n"),
      text: item.join("\n"),
    };
  });
}

/** The step of a job named `name` */
function step(jobName, name) {
  const found = steps(jobName).filter((item) => item.name === name);
  equal(found.length, 1, `${jobName}: ${name}`);
  return found[0];
}

/** The script (`run: |`) of a step of a job of the CI workflow */
function script(jobName, name) {
  return step(jobName, name).run;
}

/** The value of a key of a job (`needs`, `environment`, …), or null */
function jobKey(name, key) {
  return (
    job(name)
      .find((line) => line.startsWith(`    ${key}:`))
      ?.slice(`    ${key}:`.length)
      .trim() ?? null
  );
}

/** The block of a key of a job (`permissions`, `outputs`, …) as its lines */
function jobBlock(name, key) {
  const lines = job(name);
  const index = lines.indexOf(`    ${key}:`);
  return index === -1 ? null : block(lines, index);
}

/** The names of the jobs of the CI workflow, in their order */
function jobNames() {
  const lines = workflow.split("\n");
  return lines
    .slice(lines.indexOf("jobs:") + 1)
    .map((line) => /^ {2}(?<name>[\w-]+):$/u.exec(line)?.groups.name)
    .filter((name) => typeof name !== "undefined");
}

/**
 * Whether the `if` of a job holds in `context` ({ event_name, ref }): a conjunction of
 * comparisons of `github.event_name` or `github.ref` with a string (anything else fails)
 */
function holds(name, context) {
  const condition = jobKey(name, "if");
  return (
    condition === null ||
    condition.split(" && ").every((term) => {
      const { key, operator, value } =
        /^github\.(?<key>event_name|ref) (?<operator>[!=]=) '(?<value>[^']*)'$/u.exec(
          term,
        )?.groups ?? {};
      ok(typeof key !== "undefined", `${name}: unsupported condition ${term}`);
      return (context[key] === value) === (operator === "==");
    })
  );
}

/** Whether a job runs in `context`: its `if` holds, and the jobs that it needs run */
function runs(name, context) {
  const needs = jobKey(name, "needs");
  const needed =
    needs === null ? [] : needs.replace(/^\[|\]$/gu, "").split(", ");
  return holds(name, context) && needed.every((need) => runs(need, context));
}

/** An expression of GitHub Actions: `${{ <inner> }}` */
const expression = (inner) => `\${{ ${inner} }}`;

// The jobs that pack the archives of a release, and the ones that publish them
const packers = ["package", "recover-package"];
const publishers = { release: "package", recover: "recover-package" };
const runtime = [
  "node --version",
  "npm --version",
  'test "$(node --version)" = v24.16.0',
  'test "$(npm --version)" = 11.13.0',
].join("\n");

describe("the release jobs of .github/workflows/ci.yml", () => {
  it("pins every action to a commit", () => {
    const uses = workflow
      .split("\n")
      .filter((line) => /^\s+(?:- )?uses: /u.test(line));
    ok(uses.length > 0);
    for (const line of uses) {
      match(line, /uses: [\w.-]+\/[\w.-]+@[\da-f]{40} # v\d+\.\d+\.\d+$/u);
    }
  });

  it("packs the archives without any right to publish", () => {
    for (const name of packers) {
      deepEqual(jobBlock(name, "permissions"), ["contents: read"], name);
      equal(jobKey(name, "environment"), null, name);
      const text = job(name).join("\n");
      for (const right of [
        "secrets.",
        "id-token",
        "NODE_AUTH_TOKEN",
        "registry-url",
        "github.token",
      ]) {
        equal(text.includes(right), false, `${name}: ${right}`);
      }
      const checkout = steps(name).find(({ uses }) =>
        uses?.startsWith("actions/checkout@"),
      );
      equal(checkout.with["persist-credentials"], "false", name);
    }
  });

  it("packs and publishes on the same runtime", () => {
    for (const name of [...packers, ...Object.keys(publishers)]) {
      const setup = steps(name).filter(({ uses }) =>
        uses?.startsWith("actions/setup-node@"),
      );
      equal(setup.length, 1, name);
      equal(setup[0].with["node-version"], "24.16.0", name);
      equal("check-latest" in setup[0].with, false, name);
      equal(
        script(name, "Runtime (Node.js 24.16.0 and its npm 11.13.0)"),
        runtime,
        name,
      );
    }
  });

  it("uploads the checked archives and their manifest as an artifact of the run", () => {
    for (const name of packers) {
      const names = steps(name).map((item) => item.name);
      const upload = step(name, "Upload the archives");
      // The checks of the archives come before their upload
      for (const check of [
        "Packed files (scripts/pack-files.json)",
        "Consumer check (the archives of the release, TypeScript and ESM)",
        "Digest of the manifest",
      ]) {
        ok(names.indexOf(check) !== -1, `${name}: ${check}`);
        ok(names.indexOf(check) < names.indexOf(upload.name), check);
      }
      equal(
        step(name, "Packed files (scripts/pack-files.json)").run,
        'node scripts/pack-check.mjs --tarballs "$RUNNER_TEMP/release"',
      );
      equal(
        step(
          name,
          "Consumer check (the archives of the release, TypeScript and ESM)",
        ).run,
        'node scripts/consumer-check.mjs --tarballs "$RUNNER_TEMP/release"',
      );
      match(upload.uses, /^actions\/upload-artifact@[\da-f]{40} # v\d/u);
      match(upload.text, /^ {8}id: upload$/mu);
      deepEqual(Object.keys(upload.with).sort(), [
        "if-no-files-found",
        "name",
        "path",
      ]);
      equal(upload.with["if-no-files-found"], "error");
      match(
        upload.text,
        /path: \|\n {12}\$\{\{ runner\.temp \}\}\/release\/release-manifest\.json\n {12}\$\{\{ runner\.temp \}\}\/release\/\*\.tgz$/mu,
      );
      deepEqual(jobBlock(name, "outputs"), [
        `artifact-id: ${expression("steps.upload.outputs.artifact-id")}`,
        `manifest-digest: ${expression("steps.digest.outputs.sha256")}`,
      ]);
      match(step(name, "Digest of the manifest").text, /^ {8}id: digest$/mu);
    }
    // The `package` job packs the next release as the rehearsal does
    equal(
      script("package", "Release rehearsal"),
      'npm run release:rehearsal -- "$RUNNER_TEMP/release"',
    );
    equal(
      script("recover-package", "Pack the archives of the release"),
      [
        'node scripts/release.mjs version "$VERSION"',
        'node scripts/release.mjs pack "$RUNNER_TEMP/release"',
      ].join("\n"),
    );
  });

  it("publishes the artifact of the packing job of the same run, without packing", () => {
    for (const [name, packer] of Object.entries(publishers)) {
      const needs = jobKey(name, "needs");
      ok(
        needs === packer || needs.slice(1, -1).split(", ").includes(packer),
        `${name}: needs ${needs}`,
      );
      const download = steps(name).find(({ uses }) =>
        uses?.startsWith("actions/download-artifact@"),
      );
      match(download.uses, /^actions\/download-artifact@[\da-f]{40} # v\d/u);
      // By the id that the packing job reported: never by a name, a pattern or a run
      deepEqual(download.with, {
        "artifact-ids": expression(`needs.${packer}.outputs.artifact-id`),
        path: `${expression("runner.temp")}/release`,
      });
      const check = step(name, "Check the manifest of the archives");
      deepEqual(check.env, {
        MANIFEST_DIGEST: expression(`needs.${packer}.outputs.manifest-digest`),
      });
      equal(check.run, script("release", "Check the manifest of the archives"));
      const names = steps(name).map((item) => item.name);
      ok(names.indexOf(download.name) < names.indexOf(check.name));

      // Nothing is built or packed where the packages are published
      const text = job(name).join("\n");
      for (const command of [
        "release.mjs pack",
        "npm pack",
        "npm run build",
        "pack-check",
        "consumer-check",
        "release:rehearsal",
      ]) {
        equal(text.includes(command), false, `${name}: ${command}`);
      }
      for (const { run } of steps(name)) {
        if (run?.includes("npm ci")) {
          equal(run, "npm ci --ignore-scripts", name);
        }
      }
    }
    const release = step("release", "Release");
    equal(release.run, "npx semantic-release");
    equal(release.env.RELEASE_DIR, `${expression("runner.temp")}/release`);
    const names = steps("release").map((item) => item.name);
    ok(
      names.indexOf("Check the manifest of the archives") <
        names.indexOf("Release"),
    );
    equal(
      script("recover", "Publish the packages that are not published yet"),
      [
        'node scripts/release.mjs version "$VERSION"',
        'node scripts/release.mjs publish "$RUNNER_TEMP/release" --skip-existing',
      ].join("\n"),
    );
  });

  it("checks the version and the tag of a recovery before anything of the repository", () => {
    for (const name of ["recover-package", "recover"]) {
      const [version, checkout, tag] = steps(name);
      equal(version.name, "Check the version", name);
      match(checkout.uses, /^actions\/checkout@/u, name);
      equal(tag.name, "Check the tag and its commit", name);
      equal(
        script(name, "Check the version"),
        script("recover", "Check the version"),
      );
      equal(
        script(name, "Check the tag and its commit"),
        script("recover", "Check the tag and its commit"),
      );
    }
  });

  // The `release` environment admits `main` only (see "Repository settings" in the README),
  // and the npm trusted publisher of the packages requires it: every job that can publish to
  // npm runs in it, which keeps the workflow of another branch from publishing
  it("publishes only in the release environment", () => {
    const text = (name) => job(name).join("\n");
    deepEqual(
      jobNames().filter((name) =>
        ["NODE_AUTH_TOKEN", "secrets.NPM_TOKEN", "registry-url"].some((right) =>
          text(name).includes(right),
        ),
      ),
      ["release", "recover"],
    );
    for (const name of ["release", "recover"]) {
      equal(jobKey(name, "environment"), "release", name);
    }
    // And the deployment of the documentation (GitHub Pages), in its own environment
    deepEqual(
      jobNames().filter((name) => text(name).includes("id-token: write")),
      ["release", "recover", "pages"],
    );
    deepEqual(jobBlock("pages", "environment"), [
      "name: github-pages",
      `url: ${expression("steps.deployment.outputs.page_url")}`,
    ]);
  });

  // A release is published from `main` only: by a push (`release`), or by a recovery
  // dispatched from `main` (`recover-package` and `recover`, which nothing else runs with)
  it("runs the jobs of a release from main only", () => {
    const checks = ["lint", "package", "test", "windows", "macos"];
    for (const [context, expected] of [
      [
        { event_name: "push", ref: "refs/heads/main" },
        [...checks, "release", "pages"],
      ],
      [{ event_name: "push", ref: "refs/heads/other" }, checks],
      [
        { event_name: "pull_request", ref: "refs/pull/1/merge" },
        [...checks, "dependency-review"],
      ],
      [
        { event_name: "workflow_dispatch", ref: "refs/heads/main" },
        ["recover-package", "recover"],
      ],
      [{ event_name: "workflow_dispatch", ref: "refs/heads/other" }, []],
      [{ event_name: "workflow_dispatch", ref: "refs/tags/v1.0.0" }, []],
    ]) {
      deepEqual(
        jobNames().filter((name) => runs(name, context)),
        expected,
        JSON.stringify(context),
      );
    }
    // Each publishing job checks the branch itself, not only through the jobs it needs
    for (const name of ["release", "recover"]) {
      for (const ref of ["refs/heads/other", "refs/tags/v1.0.0"]) {
        for (const event of ["push", "workflow_dispatch"]) {
          equal(holds(name, { event_name: event, ref }), false, name);
        }
      }
    }
    deepEqual(jobNames(), [
      "lint",
      "package",
      "test",
      "windows",
      "macos",
      "dependency-review",
      "release",
      "recover-package",
      "recover",
      "pages",
    ]);
  });
});

// The recovery checks its input with bash before anything of the repository runs (in both
// of its jobs), the publishing jobs take only the manifest that the packing job reported,
// and `recover` creates the GitHub Release only when the API answers 404 (the shell of
// GitHub Actions)
describe(
  "the bash steps of the release jobs of .github/workflows/ci.yml",
  { skip: process.platform === "win32" && "bash is not portable there" },
  () => {
    let dir = "";

    const run = (code, cwd, env) =>
      spawnSync(
        "bash",
        ["--noprofile", "--norc", "-eo", "pipefail", "-c", code],
        {
          cwd,
          encoding: "utf8",
          timeout: 60_000,
          env: {
            ...process.env,
            PATH: `${join(dir, "bin")}:${process.env.PATH}`,
            GH_LOG: join(dir, "gh.log"),
            GITHUB_REPOSITORY: "owner/repo",
            RUNNER_TEMP: dir,
            ...env,
          },
        },
      );
    const git = (cwd, ...args) => {
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
        { cwd, encoding: "utf8", timeout: 60_000 },
      );
      equal(status, 0, stderr);
      return stdout.trim();
    };
    const commit = (cwd, content) => {
      writeFileSync(join(cwd, "file"), content);
      git(cwd, "add", "-A");
      git(cwd, "commit", "-q", "--no-verify", "-m", content);
    };
    // A clone like the one of actions/checkout (`fetch-depth: 0`)
    const checkout = () => {
      const clone = mkdtempSync(join(dir, "clone-"));
      git(dir, "clone", "-q", "--no-local", join(dir, "origin"), clone);
      return clone;
    };
    function ghCalls() {
      const log = join(dir, "gh.log");
      return existsSync(log) ? readFileSync(log, "utf8") : "";
    }

    before(() => {
      dir = mkdtempSync(join(tmpdir(), "binden-workflow-"));
      // A fake gh: `gh api --include` answers FAKE_GH_STATUS (nothing when it is `none`)
      mkdirSync(join(dir, "bin"));
      writeFileSync(
        join(dir, "bin", "gh"),
        `#!/bin/sh
echo "$*" >> "$GH_LOG"
if [ "$1" = api ]; then
  case "$FAKE_GH_STATUS" in
    none) echo "error connecting to api.github.com" >&2; exit 1;;
    200) printf 'HTTP/2.0 200 OK\\r\\n\\r\\n{}'; exit 0;;
    *) printf 'HTTP/2.0 %s Status\\r\\n\\r\\n{}' "$FAKE_GH_STATUS"; exit 1;;
  esac
fi
`,
      );
      chmodSync(join(dir, "bin", "gh"), 0o755);
      // v1.0.0 and v1.1.0 on main, v2.0.0 on another branch
      const origin = join(dir, "origin");
      mkdirSync(origin);
      git(origin, "init", "-q");
      commit(origin, "one");
      git(origin, "tag", "-a", "v1.0.0", "-m", "v1.0.0");
      commit(origin, "two");
      git(origin, "tag", "v1.1.0");
      git(origin, "checkout", "-q", "-b", "other");
      commit(origin, "three");
      git(origin, "tag", "v2.0.0");
      git(origin, "checkout", "-q", "main");
    });

    after(() => {
      rmSync(dir, { force: true, recursive: true });
    });

    // Both jobs of a recovery check the version and the tag the same way
    const recovery = ["recover-package", "recover"];

    it("refuses a version that is not SemVer, without running it", () => {
      for (const name of recovery) {
        const check = script(name, "Check the version");
        const marker = join(dir, "injected");
        for (const version of ["1.0.0", "1.0.0-rc.1"]) {
          equal(run(check, dir, { VERSION: version }).status, 0, version);
        }
        for (const version of [
          "",
          "1.0",
          "1.0.0+build",
          `$(touch ${marker})`,
          "1.0.0\n::warning::injected",
        ]) {
          const { status, stdout } = run(check, dir, { VERSION: version });
          equal(status, 1, `${name}: ${version}`);
          equal(
            stdout,
            "::error::The version is not a SemVer version (without build metadata)\n",
          );
        }
        equal(existsSync(marker), false, name);
      }
    });

    it("checks out the commit of the tag only when it is on main", () => {
      for (const name of recovery) {
        const check = script(name, "Check the tag and its commit");
        const clone = checkout();
        equal(run(check, clone, { VERSION: "1.0.0" }).status, 0, name);
        equal(
          git(clone, "rev-parse", "HEAD"),
          git(clone, "rev-parse", "v1.0.0^{commit}"),
        );

        for (const [version, error] of [
          [
            "2.0.0",
            /::error::The commit of v2\.0\.0 \([\da-f]{40}\) is not on main/u,
          ],
          ["3.0.0", /::error::The tag v3\.0\.0 does not exist/u],
        ]) {
          const other = checkout();
          const head = git(other, "rev-parse", "HEAD");
          const { status, stdout } = run(check, other, { VERSION: version });
          equal(status, 1, `${name}: ${version}`);
          match(stdout, error);
          equal(git(other, "rev-parse", "HEAD"), head);
        }
      }
    });

    // The digest that a packing job reports, then the check of the manifest that the
    // publishing job downloaded: a substituted manifest (or none) publishes nothing
    it("publishes only the manifest of the packing job", () => {
      const release = join(dir, "release");
      mkdirSync(release, { recursive: true });
      const manifest = join(release, "release-manifest.json");
      const output = join(dir, "github-output");
      const content = '{"packages":[]}\n';
      const sha256 = createHash("sha256").update(content).digest("hex");
      for (const [name, packer] of Object.entries(publishers)) {
        writeFileSync(manifest, content);
        writeFileSync(output, "");
        const digest = run(script(packer, "Digest of the manifest"), dir, {
          GITHUB_OUTPUT: output,
        });
        equal(digest.status, 0, digest.stderr);
        equal(readFileSync(output, "utf8"), `sha256=${sha256}\n`, packer);

        const check = script(name, "Check the manifest of the archives");
        equal(run(check, dir, { MANIFEST_DIGEST: sha256 }).status, 0, name);
        for (const [substitute, expected] of [
          ['{"packages":[ ]}\n', sha256],
          [content, ""],
          [content, sha256.toUpperCase()],
        ]) {
          writeFileSync(manifest, substitute);
          const { status, stdout } = run(check, dir, {
            MANIFEST_DIGEST: expected,
          });
          equal(status, 1, `${name}: ${substitute} ${expected}`);
          match(
            stdout,
            /^::error::The manifest of the archives \([\da-f]{64}\) is not the one that the packing job reported \(\S+\)\n$/u,
          );
        }
        rmSync(manifest);
        const missing = run(check, dir, { MANIFEST_DIGEST: sha256 });
        equal(missing.status, 1, name);
        equal(missing.stdout, "");
      }
    });

    it("creates the GitHub Release only when the API answers 404", () => {
      const create = script(
        "recover",
        "Create the GitHub Release when it is missing",
      );
      const clone = checkout();
      git(clone, "checkout", "-q", "--detach", "v1.1.0");
      for (const [answer, status, created] of [
        ["200", 0, false],
        ["404", 0, true],
        ["403", 1, false],
        ["500", 1, false],
        ["4040", 1, false],
        ["none", 1, false],
      ]) {
        rmSync(join(dir, "gh.log"), { force: true });
        const result = run(create, clone, {
          VERSION: "1.1.0",
          FAKE_GH_STATUS: answer,
        });
        equal(result.status, status, answer);
        equal(ghCalls().includes("release create"), created, answer);
        if (created) {
          match(
            ghCalls(),
            /^release create v1\.1\.0 --verify-tag --title v1\.1\.0 --generate-notes --notes-start-tag v1\.0\.0$/mu,
          );
        } else if (status !== 0) {
          match(
            result.stdout,
            /::error::Cannot tell whether the GitHub Release v1\.1\.0 exists/u,
          );
        }
      }
    });
  },
);
