// The rules for the content of a published package, on top of its exact file list
// (`scripts/pack-files.json`, which `scripts/pack-check.mjs --update` rewrites from what
// is packed): files that must never be published whatever the list says (tests,
// fixtures, certificates and keys, environment and npm configuration files, build
// artefacts), and source maps that must point to the published sources of the package
// with relative paths (never to the absolute paths of the machine that built it).
import { posix } from "node:path";

const deniedDirectories = new Set([
  ".git",
  "__tests__",
  "cert",
  "certs",
  "coverage",
  "fixtures",
  "node_modules",
  "test",
  "tests",
]);

const deniedFiles = [
  [/\.(?:test|spec)\.[^/]+$/u, "a test"],
  [/\.(?:cer|crt|csr|der|key|p12|pem|pfx)$/iu, "a certificate or a key"],
  [/(?:^|\/)\.env(?:\.[^/]*)?$/u, "an environment file"],
  [/(?:^|\/)\.npmrc$/u, "an npm configuration file"],
  [/\.(?:log|tgz|tsbuildinfo)$/u, "a build artefact"],
];

// A URL scheme, or a Windows drive (`C:`)
const scheme = /^[A-Za-z][\d+.A-Za-z-]*:/u;

// The comment that links a generated file to its source map, at its end
const mappingURL = /\/\/[#@] sourceMappingURL=(?<url>\S*)\s*$/u;

// The generated files that may link to a source map
const generated = /\.(?:[cm]?js|d\.[cm]?ts)$/u;

/** Why `path` (relative to the root of the package) must not be published, or null */
export function deniedReason(path) {
  const directory = path
    .split("/")
    .slice(0, -1)
    .find((name) => deniedDirectories.has(name));
  if (typeof directory !== "undefined") {
    return `a file of a ${directory}/ directory`;
  }
  return deniedFiles.find(([pattern]) => pattern.test(path))?.[1] ?? null;
}

/**
 * The path that `target`, relative to the file `from`, points to inside the package,
 * or null when it is not a relative path (absolute, a URL, a Windows path) or when it
 * points outside of the package
 */
export function resolveInside(from, target) {
  if (
    target === "" ||
    target.startsWith("/") ||
    target.includes("\\") ||
    scheme.test(target)
  ) {
    return null;
  }
  const path = posix.normalize(posix.join(posix.dirname(from), target));
  return path === "." || path === ".." || path.startsWith("../") ? null : path;
}

function parseJSON(content) {
  try {
    return JSON.parse(content.toString("utf8"));
  } catch {
    return null;
  }
}

function mapErrors(path, content, files) {
  const map = parseJSON(content);
  if (map?.version !== 3 || !Array.isArray(map.sources)) {
    return [`${path}: invalid source map`];
  }
  const errors = [];
  if (!files.has(path.slice(0, -".map".length))) {
    errors.push(`${path}: its generated file is not published`);
  }
  if (typeof map.sourceRoot !== "undefined" && map.sourceRoot !== "") {
    errors.push(
      `${path}: sourceRoot ${JSON.stringify(map.sourceRoot)} (the sources must be relative to the map)`,
    );
  }
  if (map.sources.length === 0) {
    errors.push(`${path}: no sources`);
  }
  for (const source of map.sources) {
    const target =
      typeof source === "string" ? resolveInside(path, source) : null;
    if (target === null) {
      errors.push(
        `${path}: source ${JSON.stringify(source)} is not a relative path inside the package`,
      );
    } else if (!files.has(target)) {
      errors.push(`${path}: source ${target} is not published`);
    }
  }
  return errors;
}

function mappingURLErrors(path, content, files) {
  const url = mappingURL.exec(content.toString("utf8"))?.groups?.url;
  if (typeof url === "undefined") {
    return [];
  }
  const target = resolveInside(path, url);
  if (target === null || !target.endsWith(".map")) {
    return [
      `${path}: sourceMappingURL ${JSON.stringify(url)} is not a relative path to a map inside the package`,
    ];
  }
  return files.has(target)
    ? []
    : [`${path}: sourceMappingURL ${target} is not published`];
}

/**
 * The files of a package (`paths`, relative to its root) that break these rules;
 * `read(path)` returns the content of a file (a `Buffer`)
 */
export function packageErrors(paths, read) {
  const files = new Set(paths);
  const errors = [];
  for (const path of paths) {
    const reason = deniedReason(path);
    if (reason !== null) {
      errors.push(`${path}: ${reason} must not be published`);
    } else if (path.endsWith(".map")) {
      errors.push(...mapErrors(path, read(path), files));
    } else if (generated.test(path)) {
      errors.push(...mappingURLErrors(path, read(path), files));
    }
  }
  return errors;
}
