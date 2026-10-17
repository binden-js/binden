// The rules for the content of a published package, on top of its exact file list
// (`scripts/pack-files.json`, which `scripts/pack-check.mjs --update` rewrites from what
// is packed): files that must never be published whatever the list says (tests, mocks,
// fixtures, certificates, keys and credentials, environment and npm configuration files,
// build artefacts), and source maps that must point to the published sources of the
// package with relative paths (never to the absolute paths of the machine that built it).
// Names are compared without case: on the file systems of macOS and Windows, `Test/` or
// `.NPMRC` are the same as `test/` and `.npmrc`.
import { fileURLToPath } from "node:url";

const deniedDirectories = new Set([
  ".git",
  "__fixtures__",
  "__mocks__",
  "__tests__",
  "cert",
  "certs",
  "coverage",
  "e2e",
  "fixture",
  "fixtures",
  "mocks",
  "node_modules",
  "spec",
  "test",
  "testdata",
  "tests",
]);

const deniedFiles = [
  // *.test.*, *.spec.*, *.e2e.*, *_test.*, *-test.* and test.*
  [
    /(?:(?:\.(?:test|spec|e2e)|[_-]test)\.[^/]+|(?:^|\/)test\.[^/]+)$/iu,
    "a test",
  ],
  [/\.mock\.[^/]+$/iu, "a mock"],
  [
    /\.(?:asc|cer|crt|csr|der|gpg|jks|kdbx|key|keystore|ovpn|p12|p7b|p8|pem|pfx|pkcs12|ppk)$/iu,
    "a certificate or a key",
  ],
  // The private (and public) keys of SSH: id_rsa, id_ed25519_sk.pub, … (not id_token.js)
  [
    /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?(?:\.pub)?$/iu,
    "a certificate or a key",
  ],
  [
    /(?:^|\/)(?:\.git-credentials|[._]netrc|\.pypirc|\.pgpass|\.htpasswd|\.yarnrc\.yml|credentials\.json|\.aws\/credentials|\.docker\/config\.json|\.kube\/config)$/iu,
    "a credential file",
  ],
  [/(?:^|\/)\.env(?:rc|\.[^/]*)?$/iu, "an environment file"],
  [/(?:^|\/)\.npmrc$/iu, "an npm configuration file"],
  [/\.(?:log|tgz|tsbuildinfo)$/iu, "a build artefact"],
];

// A URL scheme, or a Windows drive (`C:`)
const scheme = /^[A-Za-z][\d+.A-Za-z-]*:/u;

// The root of a package, as a URL: the links of source maps are URLs (ECMA-426), resolved
// against the URL of the file that has them
const root = "/package/";

// The encodings that a URL parser reads as a dot of a `.` or `..` segment, as a slash or a
// backslash (a slash in a `file:` URL), or that decode to a control character
const ambiguousEncoding = /%(?:2e|2f|5c|[01][\da-f]|7f)/iu;

// The links to a source map, in both comment forms: `//# sourceMappingURL=<url>` (to the end
// of the line) and `/*# sourceMappingURL=<url> */` (to the end of the comment), or `@`
// instead of `#`. V8 (Node.js) and the browsers follow the last COMMENT, wherever it is,
// while a search of the text cannot tell a comment from a string or a template literal
// that looks like one: every match is checked, in every published file (Node.js runs
// TypeScript sources too, bundlers and browsers read other files), and its value must be
// one relative path to a published map.
const mappingURLs =
  /\/(?:\/[#@]\s*sourceMappingURL=(?<line>[^\n\r\u2028\u2029]*)|\*[#@]\s*sourceMappingURL=(?<block>(?:[^*]|\*(?!\/))*))/gu;

// The source maps
const sourceMap = /\.map$/iu;

/** Why `path` (relative to the root of the package) must not be published, or null */
export function deniedReason(path) {
  const directory = path
    .split("/")
    .slice(0, -1)
    .map((name) => name.toLowerCase())
    .find((name) => deniedDirectories.has(name));
  if (typeof directory !== "undefined") {
    return `a file of a ${directory}/ directory`;
  }
  return deniedFiles.find(([pattern]) => pattern.test(path))?.[1] ?? null;
}

// Whether a URL parser reads `target` otherwise than a path: with a control character
// (it drops tabs and newlines) or a space at either end (it trims them), a backslash, a
// query or a fragment, or an ambiguous encoding (e.g. `%2e%2e`, a `..` segment)
function ambiguous(target) {
  return (
    target.trim() !== target ||
    [...target].some(
      (char) => char < " " || char === "\x7f" || "\\?#".includes(char),
    ) ||
    ambiguousEncoding.test(target)
  );
}

// The path of a `file:` URL, decoded, or null (e.g. for an invalid percent-encoding)
function decodedPath(url) {
  try {
    return fileURLToPath(url, { windows: false });
  } catch {
    return null;
  }
}

/**
 * The path that `target`, a URL relative to the file `from`, points to inside the
 * package, or null when it is not a relative URL (absolute, with a scheme or an
 * authority, a Windows path), when it is ambiguous (see `ambiguous()`), or when it
 * points outside of the package. It is resolved as a URL against `from` (as
 * `file:///package/<from>`), then decoded into a path (`fileURLToPath()`), which is
 * the one that is checked.
 */
export function resolveInside(from, target) {
  if (
    target === "" ||
    target.startsWith("/") ||
    scheme.test(target) ||
    ambiguous(target)
  ) {
    return null;
  }
  const base = `file://${root}${from.split("/").map(encodeURIComponent).join("/")}`;
  const path = decodedPath(URL.parse(target, base));
  const inside = path?.startsWith(root) ? path.slice(root.length) : "";
  return inside === "" ? null : inside;
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
  // The generated file, relative to the map (never the path where it was built)
  if (
    typeof map.file !== "undefined" &&
    map.file !== "" &&
    (typeof map.file !== "string" || resolveInside(path, map.file) === null)
  ) {
    errors.push(
      `${path}: file ${JSON.stringify(map.file)} is not a relative path inside the package`,
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
  return [...content.toString("utf8").matchAll(mappingURLs)].flatMap(
    ({ groups }) => {
      const url = (groups.line ?? groups.block).trim();
      const target = /\s/u.test(url) ? null : resolveInside(path, url);
      if (target === null || !sourceMap.test(target)) {
        return [
          `${path}: sourceMappingURL ${JSON.stringify(url)} is not a relative path to a map inside the package`,
        ];
      }
      return files.has(target)
        ? []
        : [`${path}: sourceMappingURL ${target} is not published`];
    },
  );
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
    } else if (sourceMap.test(path)) {
      errors.push(...mapErrors(path, read(path), files));
    } else {
      errors.push(...mappingURLErrors(path, read(path), files));
    }
  }
  return errors;
}
