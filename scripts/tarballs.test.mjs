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
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { npm } from "./npm.mjs";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const tarballs = pathToFileURL(join(import.meta.dirname, "tarballs.mjs")).href;

// The error of readTarball() for `data`, in a child process with a deadline: a parser that
// never ends fails the test (the test runner cannot interrupt a synchronous loop)
function readError(data) {
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
    { input: data, encoding: "utf8", timeout: 10_000 },
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
    const header = Buffer.alloc(1024);
    header.write("package/a", 0);
    header.write("12345678\0", 124);
    throws(
      () => readTarball(gzipSync(header)),
      /Invalid tar header: "12345678"/u,
    );
    throws(
      () => readTarball(Buffer.from("not gzip")),
      /incorrect header check/u,
    );
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
