// The process-level acceptance scenarios (`scripts/acceptance/*.ts`) against the
// workspaces (built): each one runs in a process of its own (with tsx), with a
// deadline, and must exit with code 0, an empty stderr (no crash, no
// `unhandledRejection`, no warning) and what it has observed on stdout.
import { describe, it } from "node:test";
import { deepEqual } from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(import.meta.dirname, "..", "..");
// The scenarios use POSIX signals and descriptors
const skip = process.platform === "win32" && "POSIX only";

function run(scenario) {
  const { status, signal, stdout, stderr } = spawnSync(
    process.execPath,
    ["--import", "tsx", join(import.meta.dirname, scenario)],
    { cwd: root, encoding: "utf8", timeout: 60_000 },
  );
  let output = stdout;
  try {
    output = JSON.parse(stdout);
  } catch {
    // Compared as text
  }
  return { status, signal, stderr, output };
}

const item = {
  name: "tea",
  tags: Array.from({ length: 300 }, (_, index) => index),
};

describe("acceptance", { skip }, () => {
  it("the body parser, the multipart parser and the compression as shared middlewares", () => {
    deepEqual(run("shared.ts"), {
      status: 0,
      signal: null,
      stderr: "",
      output: {
        json: { status: 200, body: { received: item }, reused: false },
        compressed: {
          status: 200,
          encoding: "gzip",
          body: { received: item },
        },
        upload: {
          status: 200,
          body: {
            fields: { title: ["Report"] },
            files: [{ field: "document", filename: "report.txt", size: 4096 }],
          },
          reused: true,
        },
        // Neither parser has read it
        raw: {
          status: 200,
          body: { parsed: false, size: 100 * 1024 },
          reused: true,
        },
        refused: [
          { status: 415, reused: true },
          { status: 415, reused: true },
        ],
        leftovers: 0,
      },
    });
  });

  it("a client that goes away: the work settles, the signal is aborted, nothing is left", () => {
    const aborted = { outcome: "400 aborted", signal: "client_closed" };
    // The reply rejects (the writes fail)
    const closed = { outcome: "closed", signal: "client_closed" };
    deepEqual(run("disconnect.ts"), {
      status: 0,
      signal: null,
      stderr: "",
      output: {
        body: aborted,
        "verify never settles": aborted,
        "multipart (memory)": aborted,
        "multipart (disk)": aborted,
        "multipart (stream, on_file never settles)": aborted,
        uploads_left: 0,
        sendFile: { ...closed, encoding: null },
        compression: { ...closed, encoding: "gzip", source_closed: true },
      },
    });
  });

  it("SIGTERM with an idle kept-alive connection, a stream of events and a slow upload", () => {
    deepEqual(run("sigterm.ts"), {
      status: 0,
      signal: null,
      stderr: "",
      output: {
        order: [
          "SIGTERM",
          "idle connection closed",
          "upload replied",
          "events cut",
          "shutdown resolved",
        ],
        refused: "ECONNREFUSED",
        upload: {
          status: 200,
          connection: "close",
          body: { size: 64 * 1024 },
        },
        events: { complete: false, after_sigterm: true },
        cleanup: "shutdown",
        listening: false,
        received: true,
      },
    });
  });

  it(
    "a compressed reply of `send()` keeps its connection alive",
    {
      todo: "binden `#frame()` removes an absent `Transfer-Encoding`, which disables chunked framing",
    },
    () => {
      const chunked = { encoding: "gzip", framing: "chunked" };
      deepEqual(run("keep-alive.ts"), {
        status: 0,
        signal: null,
        stderr: "",
        output: [
          { reused: false, ...chunked },
          { reused: true, ...chunked },
          { reused: true, ...chunked },
        ],
      });
    },
  );
});
