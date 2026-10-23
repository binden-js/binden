import { afterEach, beforeEach, describe, it } from "node:test";
import {
  compareFiles,
  inspectTarball,
  integrity,
  manifestFile,
  readRelease,
  readTarball,
} from "./tarballs.mjs";
import { deepEqual, equal, match, throws } from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { npmTarball, paxRecord, tar } from "./fixtures/tar.mjs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { npm } from "./npm.mjs";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const tarballs = pathToFileURL(join(import.meta.dirname, "tarballs.mjs")).href;

// The error of readTarball() for `data`, in a child process with a deadline: a parser that
// never ends fails the test (the test runner cannot interrupt a synchronous loop)
function readError(data, env = process.env) {
  const { stdout, error } = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { readTarball } from ${JSON.stringify(tarballs)};
import { readFileSync } from "node:fs";
try {
  readTarball(readFileSync(0));
} catch (error) {
  process.stdout.write(error.message);
}`,
    ],
    { input: data, encoding: "utf8", timeout: 10_000, env },
  );
  if (error) {
    throw error;
  }
  return stdout;
}

const long = `dist/${"a".repeat(60)}/${"b".repeat(60)}/index.js`;
const longer = `dist/${"c".repeat(120)}.js`;

const contents = (files) =>
  Object.fromEntries(
    [...files].map(([path, content]) => [path, content.toString("utf8")]),
  );

describe("scripts/tarballs.mjs", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "binden-tarballs-"));
  });

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  it("reads the archives of npm, and computes their integrity like npm", () => {
    const pkg = join(dir, "pkg");
    const files = {
      "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }),
      "index.js": "export {};\n",
      // Split into the ustar prefix, and in a pax header (longer than 155 bytes)
      [long]: "long\n",
      [longer]: "longer\n",
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(pkg, path, ".."), { recursive: true });
      writeFileSync(join(pkg, path), content);
    }
    const [packed] = JSON.parse(
      npm(["pack", "--json", "--ignore-scripts", "--pack-destination", dir], {
        cwd: pkg,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      }),
    );
    const data = readFileSync(join(dir, packed.filename));
    equal(integrity(data), packed.integrity);
    deepEqual(contents(readTarball(data)), files);
  });

  it("computes the integrity as the base64 of the SHA-512 digest", () => {
    const digest = createHash("sha512").update("data").digest("base64");
    equal(integrity(Buffer.from("data")), `sha512-${digest}`);
  });

  it("reads the long paths of ustar, pax and GNU headers", () => {
    const data = tar([
      { name: "package/", type: "5" },
      { name: "index.js", prefix: "package/dist", content: "a" },
      {
        name: "PaxHeader/x",
        type: "x",
        content: `${paxRecord("mtime", "1")}${paxRecord("path", `package/${longer}`)}`,
      },
      { name: "ignored", content: "b" },
      { name: "././@LongLink", type: "L", content: `package/${long}\0` },
      { name: "ignored", content: "c" },
      { name: "package/README.md", content: "d" },
      { name: "PaxHeader/y", type: "x", content: paxRecord("mtime", "1") },
      { name: "package/package.json", content: "{}", type: "\0" },
    ]);
    deepEqual(contents(readTarball(data)), {
      "dist/index.js": "a",
      [longer]: "b",
      [long]: "c",
      "README.md": "d",
      "package.json": "{}",
    });
  });

  it("refuses entries outside package/, links and broken archives", () => {
    for (const [entries, error] of [
      [
        [{ name: "other/index.js" }],
        /Unexpected path in the tarball: other\/index\.js/u,
      ],
      [
        [{ name: "index.js", prefix: "pkg" }],
        /Unexpected path in the tarball: pkg\/index\.js/u,
      ],
      [
        [{ name: "package/link", type: "2" }],
        /Unsupported entry in the tarball: package\/link \(2\)/u,
      ],
      [
        [
          {
            name: "pax_global_header",
            type: "g",
            content: paxRecord("path", "x"),
          },
        ],
        /Unexpected path in the tarball: pax_global_header/u,
      ],
      [
        [{ name: "package/a", content: "abc", size: 4096 }],
        /Truncated tarball/u,
      ],
      [
        [{ name: "PaxHeader/x", type: "x", content: "99 path=a\n" }],
        /Invalid pax header/u,
      ],
      [
        [{ name: "PaxHeader/x", type: "x", content: "x path=a\n" }],
        /Invalid pax header/u,
      ],
      [
        [{ name: "PaxHeader/x", type: "x", content: "path=a\n" }],
        /Invalid pax header/u,
      ],
      [
        [{ name: "PaxHeader/x", type: "x", content: "0 \n" }],
        /Invalid pax header/u,
      ],
    ]) {
      match(readError(tar(entries)), error);
    }
    throws(
      () =>
        readTarball(
          tar([{ name: "package/a", sizeField: Buffer.from("12345678\0") }]),
        ),
      /Invalid tar header: "12345678"/u,
    );
    throws(
      () => readTarball(Buffer.from("not gzip")),
      /incorrect header check/u,
    );
  });

  it("refuses what npm's tar would read otherwise", () => {
    const file = { name: "package/index.js", content: "a" };
    const pax = (...records) => ({
      name: "PaxHeader/index.js",
      type: "x",
      content: records.map(([key, value]) => paxRecord(key, value)).join(""),
    });
    const zero = Buffer.alloc(512);
    for (const [name, data, error] of [
      // Its pax records: only `path`, `mtime` and `size` (which npm writes), each once
      [
        "pax uid",
        tar([pax(["uid", "0"]), file]),
        /Unsupported pax record in the tarball: "uid=0"/u,
      ],
      [
        "pax linkpath",
        tar([pax(["linkpath", "package/a"]), file]),
        /Unsupported pax record/u,
      ],
      [
        "pax sparse file",
        tar([pax(["GNU.sparse.size", "1"]), file]),
        /Unsupported pax record/u,
      ],
      [
        "pax record without a key",
        tar([pax(["", "a"]), file]),
        /Unsupported pax record in the tarball: "=a"/u,
      ],
      [
        "pax record without =",
        tar([{ name: "PaxHeader/a", type: "x", content: "9 path_a\n" }, file]),
        /Unsupported pax record in the tarball: "path_a"/u,
      ],
      [
        "pax record twice",
        tar([pax(["path", "package/a"], ["path", "package/b"]), file]),
        /Duplicate pax record in the tarball: path/u,
      ],
      [
        "pax record without its newline",
        tar([{ name: "PaxHeader/a", type: "x", content: "9 size=1 " }, file]),
        /Invalid pax header/u,
      ],
      [
        "pax size of another framing",
        tar([pax(["size", "2"]), file]),
        /The pax size of package\/index\.js \(2\) differs from its size \(1\)/u,
      ],
      [
        "pax size not decimal",
        tar([pax(["size", "0x1"]), file]),
        /Invalid pax size/u,
      ],
      [
        "pax size not safe",
        tar([pax(["size", "9007199254740993"]), file]),
        /Invalid pax size/u,
      ],
      ["pax mtime", tar([pax(["mtime", "soon"]), file]), /Invalid pax mtime/u],
      // The end of the archive: two zero blocks, then zeros only
      [
        "a single zero block between entries",
        tar([file, zero, { ...file, name: "package/package.json" }]),
        /A single zero block in the tarball, before its end/u,
      ],
      [
        "a single zero block at the end",
        tar([file], { end: zero }),
        /A single zero block in the tarball, before its end/u,
      ],
      [
        "a zero block and data at the end",
        tar([file], { end: Buffer.concat([zero, Buffer.from("x")]) }),
        /A single zero block in the tarball, before its end/u,
      ],
      [
        "data after the end",
        tar([file], { end: Buffer.concat([zero, zero, Buffer.from("x")]) }),
        /Data after the end of the tarball/u,
      ],
      [
        "an entry after the end",
        tar([file, zero, zero, { ...file, name: "package/package.json" }]),
        /Data after the end of the tarball/u,
      ],
      ["no end", tar([file], { end: Buffer.alloc(0) }), /no end of archive/u],
      [
        "a truncated header",
        tar([file], { end: Buffer.alloc(100) }),
        /no end of archive/u,
      ],
      [
        "data without its padding",
        tar([{ ...file, padded: false }], { end: Buffer.alloc(0) }),
        /^Truncated tarball$/u,
      ],
      [
        "an extended header without its entry",
        tar([pax(["path", "package/a"])]),
        /An extended header without its entry in the tarball/u,
      ],
      [
        "two extended headers",
        tar([
          pax(["path", "package/a"]),
          { name: "././@LongLink", type: "L", content: "package/b" },
          file,
        ]),
        /Consecutive extended headers in the tarball/u,
      ],
      // Its headers: octal sizes, checksums
      [
        "a base-256 size",
        tar([
          {
            ...file,
            sizeField: Buffer.from([0x80, ...Buffer.alloc(10), 1]),
          },
        ]),
        /Unsupported base-256 number in a tar header/u,
      ],
      [
        "a wrong checksum",
        tar([{ ...file, checksum: 1 }]),
        /Invalid checksum of a tar header/u,
      ],
      // Its entries: regular files and directories (without data) only
      ...[
        ["1", "a hard link"],
        ["2", "a symbolic link"],
        ["3", "a character device"],
        ["4", "a block device"],
        ["6", "a FIFO"],
        ["K", "a GNU long link"],
        ["Z", "an unknown type"],
      ].map(([type, kind]) => [
        kind,
        tar([{ ...file, type }]),
        new RegExp(
          `Unsupported entry in the tarball: package/index\\.js \\(${type}\\)`,
          "u",
        ),
      ]),
      [
        "a directory with data",
        tar([{ name: "package/dist/", type: "5", content: "a" }]),
        /A directory with data in the tarball: package\/dist\//u,
      ],
      // Its paths: normalized, each once (also without case), never inside a file
      ...[
        "package//a.js",
        "package/./a.js",
        "package/dist/../a.js",
        "package/..",
        "package/a.js/",
        "package/a\\b.js",
        "package/a\nb.js",
        "package/a\u007fb.js",
        "package/",
      ].map((path) => [
        path,
        tar([{ ...file, name: path }]),
        /Path not normalized in the tarball/u,
      ]),
      [
        "a path that is not UTF-8",
        tar([
          {
            ...file,
            name: Buffer.concat([
              Buffer.from("package/a"),
              Buffer.from([0xff]),
            ]),
          },
        ]),
        /Invalid UTF-8 in the tarball/u,
      ],
      [
        "a file twice",
        tar([file, file]),
        /Duplicate path in the tarball: package\/index\.js/u,
      ],
      [
        "a file twice, but for its case",
        tar([file, { ...file, name: "package/INDEX.js" }]),
        /Duplicate path in the tarball: package\/INDEX\.js/u,
      ],
      [
        "a directory twice",
        tar([
          { name: "package/dist", type: "5" },
          { name: "package/dist/", type: "5" },
        ]),
        /Duplicate path in the tarball: package\/dist\//u,
      ],
      [
        "a file inside a file",
        tar([file, { ...file, name: "package/index.js/a.js" }]),
        /Duplicate path in the tarball: package\/index\.js\/a\.js/u,
      ],
      [
        "a file at the path of a directory",
        tar([
          { ...file, name: "package/dist/a.js" },
          { ...file, name: "package/dist" },
        ]),
        /Duplicate path in the tarball: package\/dist/u,
      ],
      // npm's tar (of the npm that publishes) reads the same entries: here, it ignores
      // the prefix of a header that is not ustar (e.g. GNU), and a large pax header
      [
        "the prefix of a GNU header",
        tar([
          {
            name: "package.json",
            prefix: "package",
            magic: "ustar  \0",
            content: "{}",
          },
        ]),
        /npm's tar reads the tarball otherwise: entry 1 is package\.json \(File\) for npm, package\/package\.json \(file\) here/u,
      ],
      [
        "a pax header that npm's tar ignores",
        tar([
          pax(["path", `package/${"a".repeat(1024 * 1024)}`]),
          { ...file, name: "package/a" },
        ]),
        /npm's tar refuses the tarball: ignored PaxHeader\/index\.js/u,
      ],
    ]) {
      match(readError(data), error, name);
    }
  });

  // A package.json that npm installs, hidden from a reader that frames README.md by the
  // size of its ustar header (not by its pax size), or stops at the first zero block
  it("refuses archives that hide a package.json", () => {
    const good = `${JSON.stringify({ name: "@fx/b", version: "1.1.0" }, null, 2)}\n`;
    const evil = `${JSON.stringify({ name: "@fx/b", version: "1.1.0", scripts: { postinstall: "node -e 1" } }, null, 2)}\n`;
    const block = (content) => {
      const data = Buffer.from(content);
      return Buffer.concat([
        data,
        Buffer.alloc(511 - ((data.length + 511) % 512)),
      ]);
    };
    // The README.md of npm (4 bytes), then the header and the data of a package.json
    const inside = Buffer.concat([
      block("# b\n"),
      gunzipSync(
        tar([{ name: "package/package.json", content: evil }]),
      ).subarray(0, 512 + block(evil).length),
    ]);
    for (const [data, error] of [
      [
        tar([
          { name: "package/package.json", content: good },
          {
            name: "PaxHeader/README.md",
            type: "x",
            content: paxRecord("size", "4"),
          },
          { name: "package/README.md", content: inside },
          { name: "package/index.js", content: "export default 'b';\n" },
        ]),
        /The pax size of package\/README\.md \(4\) differs from its size \(1536\)/u,
      ],
      [
        tar([
          { name: "package/package.json", content: good },
          { name: "package/index.js", content: "x\n" },
          Buffer.alloc(512),
          { name: "package/package.json", content: evil },
        ]),
        /A single zero block in the tarball, before its end/u,
      ],
    ]) {
      match(readError(data), error);
    }
  });

  it("reads every archive with the tar of the npm that publishes it", () => {
    // An npm installation (the CLI of `npm_execpath`), whose tar reads otherwise
    const installation = join(dir, "npm");
    const fake = join(installation, "node_modules", "tar");
    mkdirSync(join(installation, "bin"), { recursive: true });
    mkdirSync(fake, { recursive: true });
    writeFileSync(
      join(installation, "package.json"),
      JSON.stringify({ name: "npm" }),
    );
    writeFileSync(join(installation, "bin", "npm-cli.js"), "");
    writeFileSync(join(fake, "package.json"), JSON.stringify({ name: "tar" }));
    const env = {
      ...process.env,
      npm_execpath: join(installation, "bin", "npm-cli.js"),
    };
    const data = npmTarball({ "package.json": "{}" });
    for (const [parser, error] of [
      [
        "end() { this.emit('end'); }",
        /entry 1 is nothing for npm, package\/package\.json \(file\) here/u,
      ],
      [
        "end() { this.emit('warn', 'TAR_ENTRY_INVALID', 'checksum failure'); this.emit('end'); }",
        /npm's tar refuses the tarball: TAR_ENTRY_INVALID checksum failure/u,
      ],
      [
        "end() { this.emit('error', new Error('zlib: unexpected end of file')); this.emit('end'); }",
        /npm's tar refuses the tarball: zlib: unexpected end of file/u,
      ],
      ["end() {}", /npm's tar refuses the tarball: not read whole/u],
      [
        `end() {
          const entry = new (require("node:events"))();
          Object.assign(entry, { path: "package/package.json", type: "File" });
          this.emit("entry", entry);
          this.emit("end");
        }`,
        /npm's tar refuses the tarball: not read whole/u,
      ],
      [
        `end() {
          const entry = new (require("node:events"))();
          Object.assign(entry, { path: "package/package.json", type: "SymbolicLink" });
          this.emit("entry", entry);
          entry.emit("data", Buffer.from("{}"));
          entry.emit("end");
          this.emit("end");
        }`,
        /entry 1 is package\/package\.json \(SymbolicLink\) for npm, package\/package\.json \(file\) here/u,
      ],
      [
        `end() {
          const entry = new (require("node:events"))();
          Object.assign(entry, { path: "package/package.json", type: "File" });
          this.emit("entry", entry);
          entry.emit("data", Buffer.from("[]"));
          entry.emit("end");
          this.emit("end");
        }`,
        /entry 1 is package\/package\.json \(File\) for npm, package\/package\.json \(file\) here/u,
      ],
    ]) {
      writeFileSync(
        join(fake, "index.js"),
        `module.exports.Parser = class extends require("node:events") { ${parser} };`,
      );
      match(readError(data, env), error);
    }
  });

  it("reads the archives that npm's tar reads alike", () => {
    const data = tar(
      [
        { name: "package/", type: "5" },
        {
          name: "PaxHeader/a",
          type: "x",
          content: `${paxRecord("path", `package/dist/${"a".repeat(120)}.js`)}${paxRecord("mtime", "499162500.5")}${paxRecord("size", "1")}`,
        },
        { name: "ignored", content: "a" },
        { name: "package/dist/", type: "5" },
        { name: "package/README.md", content: "readme", type: "7" },
        { name: "package/package.json", content: "{}" },
      ],
      { end: Buffer.alloc(10_240) },
    );
    deepEqual(contents(readTarball(data)), {
      [`dist/${"a".repeat(120)}.js`]: "a",
      "README.md": "readme",
      "package.json": "{}",
    });
  });

  it("inspects the package.json and the sorted files of an archive", () => {
    const data = npmTarball({
      "package.json": '{"name":"a","gitHead":"0"}',
      "b.js": "",
      "a.js": "",
    });
    deepEqual(inspectTarball(data), {
      manifest: { name: "a", gitHead: "0" },
      files: ["a.js", "b.js", "package.json"],
    });
    throws(
      () => inspectTarball(npmTarball({ "index.js": "" })),
      /No package\.json in the tarball/u,
    );
  });

  it("compares the files of each package with the expected ones", () => {
    deepEqual(compareFiles({ a: ["x", "y"] }, { a: ["y", "x"] }), []);
    deepEqual(
      compareFiles({ a: ["x", "y"], c: ["z"] }, { a: ["x", "w"], b: ["v"] }),
      ["a: unexpected w", "a: missing y", "c: missing z", "b: unexpected v"],
    );
  });

  describe("readRelease", () => {
    const entry = (file, data) => ({
      name: "a",
      version: "1.0.0",
      sha: "0".repeat(40),
      integrity: integrity(data),
      file,
    });
    const write = (packages) => {
      writeFileSync(join(dir, manifestFile), JSON.stringify({ packages }));
    };

    it("lists the archives of the manifest, in its order", () => {
      writeFileSync(join(dir, "b.tgz"), "b");
      writeFileSync(join(dir, "a.tgz"), "a");
      const packages = [entry("b.tgz", "b"), entry("a.tgz", "a")];
      write(packages);
      deepEqual(
        readRelease(dir),
        packages.map((value) => ({ ...value, path: join(dir, value.file) })),
      );
    });

    it("refuses an archive that changed", () => {
      writeFileSync(join(dir, "a.tgz"), "changed");
      write([entry("a.tgz", "a")]);
      throws(
        () => readRelease(dir),
        /a\.tgz: integrity sha512-\S+ differs from sha512-\S+ \(release-manifest\.json\)/u,
      );
    });

    it("refuses an invalid manifest", () => {
      const target = dir;
      writeFileSync(join(target, "a.tgz"), "a");
      for (const [packages, error] of [
        [null, /no packages/u],
        [[], /no packages/u],
        [{}, /no packages/u],
        [[null], /invalid entry null/u],
        [[{ ...entry("a.tgz", "a"), sha: 1 }], /invalid entry/u],
        [[{ ...entry("a.tgz", "a"), file: null }], /invalid entry/u],
        [[entry("../a.tgz", "a")], /invalid file name \.\.\/a\.tgz/u],
        [[entry("sub/a.tgz", "a")], /invalid file name sub\/a\.tgz/u],
        [[entry("a.tar", "a")], /invalid file name a\.tar/u],
      ]) {
        write(packages);
        throws(() => readRelease(target), error);
      }
      rmSync(join(dir, manifestFile));
      throws(() => readRelease(dir), /ENOENT/u);
    });
  });
});
