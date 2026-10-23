#!/usr/bin/env node
// Rehearses the release of the current commit, without tagging or publishing
// anything: semantic-release (with its analyzer and its notes only) computes the
// next version in a clone whose remote is a local mirror. `scripts/release.mjs` then
// runs as the CI jobs do. In that clone, as the `package` job: `verify` (no workspace
// is published at that version yet), `version` and `pack` (the archives and their
// manifest). In another clone of the commit, as the `release` job does before the tag
// (`prepareCmd` of .releaserc.json): `version`, then `publish --dry-run` of these
// archives (their checks against the workspaces and HEAD, the registry check, then
// `npm publish --dry-run` of every archive). When no release is due, the current
// version is packed.
//
//   node scripts/release-rehearsal.mjs [<dir>]
//
// <dir> (missing or empty) keeps the archives and their manifest, for the checks that
// run on them (`scripts/pack-check.mjs --tarballs <dir>`, `scripts/consumer-check.mjs
// --tarballs <dir>`) and for the artifact of the `package` job.
import { execFileSync, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const root = join(import.meta.dirname, "..");
const [destination] = process.argv.slice(2);
const dir = mkdtempSync(join(tmpdir(), "binden-rehearsal-"));
const mirror = join(dir, "mirror.git");
const work = join(dir, "work");
// The checkout of the release job, which publishes the archives packed in `work`
const publisher = join(dir, "publisher");
const archives =
  typeof destination === "undefined"
    ? join(dir, "archives")
    : resolve(destination);
const plugins = new Set([
  "@semantic-release/commit-analyzer",
  "@semantic-release/release-notes-generator",
]);

function log(message) {
  process.stderr.write(`[rehearsal] ${message}\n`);
}

function git(args, cwd = work) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function node(args, cwd = work) {
  execFileSync(process.execPath, args, {
    cwd,
    stdio: ["ignore", process.stderr, "inherit"],
  });
}

try {
  const head = git(["rev-parse", "HEAD"], root);
  git(["clone", "--quiet", "--bare", root, mirror], dir);
  git(["clone", "--quiet", mirror, work], dir);
  git(["checkout", "--quiet", "-B", "rehearsal", head]);
  git(["push", "--quiet", "origin", "rehearsal"]);

  const configFile = join(work, ".releaserc.json");
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  config.branches = ["rehearsal"];
  config.plugins = config.plugins.filter((plugin) =>
    plugins.has(Array.isArray(plugin) ? plugin[0] : plugin),
  );
  writeFileSync(configFile, JSON.stringify(config));
  symlinkSync(
    join(root, "node_modules"),
    join(work, "node_modules"),
    "junction",
  );

  // Not the CI of the repository, without its tokens
  const hidden = new Set(["CI", "GITHUB_ACTIONS", "GITHUB_TOKEN", "GH_TOKEN"]);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !hidden.has(name)),
  );
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/semantic-release/bin/semantic-release.js"),
      "--dry-run",
      "--no-ci",
      "--repository-url",
      pathToFileURL(mirror).href,
    ],
    { cwd: work, encoding: "utf8", env },
  );
  process.stderr.write(stdout);
  if (status !== 0) {
    process.stderr.write(stderr);
    throw new Error(`semantic-release failed (${status})`);
  }

  // `pack` packs committed files only
  git(["checkout", "--quiet", "--", ".releaserc.json"]);

  const version = /The next release version is (?<version>\S+)/u.exec(stdout)
    ?.groups?.version;
  if (typeof version === "undefined") {
    const { workspaces } = JSON.parse(
      readFileSync(join(work, "package.json"), "utf8"),
    );
    const { version: current } = JSON.parse(
      readFileSync(join(work, workspaces[0], "package.json"), "utf8"),
    );
    log(`no release is due: packing the current version (${current})`);
    node(["scripts/release.mjs", "version", current]);
    node(["scripts/release.mjs", "pack", archives]);
  } else {
    node(["scripts/release.mjs", "verify", version]);
    node(["scripts/release.mjs", "version", version]);
    node(["scripts/release.mjs", "pack", archives]);

    // Nothing of `work` but the archives: a fresh checkout of the same commit
    git(["clone", "--quiet", "--no-checkout", mirror, publisher], dir);
    git(["checkout", "--quiet", "--detach", head], publisher);
    node(["scripts/release.mjs", "version", version], publisher);
    node(["scripts/release.mjs", "publish", archives, "--dry-run"], publisher);
    log(`the next release is ${version}`);
  }
  log(`archives: ${archives}`);
} finally {
  rmSync(dir, { force: true, recursive: true });
}
