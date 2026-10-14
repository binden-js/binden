#!/usr/bin/env node
// Lockstep release helper for the npm workspaces of this repository.
//
//   check               all workspaces share one version and pin each other to `^<version>`
//   verify <version>    none of the workspaces is published at <version> yet
//   version <version>   set <version> and `gitHead` (the commit of HEAD) in every workspace,
//                       and refresh package-lock.json
//   pack <dir>          pack every workspace once into <dir> (missing or empty), check the
//                       name, the version, the `gitHead` and the files (scripts/pack-files.json)
//                       inside each archive, and list them in <dir>/release-manifest.json
//   publish <dir>       publish the archives of <dir>/release-manifest.json in dependency order,
//                       once the registry has been checked for all of them
//     --skip-existing   skip the versions already published from the same archive (`gitHead`
//                       and `dist.integrity`), to recover a release that failed half-way: from
//                       the commit of its tag only
//     --dry-run         everything but the upload (`npm publish --dry-run`)
//
// Versions follow SemVer 2.0.0 strictly. Provenance is enabled by the CI release job
// (NPM_CONFIG_PROVENANCE), so a manual `publish --skip-existing` works outside of CI too.
// Everything is logged to stderr: @semantic-release/exec parses the stdout of `publishCmd`.
import {
  compareFiles,
  inspectTarball,
  integrity,
  manifestFile,
  readRelease,
} from "./tarballs.mjs";
import { join, resolve } from "node:path";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { npm as execNpm } from "./npm.mjs";

const root = join(import.meta.dirname, "..");
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
// The dependencies that a consumer installs with a package: publication order
const runtimeFields = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
];
// SemVer 2.0.0 (https://semver.org/#backusnaur-form-grammar-for-valid-semver-versions):
// no leading zeros in numeric identifiers, non-empty identifiers, ASCII only
const semver =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*))*)?(?:\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$/u;

function readJSON(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function log(message) {
  process.stderr.write(`[release] ${message}\n`);
}

function npm(args, options = {}) {
  return execNpm(args, { cwd: root, encoding: "utf8", ...options });
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function workspaces() {
  return readJSON(join(root, "package.json")).workspaces.map((dir) => {
    const file = join(root, dir, "package.json");
    return { dir, file, manifest: readJSON(file) };
  });
}

function validVersion(version) {
  if (!semver.test(version)) {
    throw new Error(`Invalid version: ${version}`);
  }
  // npm drops it (`1.0.0+a` would be published as `1.0.0`, different from its tag)
  if (version.includes("+")) {
    throw new Error(`Build metadata is not supported by npm: ${version}`);
  }
  return version;
}

// The workspaces in dependency order (a package after the packages that it needs),
// otherwise in the `workspaces` order
function dependencyOrder(packages) {
  const names = new Set(packages.map(({ manifest }) => manifest.name));
  const ordered = [];
  const done = new Set();
  const needs = ({ manifest }) =>
    runtimeFields.flatMap((field) =>
      Object.keys(manifest[field] ?? {}).filter(
        (name) => names.has(name) && name !== manifest.name,
      ),
    );
  while (ordered.length < packages.length) {
    const next = packages.find(
      (pkg) =>
        !done.has(pkg.manifest.name) &&
        needs(pkg).every((name) => done.has(name)),
    );
    if (typeof next === "undefined") {
      const rest = [...names].filter((name) => !done.has(name));
      throw new Error(`Circular dependencies between ${rest.join(", ")}`);
    }
    ordered.push(next);
    done.add(next.manifest.name);
  }
  return ordered;
}

function errorCode(stdout) {
  try {
    return JSON.parse(stdout).error?.code ?? null;
  } catch {
    return null;
  }
}

// The `gitHead` and the `dist.integrity` of a published version, or null when the
// registry confirms that it does not exist (E404, with `--json` on stdout). Registry,
// network or authentication errors stop the release before anything is published.
function published(name, version) {
  try {
    const stdout = npm(["view", `${name}@${version}`, "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const { gitHead = null, dist } = JSON.parse(stdout);
    return { gitHead, integrity: dist?.integrity ?? null };
  } catch (error) {
    if (errorCode(error.stdout) === "E404") {
      return null;
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
  return { packages, version: first.version };
}

function verify(version) {
  const existing = workspaces()
    .map(({ manifest }) => manifest.name)
    .filter((name) => published(name, version) !== null);
  if (existing.length > 0) {
    throw new Error(`Already published at ${version}: ${existing.join(", ")}`);
  }
  log(`no workspace is published at ${version} yet`);
}

function setVersion(version) {
  const head = git(["rev-parse", "HEAD"]);
  const packages = workspaces();
  const names = new Set(packages.map(({ manifest }) => manifest.name));
  for (const { file, manifest } of packages) {
    manifest.version = version;
    // The commit that the archives are packed from (npm publishes it as `gitHead`)
    manifest.gitHead = head;
    for (const field of dependencyFields) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        if (names.has(name)) {
          manifest[field][name] = `^${version}`;
        }
      }
    }
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    log(`${manifest.name} -> ${version} (${head})`);
  }
  npm(
    [
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    { stdio: ["ignore", process.stderr, "inherit"] },
  );
  check();
}

// The archives are packed from the commit that their `gitHead` names: only the files
// that `version` changes may differ from it
function assertCommitted(packages) {
  const allowed = new Set([
    "package-lock.json",
    ...packages.map(({ dir }) => `${dir}/package.json`),
  ]);
  const changed = git(["diff", "--name-only", "HEAD"])
    .split("\n")
    .filter((path) => path !== "" && !allowed.has(path));
  if (changed.length > 0) {
    throw new Error(`Uncommitted changes: ${changed.join(", ")}`);
  }
}

// The differences between an archive (`inspectTarball`) and the expected package
function archiveErrors(file, { manifest, files }, expected) {
  const errors = [];
  for (const field of ["name", "version", "gitHead"]) {
    if (manifest[field] !== expected[field]) {
      errors.push(
        `${file}: ${field} ${manifest[field]}, expected ${expected[field]}`,
      );
    }
  }
  const differences = compareFiles(
    { [expected.name]: expected.files },
    { [expected.name]: files },
  );
  return [...errors, ...differences.map((error) => `${file}: ${error}`)];
}

function expectedFiles() {
  return readJSON(join(root, "scripts", "pack-files.json"));
}

function pack(dir) {
  const { packages, version } = check();
  const head = git(["rev-parse", "HEAD"]);
  assertCommitted(packages);
  mkdirSync(dir, { recursive: true });
  if (readdirSync(dir).length > 0) {
    throw new Error(`${dir} is not empty`);
  }
  npm(["pack", "--workspaces", "--pack-destination", dir, "--loglevel=warn"], {
    stdio: ["ignore", process.stderr, "inherit"],
  });

  const errors = [];
  const archives = new Map();
  for (const file of readdirSync(dir)) {
    const data = readFileSync(join(dir, file));
    const archive = {
      file,
      integrity: integrity(data),
      ...inspectTarball(data),
    };
    const { name } = archive.manifest;
    if (archives.has(name)) {
      errors.push(`${file}: another archive of ${name}`);
    }
    archives.set(name, archive);
  }
  const allFiles = expectedFiles();
  const ordered = dependencyOrder(packages);
  for (const { manifest } of ordered) {
    const archive = archives.get(manifest.name);
    if (typeof archive === "undefined") {
      errors.push(`${manifest.name}: no archive`);
    } else {
      errors.push(
        ...archiveErrors(archive.file, archive, {
          name: manifest.name,
          version,
          gitHead: head,
          files: allFiles[manifest.name] ?? [],
        }),
      );
    }
  }
  const names = new Set(packages.map(({ manifest }) => manifest.name));
  for (const [name, { file }] of archives) {
    if (!names.has(name)) {
      errors.push(`${file}: ${name} is not a workspace`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`Invalid archives in ${dir}:\n  ${errors.join("\n  ")}`);
  }

  const release = ordered.map(({ manifest: { name } }) => {
    const archive = archives.get(name);
    return {
      name,
      version,
      sha: head,
      integrity: archive.integrity,
      file: archive.file,
    };
  });
  writeFileSync(
    join(dir, manifestFile),
    `${JSON.stringify({ packages: release }, null, 2)}\n`,
  );
  for (const { name, file, integrity: sum } of release) {
    log(`packed ${name}@${version} (${file}, ${sum})`);
  }
}

// The archives of the manifest, checked against the workspaces, HEAD and their content
function releaseArchives(dir, packages, version, head) {
  const entries = new Map();
  const errors = [];
  for (const entry of readRelease(dir)) {
    if (entries.has(entry.name)) {
      errors.push(`${entry.file}: another archive of ${entry.name}`);
    }
    entries.set(entry.name, entry);
  }
  const names = new Set(packages.map(({ manifest }) => manifest.name));
  for (const [name, { file }] of entries) {
    if (!names.has(name)) {
      errors.push(`${file}: ${name} is not a workspace`);
    }
  }
  const allFiles = expectedFiles();
  const ordered = [];
  for (const { manifest } of dependencyOrder(packages)) {
    const entry = entries.get(manifest.name);
    if (typeof entry === "undefined") {
      errors.push(`${manifest.name}: not in ${manifestFile}`);
    } else {
      if (entry.version !== version || entry.sha !== head) {
        errors.push(
          `${entry.file}: ${entry.version} from ${entry.sha}, expected ${version} from ${head} (HEAD)`,
        );
      }
      errors.push(
        ...archiveErrors(entry.file, inspectTarball(readFileSync(entry.path)), {
          name: entry.name,
          version: entry.version,
          gitHead: entry.sha,
          files: allFiles[entry.name] ?? [],
        }),
      );
      ordered.push(entry);
    }
  }
  if (errors.length > 0) {
    throw new Error(`Invalid archives in ${dir}:\n  ${errors.join("\n  ")}`);
  }
  return ordered;
}

function publish(dir, { skipExisting, dryRun }) {
  const { packages, version } = check();
  const head = git(["rev-parse", "HEAD"]);
  if (skipExisting) {
    // The tag of a release is pushed before its packages are published: the rest is
    // published from the commit of the tag, not from a later one
    const tag = `v${version}`;
    const tagged = git(["rev-parse", "--verify", `${tag}^{commit}`]);
    if (tagged !== head) {
      throw new Error(`HEAD (${head}) is not the commit of ${tag} (${tagged})`);
    }
  }
  const archives = releaseArchives(dir, packages, version, head);

  // Every package is checked before the first one is published
  const existing = new Map();
  for (const { name } of archives) {
    const state = published(name, version);
    if (state !== null) {
      existing.set(name, state);
    }
  }
  const conflicts = [];
  for (const { name, sha, integrity: sum } of archives) {
    const state = existing.get(name);
    if (typeof state === "undefined") {
      log(`${name}@${version} is not published yet`);
    } else if (state.gitHead !== sha || state.integrity !== sum) {
      conflicts.push(
        `${name}@${version} is published from another archive (gitHead ${state.gitHead}, integrity ${state.integrity})`,
      );
    } else if (!skipExisting) {
      conflicts.push(`${name}@${version} is already published`);
    }
  }
  if (conflicts.length > 0) {
    throw new Error(`Nothing is published:\n  ${conflicts.join("\n  ")}`);
  }

  for (const { name, path } of archives) {
    if (existing.has(name)) {
      log(`skip ${name}@${version}: already published from the same archive`);
    } else {
      log(`publish ${name}@${version}${dryRun ? " (dry run)" : ""}`);
      npm(["publish", path, ...(dryRun ? ["--dry-run"] : [])], {
        stdio: ["ignore", process.stderr, "inherit"],
      });
    }
  }
}

const [command, ...args] = process.argv.slice(2);
const options = args.filter((arg) => arg.startsWith("--"));
const operands = args.filter((arg) => !arg.startsWith("--"));
const allowedOptions =
  command === "publish" ? ["--skip-existing", "--dry-run"] : [];

for (const option of options) {
  if (!allowedOptions.includes(option)) {
    throw new Error(`Unknown option: ${option}`);
  }
}

function operand(name) {
  const [value = ""] = operands;
  if (operands.length !== 1 || value === "") {
    throw new Error(`Usage: scripts/release.mjs ${command} <${name}>`);
  }
  return value;
}

switch (command) {
  case "check":
    check();
    break;
  case "verify":
    verify(validVersion(operand("version")));
    break;
  case "version":
    setVersion(validVersion(operand("version")));
    break;
  case "pack":
    pack(resolve(operand("dir")));
    break;
  case "publish":
    publish(resolve(operand("dir")), {
      skipExisting: options.includes("--skip-existing"),
      dryRun: options.includes("--dry-run"),
    });
    break;
  default:
    throw new Error(`Unknown command: ${command}`);
}
