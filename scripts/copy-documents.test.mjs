import { afterEach, beforeEach, describe, it } from "node:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { equal, match } from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const scripts = ["copy-documents.mjs", "clean.mjs"];

describe("scripts/copy-documents.mjs and scripts/clean.mjs", () => {
  let root = "";
  let workspace = "";

  // Runs a script in the workspace, as its npm scripts do
  const run = (script, ...args) =>
    spawnSync(process.execPath, [join(root, "scripts", script), ...args], {
      cwd: workspace,
      encoding: "utf8",
      timeout: 60_000,
    });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "binden-documents-"));
    workspace = join(root, "packages", "a");
    mkdirSync(join(root, "scripts"));
    mkdirSync(workspace, { recursive: true });
    for (const script of scripts) {
      copyFileSync(
        join(import.meta.dirname, script),
        join(root, "scripts", script),
      );
    }
    writeFileSync(join(root, "MIGRATION.md"), "# Migration\n");
    writeFileSync(join(root, "PRODUCTION.md"), "# Production\n");
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  describe("copy-documents", () => {
    it("copies the documents of the root into the workspace", () => {
      writeFileSync(join(workspace, "PRODUCTION.md"), "stale\n");
      const { status, stderr } = run(
        "copy-documents.mjs",
        "MIGRATION.md",
        "PRODUCTION.md",
      );
      equal(status, 0, stderr);
      equal(
        readFileSync(join(workspace, "MIGRATION.md"), "utf8"),
        "# Migration\n",
      );
      equal(
        readFileSync(join(workspace, "PRODUCTION.md"), "utf8"),
        "# Production\n",
      );
      match(
        stderr,
        /\[documents\] MIGRATION\.md\n\[documents\] PRODUCTION\.md/u,
      );
    });

    it("fails without copying anything when a document is missing", () => {
      rmSync(join(root, "PRODUCTION.md"));
      mkdirSync(join(root, "SECURITY.md"));
      const { status, stderr } = run(
        "copy-documents.mjs",
        "MIGRATION.md",
        "PRODUCTION.md",
        "SECURITY.md",
      );
      equal(status, 1);
      match(
        stderr,
        /Missing at the root of the repository, but published by this package: PRODUCTION\.md, SECURITY\.md/u,
      );
      equal(existsSync(join(workspace, "MIGRATION.md")), false);
    });

    it("refuses paths that are not file names of the root", () => {
      for (const file of ["../MIGRATION.md", "docs/MIGRATION.md", ".", ".."]) {
        const { status, stderr } = run("copy-documents.mjs", file);
        equal(status, 1, file);
        match(stderr, /Not a file name of the root of the repository/u);
      }
    });

    it("fails without documents", () => {
      const { status, stderr } = run("copy-documents.mjs");
      equal(status, 1);
      match(stderr, /Usage: scripts\/copy-documents\.mjs <file>\.\.\./u);
    });
  });

  describe("clean", () => {
    it("removes dist and the given files of the workspace", () => {
      mkdirSync(join(workspace, "dist", "src"), { recursive: true });
      writeFileSync(join(workspace, "dist", "src", "a.js"), "");
      for (const file of ["MIGRATION.md", "PRODUCTION.md", "README.md"]) {
        writeFileSync(join(workspace, file), "");
      }
      const { status, stderr } = run(
        "clean.mjs",
        "MIGRATION.md",
        "PRODUCTION.md",
      );
      equal(status, 0, stderr);
      equal(existsSync(join(workspace, "dist")), false);
      equal(existsSync(join(workspace, "MIGRATION.md")), false);
      equal(existsSync(join(workspace, "PRODUCTION.md")), false);
      equal(existsSync(join(workspace, "README.md")), true);
      equal(existsSync(join(root, "MIGRATION.md")), true);
    });

    it("passes when there is nothing to remove", () => {
      const { status, stderr } = run("clean.mjs", "MIGRATION.md");
      equal(status, 0, stderr);
    });

    it("refuses paths outside of the workspace", () => {
      for (const file of ["../../MIGRATION.md", "..", ".", "a/b"]) {
        const { status, stderr } = run("clean.mjs", file);
        equal(status, 1, file);
        match(stderr, /Not a file name of the workspace/u);
      }
      equal(existsSync(join(root, "MIGRATION.md")), true);
    });
  });
});
