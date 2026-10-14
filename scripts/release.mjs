#!/usr/bin/env node
// Lockstep release helper for the npm workspaces of this repository.
//
//   check               all workspaces share one version and pin each other to `^<version>`
//   verify <version>    none of the workspaces is published at <version> yet
//   version <version>   set <version> everywhere and refresh package-lock.json
//   publish             publish every workspace in the `workspaces` order
//                       (`--skip-existing` skips already published ones, to recover a release
//                       that failed half-way: from the commit of its tag only, and only when the
//                       published ones come from that commit too)
//
// Provenance is enabled by the CI release job (NPM_CONFIG_PROVENANCE), so a manual
// `publish --skip-existing` works outside of CI too.
// Everything is logged to stderr: @semantic-release/exec parses the stdout of `publishCmd`.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { npm as execNpm } from "./npm.mjs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

function readJSON(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function log(message) {
  process.stderr.write(`[release] ${message}\n`);
}

function npm(args, options = {}) {
  return execNpm(args, { cwd: root, encoding: "utf8", ...options });
}

function workspaces() {
  return readJSON(join(root, "package.json")).workspaces.map((dir) => {
    const file = join(root, dir, "package.json");
    return { dir, file, manifest: readJSON(file) };
  });
}

function errorCode(stdout) {
  try {
    return JSON.parse(stdout).error?.code ?? null;
  } catch {
    return null;
  }
}

// Only a confirmed "not found" (E404) means "not published": registry, network or
// authentication errors must stop the release before anything is tagged or published.
function isPublished(name, version) {
  try {
    const stdout = npm(["view", `${name}@${version}`, "version", "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    return stdout.trim() !== "";
  } catch (error) {
    if (errorCode(error.stdout) === "E404") {
      return false;
    }
    throw error;
  }
}

function check() {
  const packages = workspaces();
  const names = new Set(packages.map(({ manifest }) => manifest.name));
  const [{ manifest: first }] = packages;
  const errors = [];
  for (const { dir, manifest } of packages) {
    if (manifest.version !== first.version) {
      errors.push(`${dir}: version ${manifest.version} != ${first.version}`);
    }
    for (const field of dependencyFields) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        if (names.has(name) && range !== `^${first.version}`) {
          errors.push(
            `${dir}: ${field}.${name} is ${range}, expected ^${first.version}`,
          );
        }
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `Workspaces are not in lockstep:\n  ${errors.join("\n  ")}`,
    );
  }
  log(`${packages.length} workspaces in lockstep at ${first.version}`);
}

function verify(version) {
  const published = workspaces()
    .map(({ manifest }) => manifest.name)
    .filter((name) => isPublished(name, version));
  if (published.length > 0) {
    throw new Error(`Already published at ${version}: ${published.join(", ")}`);
  }
  log(`no workspace is published at ${version} yet`);
}

function setVersion(version) {
  const packages = workspaces();
  const names = new Set(packages.map(({ manifest }) => manifest.name));
  for (const { file, manifest } of packages) {
    manifest.version = version;
    for (const field of dependencyFields) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        if (names.has(name)) {
          manifest[field][name] = `^${version}`;
        }
      }
    }
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    log(`${manifest.name} -> ${version}`);
  }
  npm(["install", "--package-lock-only", "--ignore-scripts"], {
    stdio: ["ignore", process.stderr, "inherit"],
  });
  check();
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

// The commit that a published version was published from (npm records it as `gitHead`)
function publishedFrom(name, version) {
  const stdout = npm(["view", `${name}@${version}`, "gitHead", "--json"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return stdout.trim() === "" ? null : JSON.parse(stdout);
}

function publish(skipExisting) {
  check();
  const [{ manifest: first }] = workspaces();
  const head = skipExisting ? git(["rev-parse", "HEAD"]) : null;
  if (skipExisting) {
    // The tag of a release is pushed before its packages are published: the rest is
    // published from the commit of the tag, not from a later one
    const tag = `v${first.version}`;
    const tagged = git(["rev-parse", "--verify", `${tag}^{commit}`]);
    if (tagged !== head) {
      throw new Error(`HEAD (${head}) is not the commit of ${tag} (${tagged})`);
    }
  }
  for (const { dir, manifest } of workspaces()) {
    if (skipExisting && isPublished(manifest.name, manifest.version)) {
      const from = publishedFrom(manifest.name, manifest.version);
      if (from !== head) {
        throw new Error(
          `${manifest.name}@${manifest.version} was published from ${from}, not from ${head}`,
        );
      }
      log(`skip ${manifest.name}@${manifest.version}: already published`);
    } else {
      log(`publish ${manifest.name}@${manifest.version}`);
      npm(["publish", "--workspace", dir], {
        stdio: ["ignore", process.stderr, "inherit"],
      });
    }
  }
}

const [command, argument] = process.argv.slice(2);
const versionPattern = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/u;

switch (command) {
  case "check":
    check();
    break;
  case "verify":
  case "version":
    if (!versionPattern.test(argument ?? "")) {
      throw new Error(`Invalid version: ${argument}`);
    }
    if (command === "verify") {
      verify(argument);
    } else {
      setVersion(argument);
    }
    break;
  case "publish":
    publish(argument === "--skip-existing");
    break;
  default:
    throw new Error(`Unknown command: ${command}`);
}
