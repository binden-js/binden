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
import { equal, match, ok } from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const workflow = readFileSync(
  join(import.meta.dirname, "../.github/workflows/ci.yml"),
  "utf8",
);

/** The script (`run: |`) of a step of a job of the CI workflow */
function script(job, name) {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`  ${job}:`);
  const end = lines.findIndex(
    (line, index) => index > start && /^ {2}\S/u.test(line),
  );
  const steps = lines.slice(start, end === -1 ? lines.length : end);
  const step = steps.findIndex((line) => line.trim() === `- name: ${name}`);
  const run = steps.findIndex(
    (line, index) => index > step && line.trim() === "run: |",
  );
  ok(start !== -1 && step !== -1 && run !== -1, `${job}: ${name}`);
  const indent = steps[run].indexOf("run");
  const body = [];
  for (const line of steps.slice(run + 1)) {
    if (line.trim() !== "" && line.search(/\S/u) <= indent) {
      break;
    }
    body.push(line);
  }
  const margin = body[0].search(/\S/u);
  return body.map((line) => line.slice(margin)).join("\n");
}

// The recover job checks its input with bash before anything of the repository runs, then
// creates the GitHub Release only when the API answers 404 (the shell of GitHub Actions)
describe(
  "the recover job of .github/workflows/ci.yml",
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

    it("refuses a version that is not SemVer, without running it", () => {
      const check = script("recover", "Check the version");
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
        equal(status, 1, version);
        equal(
          stdout,
          "::error::The version is not a SemVer version (without build metadata)\n",
        );
      }
      equal(existsSync(marker), false);
    });

    it("checks out the commit of the tag only when it is on main", () => {
      const check = script("recover", "Check the tag and its commit");
      const clone = checkout();
      equal(run(check, clone, { VERSION: "1.0.0" }).status, 0);
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
        equal(status, 1);
        match(stdout, error);
        equal(git(other, "rev-parse", "HEAD"), head);
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
