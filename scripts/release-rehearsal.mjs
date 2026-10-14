#!/usr/bin/env node
// Rehearses the release of the current commit, without tagging or publishing
// anything: semantic-release (with its analyzer and its notes only) computes the
// next version in a clone whose remote is a local mirror, then
// `scripts/release.mjs` checks that no workspace is published at it yet, and
// sets it in every workspace of the clone.
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const root = join(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "binden-rehearsal-"));
const mirror = join(dir, "mirror.git");
const work = join(dir, "work");
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

function node(args) {
  execFileSync(process.execPath, args, {
    cwd: work,
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

  const version = /The next release version is (?<version>\S+)/u.exec(stdout)
    ?.groups?.version;
  if (typeof version === "undefined") {
    log("no release is due");
  } else {
    node(["scripts/release.mjs", "verify", version]);
    node(["scripts/release.mjs", "version", version]);
    log(`the next release is ${version}`);
  }
} finally {
  rmSync(dir, { force: true, recursive: true });
}
