// A fake npm CLI for the tests of the release tooling, run as `npm_execpath` (see
// scripts/npm.mjs) from the root of a fixture repository. Every call is appended to
// FAKE_NPM_LOG (a JSON array of its arguments per line).
//
//   view <name>@<version> --json
//       the document of FAKE_NPM_REGISTRY (a JSON file: `name@version` -> document),
//       E404 otherwise, or the error FAKE_NPM_VIEW_ERROR (for FAKE_NPM_VIEW_ERROR_SPEC
//       only, when set; `crash` fails without a JSON error)
//   publish <tgz> [--dry-run]
//       adds the archive to the registry (its `gitHead` and its integrity), but fails
//       (E500) for the package FAKE_NPM_FAIL_PUBLISH
//   pack --workspaces --pack-destination <dir>
//       packs every file of every workspace inside `package/`, like npm, with the
//       package.json fields of FAKE_NPM_PACK_PATCH ({ "<workspace>": { ...fields } });
//       fails when FAKE_NPM_FAIL_PACK is set
//   install
//       rewrites package-lock.json
//
// Every other command succeeds without doing anything.
import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { inspectTarball, integrity } from "../tarballs.mjs";
import { join, sep } from "node:path";
import { npmTarball } from "./tar.mjs";

const args = process.argv.slice(2);
const { env } = process;
appendFileSync(env.FAKE_NPM_LOG, `${JSON.stringify(args)}\n`);

const readJSON = (file) => JSON.parse(readFileSync(file, "utf8"));
function registry() {
  return existsSync(env.FAKE_NPM_REGISTRY)
    ? readJSON(env.FAKE_NPM_REGISTRY)
    : {};
}

function fail(code) {
  process.stdout.write(JSON.stringify({ error: { code } }));
  process.stderr.write(`npm error code ${code}\n`);
  process.exit(1);
}

function view([spec]) {
  const error = env.FAKE_NPM_VIEW_ERROR;
  if (
    error &&
    (!env.FAKE_NPM_VIEW_ERROR_SPEC || env.FAKE_NPM_VIEW_ERROR_SPEC === spec)
  ) {
    if (error === "crash") {
      process.stderr.write("npm error\n");
      process.exit(1);
    }
    fail(error);
  }
  const document = registry()[spec];
  if (typeof document === "undefined") {
    fail("E404");
  }
  process.stdout.write(JSON.stringify(document));
}

function publish([file, ...options]) {
  const data = readFileSync(file);
  const { manifest } = inspectTarball(data);
  if (manifest.name === env.FAKE_NPM_FAIL_PUBLISH) {
    fail("E500");
  }
  if (!options.includes("--dry-run")) {
    const documents = registry();
    documents[`${manifest.name}@${manifest.version}`] = {
      name: manifest.name,
      version: manifest.version,
      gitHead: manifest.gitHead,
      dist: { integrity: integrity(data) },
    };
    writeFileSync(env.FAKE_NPM_REGISTRY, JSON.stringify(documents));
  }
}

function pack(options) {
  if (env.FAKE_NPM_FAIL_PACK) {
    fail("EPACK");
  }
  const destination = options[options.indexOf("--pack-destination") + 1];
  const patches = JSON.parse(env.FAKE_NPM_PACK_PATCH ?? "{}");
  for (const dir of readJSON("package.json").workspaces) {
    const files = {};
    for (const path of readdirSync(dir, { recursive: true })) {
      if (statSync(join(dir, path)).isFile()) {
        files[path.split(sep).join("/")] = readFileSync(join(dir, path));
      }
    }
    const manifest = JSON.parse(files["package.json"]);
    files["package.json"] = JSON.stringify({ ...manifest, ...patches[dir] });
    const file = `${manifest.name.replace("@", "").replace("/", "-")}-${manifest.version}.tgz`;
    writeFileSync(join(destination, file), npmTarball(files));
  }
}

const [command, ...rest] = args;
if (command === "view") {
  view(rest);
} else if (command === "publish") {
  publish(rest);
} else if (command === "pack") {
  pack(rest);
} else if (command === "install") {
  writeFileSync("package-lock.json", `${JSON.stringify({ args })}\n`);
}
