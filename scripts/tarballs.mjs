// The npm tarballs of a release: what is inside an archive (read without a `tar`
// command, whose options differ between platforms), its integrity as npm records it
// (`dist.integrity`), and the manifest that `scripts/release.mjs pack` writes next
// to the archives, which the checks and the publication read instead of packing again.
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";

/** The file that lists the archives of a release, in the directory of the archives */
export const manifestFile = "release-manifest.json";

const blockSize = 512;
const root = "package/";

/** The integrity of `data` as npm records it (`dist.integrity`): `sha512-<base64>` */
export function integrity(data) {
  return `sha512-${createHash("sha512").update(data).digest("base64")}`;
}

function text(header, offset, length) {
  const bytes = header.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? length : end).toString("utf8");
}

function octal(header, offset, length) {
  const value = text(header, offset, length).trim();
  if (!/^[0-7]+$/u.test(value)) {
    throw new Error(`Invalid tar header: ${JSON.stringify(value)}`);
  }
  return Number.parseInt(value, 8);
}

// The `path` record of a pax extended header (records are `<length> <key>=<value>\n`)
function paxPath(data) {
  let path = null;
  for (let offset = 0; offset < data.length;) {
    const space = data.indexOf(0x20, offset);
    const length = data.subarray(offset, space).toString("utf8");
    const end = offset + Number(length);
    if (
      space === -1 ||
      !/^\d+$/u.test(length) ||
      end <= space ||
      end > data.length
    ) {
      throw new Error("Invalid pax header");
    }
    const record = data.subarray(space + 1, end - 1).toString("utf8");
    const separator = record.indexOf("=");
    if (record.slice(0, separator) === "path") {
      path = record.slice(separator + 1);
    }
    offset = end;
  }
  return path;
}

/**
 * The regular files of a gzipped npm tarball, by their path inside its `package/`
 * directory. Directories are skipped; links and other entries are refused.
 */
export function readTarball(data) {
  const tar = gunzipSync(data);
  const files = new Map();
  let longPath = null;
  for (let offset = 0; offset + blockSize <= tar.length;) {
    const header = tar.subarray(offset, offset + blockSize);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const size = octal(header, 124, 12);
    const start = offset + blockSize;
    const content = tar.subarray(start, start + size);
    if (content.length !== size) {
      throw new Error("Truncated tarball");
    }
    offset = start + Math.ceil(size / blockSize) * blockSize;

    const type = String.fromCharCode(header[156]);
    if (type === "x") {
      longPath = paxPath(content);
    } else if (type === "L") {
      longPath = text(content, 0, content.length);
    } else {
      const prefix = text(header, 345, 155);
      const name = text(header, 0, 100);
      const path = longPath ?? (prefix === "" ? name : `${prefix}/${name}`);
      longPath = null;
      if (!path.startsWith(root)) {
        throw new Error(`Unexpected path in the tarball: ${path}`);
      }
      if (["0", "\0", "7"].includes(type)) {
        files.set(path.slice(root.length), content);
      } else if (type !== "5") {
        throw new Error(`Unsupported entry in the tarball: ${path} (${type})`);
      }
    }
  }
  return files;
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
