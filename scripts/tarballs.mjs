// The npm tarballs of a release: what is inside an archive (read without a `tar`
// command, whose options differ between platforms, then checked against the reading of
// npm's own `tar`), its integrity as npm records it (`dist.integrity`), and the manifest
// that `scripts/release.mjs pack` writes next to the archives, which the checks and the
// publication read instead of packing again.
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { npmTar } from "./npm.mjs";
import { readFileSync } from "node:fs";

/** The file that lists the archives of a release, in the directory of the archives */
export const manifestFile = "release-manifest.json";

const blockSize = 512;
const root = "package/";
// The records of a pax header that an archive may have: npm writes `path`, `mtime` and
// `size` for a path that a ustar header cannot hold
const paxKeys = new Set(["path", "mtime", "size"]);
// The regular files (`0`, the old `\0` and the contiguous `7`), and the directories
const types = new Map([
  ["0", "file"],
  ["\0", "file"],
  ["7", "file"],
  ["5", "directory"],
]);
// The types of node-tar's entries
const npmTypes = new Map([
  ["File", "file"],
  ["OldFile", "file"],
  ["ContiguousFile", "file"],
  ["Directory", "directory"],
]);
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** The integrity of `data` as npm records it (`dist.integrity`): `sha512-<base64>` */
export function integrity(data) {
  return `sha512-${createHash("sha512").update(data).digest("base64")}`;
}

function decode(bytes) {
  try {
    return utf8.decode(bytes);
  } catch {
    throw new Error("Invalid UTF-8 in the tarball");
  }
}

function text(header, offset, length) {
  const bytes = header.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  return decode(bytes.subarray(0, end === -1 ? length : end));
}

function octal(header, offset, length) {
  if ((header[offset] & 0x80) !== 0) {
    // The base-256 encoding of GNU tar, for numbers that octal cannot hold
    throw new Error("Unsupported base-256 number in a tar header");
  }
  const value = text(header, offset, length).trim();
  if (!/^[0-7]+$/u.test(value)) {
    throw new Error(`Invalid tar header: ${JSON.stringify(value)}`);
  }
  // At most 12 octal digits: a safe integer
  return Number.parseInt(value, 8);
}

// The checksum of a header: the sum of its bytes, those of the checksum itself as spaces
function checkHeader(header) {
  let sum = 8 * 0x20;
  for (const [index, byte] of header.entries()) {
    sum += index >= 148 && index < 156 ? 0 : byte;
  }
  if (octal(header, 148, 8) !== sum) {
    throw new Error("Invalid checksum of a tar header");
  }
}

const isZero = (block) => block.every((byte) => byte === 0);

// The records of a pax extended header (`<length> <key>=<value>\n`): only those of
// `paxKeys`, each once
function paxRecords(data) {
  const records = new Map();
  for (let offset = 0; offset < data.length;) {
    const space = data.indexOf(0x20, offset);
    const length = data.subarray(offset, space).toString("latin1");
    const end = offset + Number(length);
    if (
      space === -1 ||
      !/^[1-9]\d*$/u.test(length) ||
      end <= space + 1 ||
      end > data.length ||
      data[end - 1] !== 0x0a
    ) {
      throw new Error("Invalid pax header");
    }
    const record = decode(data.subarray(space + 1, end - 1));
    const separator = record.indexOf("=");
    const key = record.slice(0, Math.max(separator, 0));
    if (!paxKeys.has(key)) {
      throw new Error(
        `Unsupported pax record in the tarball: ${JSON.stringify(record)}`,
      );
    } else if (records.has(key)) {
      throw new Error(`Duplicate pax record in the tarball: ${key}`);
    }
    records.set(key, record.slice(separator + 1));
    offset = end;
  }
  const size = records.get("size");
  if (
    typeof size !== "undefined" &&
    !(/^\d+$/u.test(size) && Number.isSafeInteger(Number(size)))
  ) {
    throw new Error(`Invalid pax size in the tarball: ${JSON.stringify(size)}`);
  }
  const mtime = records.get("mtime");
  if (typeof mtime !== "undefined" && !/^\d+(?:\.\d+)?$/u.test(mtime)) {
    throw new Error(
      `Invalid pax mtime in the tarball: ${JSON.stringify(mtime)}`,
    );
  }
  return records;
}

// The path of an entry inside `package/` (`""` for that directory itself), which must
// be normalized: no empty, `.` or `..` segment, no backslash and no control character
function entryPath(path, type) {
  if (!path.startsWith(root)) {
    throw new Error(`Unexpected path in the tarball: ${path}`);
  }
  const relative = path.slice(root.length);
  const trimmed =
    type === "directory" && relative.endsWith("/")
      ? relative.slice(0, -1)
      : relative;
  if (type === "directory" && relative === "") {
    return "";
  }
  if (
    trimmed.split("/").some((segment) => ["", ".", ".."].includes(segment)) ||
    [...trimmed].some((char) => char === "\\" || char < " " || char === "\x7f")
  ) {
    throw new Error(
      `Path not normalized in the tarball: ${JSON.stringify(path)}`,
    );
  }
  return trimmed;
}

// Adds the paths of the entries of an archive, each once (also without case, as on the
// file systems of Windows and macOS), and never inside the path of a file
function uniquePaths() {
  const seen = new Set();
  const files = new Set();
  const parents = new Set();
  return (path, type, raw) => {
    const key = path.normalize("NFC").toLowerCase();
    const segments = key.split("/");
    const ancestors = segments
      .slice(1)
      .map((_, index) => segments.slice(0, index + 1).join("/"));
    if (
      seen.has(key) ||
      (type === "file" && parents.has(key)) ||
      ancestors.some((ancestor) => files.has(ancestor))
    ) {
      throw new Error(`Duplicate path in the tarball: ${raw}`);
    }
    seen.add(key);
    (type === "file" ? files : parents).add(key);
    for (const ancestor of ancestors) {
      parents.add(ancestor);
    }
  };
}

// An entry of an archive (`{ path, type, raw, content }`), given its header, its data
// and its extended header (pax or GNU), if any
function readEntry(header, size, content, extended, addPath) {
  const flag = String.fromCharCode(header[156]);
  const prefix = text(header, 345, 155);
  const name = text(header, 0, 100);
  const raw =
    extended?.get("path") ?? (prefix === "" ? name : `${prefix}/${name}`);
  const paxSize = extended?.get("size");
  const type = types.get(flag);
  if (typeof paxSize !== "undefined" && Number(paxSize) !== size) {
    throw new Error(
      `The pax size of ${raw} (${paxSize}) differs from its size (${size})`,
    );
  } else if (!raw.startsWith(root)) {
    throw new Error(`Unexpected path in the tarball: ${raw}`);
  } else if (typeof type === "undefined") {
    throw new Error(`Unsupported entry in the tarball: ${raw} (${flag})`);
  } else if (type === "directory" && size !== 0) {
    throw new Error(`A directory with data in the tarball: ${raw}`);
  }
  const path = entryPath(raw, type);
  addPath(path, type, raw);
  return { path, type, raw, content };
}

/**
 * The entries of a tar archive (`{ path, type, raw, content }`), read strictly: a
 * complete header (with its checksum) and complete data for each, sizes in octal (the
 * one of a pax header equal to it), pax headers of `paxKeys` only, regular files and
 * directories (of size 0) only, in `package/`, at normalized paths, each once, then the
 * end of the archive (two zero blocks) followed by zeros only.
 */
function readEntries(tar) {
  const entries = [];
  const addPath = uniquePaths();
  // The pax or GNU header of the next entry
  let extended = null;
  for (let offset = 0; ;) {
    if (offset + blockSize > tar.length) {
      throw new Error("Truncated tarball: no end of archive");
    }
    const header = tar.subarray(offset, offset + blockSize);
    if (isZero(header)) {
      const next = tar.subarray(offset + blockSize, offset + 2 * blockSize);
      if (next.length < blockSize || !isZero(next)) {
        throw new Error("A single zero block in the tarball, before its end");
      } else if (extended !== null) {
        throw new Error("An extended header without its entry in the tarball");
      } else if (!isZero(tar.subarray(offset + 2 * blockSize))) {
        throw new Error("Data after the end of the tarball");
      }
      return entries;
    }
    checkHeader(header);
    const size = octal(header, 124, 12);
    const start = offset + blockSize;
    const end = start + Math.ceil(size / blockSize) * blockSize;
    if (end > tar.length) {
      throw new Error("Truncated tarball");
    }
    const content = tar.subarray(start, start + size);
    offset = end;

    const flag = String.fromCharCode(header[156]);
    if (flag !== "x" && flag !== "L") {
      entries.push(readEntry(header, size, content, extended, addPath));
      extended = null;
    } else if (extended === null) {
      extended =
        flag === "x"
          ? paxRecords(content)
          : new Map([["path", text(content, 0, content.length)]]);
    } else {
      throw new Error("Consecutive extended headers in the tarball");
    }
  }
}

// The entries of a gzipped archive as npm's own tar reads them (see `npmTar()` of
// scripts/npm.mjs), synchronously: a warning or an error of its parser refuses it
function npmEntries(data) {
  const { Parser } = npmTar();
  const entries = [];
  const problems = [];
  let ended = false;
  const parser = new Parser();
  parser.on("warn", (code, message) => problems.push(`${code} ${message}`));
  parser.on("error", (error) => problems.push(error.message));
  parser.on("ignoredEntry", (entry) => problems.push(`ignored ${entry.path}`));
  parser.on("entry", (entry) => {
    const chunks = [];
    const read = { path: String(entry.path), type: entry.type, content: null };
    entries.push(read);
    entry.on("data", (chunk) => chunks.push(chunk));
    entry.on("end", () => {
      read.content = Buffer.concat(chunks);
    });
  });
  parser.on("end", () => {
    ended = true;
  });
  parser.end(data);
  if (!ended || entries.some(({ content }) => content === null)) {
    problems.push("not read whole");
  }
  if (problems.length > 0) {
    throw new Error(`npm's tar refuses the tarball: ${problems.join(", ")}`);
  }
  return entries;
}

/**
 * The regular files of a gzipped npm tarball, by their path inside its `package/`
 * directory, read strictly (see `readEntries()`). Directories are skipped; links and
 * other entries are refused. npm's own tar (node-tar, of the npm that publishes) must
 * read the same entries: the same paths, types and bytes, in the same order.
 */
export function readTarball(data) {
  const entries = readEntries(gunzipSync(data));
  const npm = npmEntries(data);
  const count = Math.max(entries.length, npm.length);
  for (let index = 0; index < count; index += 1) {
    const ours = entries[index];
    const theirs = npm[index];
    if (
      typeof ours === "undefined" ||
      typeof theirs === "undefined" ||
      ours.raw !== theirs.path ||
      ours.type !== npmTypes.get(theirs.type) ||
      (ours.type === "file" && !ours.content.equals(theirs.content))
    ) {
      const describe = (entry) => {
        if (typeof entry === "undefined") {
          return "nothing";
        }
        return `${entry.raw ?? entry.path} (${entry.type})`;
      };
      throw new Error(
        `npm's tar reads the tarball otherwise: entry ${index + 1} is ${describe(theirs)} for npm, ${describe(ours)} here`,
      );
    }
  }
  return new Map(
    entries
      .filter(({ type }) => type === "file")
      .map(({ path, content }) => [path, content]),
  );
}

/** The `package.json` and the sorted file list of a gzipped npm tarball */
export function inspectTarball(data) {
  const files = readTarball(data);
  const manifest = files.get("package.json");
  if (typeof manifest === "undefined") {
    throw new Error("No package.json in the tarball");
  }
  return { manifest: JSON.parse(manifest), files: [...files.keys()].sort() };
}

/**
 * Compares the files of each package with the expected ones
 * (`scripts/pack-files.json`), and returns the differences
 */
export function compareFiles(expected, actual) {
  const errors = [];
  for (const name of new Set([
    ...Object.keys(expected),
    ...Object.keys(actual),
  ])) {
    const want = new Set(expected[name] ?? []);
    const have = new Set(actual[name] ?? []);
    for (const file of have.difference(want)) {
      errors.push(`${name}: unexpected ${file}`);
    }
    for (const file of want.difference(have)) {
      errors.push(`${name}: missing ${file}`);
    }
  }
  return errors;
}

/**
 * Reads the manifest of the archives in `dir`, and checks that every archive is
 * still the one that was packed (its integrity). Returns the packages in the order
 * of the manifest (the dependency order), with the path of their archive.
 */
export function readRelease(dir) {
  const { packages } = JSON.parse(
    readFileSync(join(dir, manifestFile), "utf8"),
  );
  if (!Array.isArray(packages) || packages.length === 0) {
    throw new Error(`${manifestFile}: no packages`);
  }
  return packages.map((entry) => {
    const fields = ["name", "version", "sha", "integrity", "file"];
    if (!fields.every((field) => typeof entry?.[field] === "string")) {
      throw new Error(
        `${manifestFile}: invalid entry ${JSON.stringify(entry)} (${fields.join(", ")})`,
      );
    }
    // The archives are next to the manifest: nothing else is read or published
    const { file } = entry;
    if (basename(file) !== file || !file.endsWith(".tgz")) {
      throw new Error(`${manifestFile}: invalid file name ${file}`);
    }
    const path = join(dir, file);
    const actual = integrity(readFileSync(path));
    if (actual !== entry.integrity) {
      throw new Error(
        `${file}: integrity ${actual} differs from ${entry.integrity} (${manifestFile})`,
      );
    }
    return { ...entry, path };
  });
}
