import { suite, test } from "node:test";
import { deepStrictEqual } from "node:assert";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Runs a fixture (`test/fixtures`) in a process of its own: a crash (e.g. an
 * unhandled rejection) is its exit code and output, not a failure of the
 * test runner
 */
function run(fixture: string, ...args: string[]): Record<string, unknown> {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      join(import.meta.dirname, "fixtures", fixture),
      ...args,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  return { status, stdout, stderr };
}

/** The refusal of a view whose bytes are gone, formatted before the application gets it */
const lost = "The data is a view of a detached ArrayBuffer (formatted)";

suite("Process safety", () => {
  test("a `filter` that returns a rejected promise does not crash the process", () => {
    deepStrictEqual(run("filter-rejection.ts"), {
      status: 0,
      stdout: "500 500\n",
      stderr: "",
    });
  });

  test("a refused chunk once the compression has ended the response does not crash the process", () => {
    deepStrictEqual(run("ended-chunk.ts"), {
      status: 0,
      stdout: [
        "/write-end HTTP/1.1 406 Not Acceptable",
        "/write-end-object HTTP/1.1 406 Not Acceptable",
        "/write-write HTTP/1.1 406 Not Acceptable",
        "/head-end HTTP/1.1 406 Not Acceptable",
        "/head-end-object HTTP/1.1 406 Not Acceptable",
        "/head-write HTTP/1.1 406 Not Acceptable",
        "/compressed HTTP/1.1 200 OK",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  test("a `filter` that detaches the bytes of a view given to send(), or of a chunk of a Readable, inside the write of binden: the send rejects with the TypeError of binden, formatted, and the connection is closed before the head is flushed, compressed or not (H26-1)", () => {
    for (const mode of ["send", "chunks"]) {
      for (const threshold of ["0", "100000"]) {
        deepStrictEqual(
          run("detaching-filter.ts", mode, threshold, "detach"),
          { status: 0, stdout: `${lost} | \n`, stderr: "" },
          `${mode} ${threshold}`,
        );
        deepStrictEqual(
          run("detaching-filter.ts", mode, threshold, "keep"),
          {
            status: 0,
            stdout: "resolved | HTTP/1.1 200 HTTP/1.1 200 next\n",
            stderr: "",
          },
          `${mode} ${threshold}`,
        );
      }
    }
  });

  test("the 406 that replaces a response inside the write of binden drops the bytes of the view (or of the chunks of a Readable of views), whether the `filter` has detached them or not: the send resolves, the 406 is replied, and the connection is reused (C27-1)", () => {
    for (const mode of ["send", "chunks"]) {
      for (const detach of ["keep", "detach"]) {
        deepStrictEqual(
          run("detaching-filter.ts", mode, "406", detach),
          {
            status: 0,
            stdout: "resolved | HTTP/1.1 406 HTTP/1.1 200 next\n",
            stderr: "",
          },
          `${mode} ${detach}`,
        );
      }
    }
  });

  test("a head that Node.js refuses under a decision does not crash the process", () => {
    deepStrictEqual(run("refused-head.ts"), {
      status: 0,
      stdout: "HTTP/1.1 500 Internal Server Error (0 bytes) (19)\n",
      stderr: "",
    });
  });
});
