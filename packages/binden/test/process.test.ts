import { suite, test } from "node:test";
import { deepStrictEqual } from "node:assert";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Runs a fixture (`test/fixtures`) in a process of its own (with the options
 * of Node.js, e.g. `--expose-gc`): a crash (e.g. an unhandled `error` event)
 * is its exit code and output, not a failure of the test runner
 */
function run(fixture: string, ...options: string[]): Record<string, unknown> {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [
      ...options,
      "--import",
      "tsx",
      join(import.meta.dirname, "fixtures", fixture),
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  return { status, stdout, stderr };
}

suite("Process safety", () => {
  test("a discarded source that fails to close does not crash the process", () => {
    deepStrictEqual(run("discarded-source.ts"), {
      status: 0,
      stdout: "200 204 200\n",
      stderr: "",
    });
  });

  test("a file that sendFile() no longer sends is closed, never by the collection of its handle", () => {
    // An error handler that fails (also through `Promise.all()`) or times out
    // while the file is opened or its metadata read, and a deadline once the
    // headers are flushed (which cancels nothing): 3 requests each
    deepStrictEqual(run("send-file-release.ts", "--expose-gc"), {
      status: 0,
      stdout:
        "/throws 500 rejected:handler fails streams=0 closed\n" +
        "/all 500 rejected:audit fails streams=0 closed\n" +
        "/expired 500 rejected:error_handler_timeout streams=0 closed\n" +
        "/flushed 200(cut) resolved streams=0 closed\n" +
        "fd growth=0 warnings=[]\n",
      stderr: "",
    });
  });

  test("the error serializer ends on a chain of prototypes that does not", () => {
    deepStrictEqual(run("cyclic-prototype.ts"), {
      status: 0,
      stdout: `[{"type":"object"},{"type":"object"}]\n`,
      stderr: "",
    });
  });

  test("hung middlewares and error handlers, and their late failures, do not crash the process", () => {
    deepStrictEqual(run("hangs.ts"), {
      status: 0,
      stdout: "503 503 500 500 500\n",
      stderr: "",
    });
  });

  test("a Content-Length of another type, set once a send has started and committed around binden, is no length that completes the body as the client goes away: the send rejects, no crash", () => {
    deepStrictEqual(run("foreign-length.ts"), {
      status: 0,
      stdout: "rejected\n",
      stderr: "",
    });
  });

  test("a pipe whose write or end throws fails its work: one reply, no crash", () => {
    deepStrictEqual(run("pipe-failures.ts"), {
      status: 0,
      stdout:
        "500(open) 500(open) 500(open) 500(open) 500(open) 200(closed) 200(closed)\n" +
        "committed-pipeline:ERR_INVALID_ARG_TYPE empty-pipeline:ERR_INVALID_CHAR pipeline:ERR_INVALID_CHAR\n",
      stderr: "",
    });
  });

  test("a string whose length Node.js estimates is framed by its bytes: also odd hex on Node.js 24", () => {
    // Odd hex, invalid hex and base64, an empty body, any case, a strict
    // length: alone, behind another response and after early hints (3 × 10)
    deepStrictEqual(run("estimated-lengths.ts"), {
      status: 0,
      stdout: "30\n",
      stderr: "",
    });
  });

  test("a pipe of a work into the response of another request leaves its failures to its own exchange", () => {
    deepStrictEqual(run("foreign-pipes.ts"), {
      status: 0,
      stdout:
        "promise+foreign A=500(open): B=200(open):B\n" +
        "promise A=500(open): B=200(open):B\n" +
        "callback+foreign A=500(open): B=200(open):B\n" +
        "callback A=500(open): B=200(open):B\n" +
        "callback:ERR_INVALID_CHAR callback:ERR_INVALID_CHAR promise:ERR_INVALID_CHAR promise:ERR_INVALID_CHAR\n",
      stderr: "",
    });
  });

  test("a `close` listener that throws surfaces as with Node.js, once the framework has completed the request", () => {
    deepStrictEqual(run("throwing-close.ts"), {
      status: 0,
      stdout: "listener,cleanup A close listener has failed logged:1\n",
      stderr: "",
    });
  });

  test("a reason phrase or a header that Node.js refuses does not crash the process", () => {
    deepStrictEqual(run("refused-head.ts"), {
      status: 0,
      stdout: "500 Internal Server Error (10)\n",
      stderr: "",
    });
  });

  test(
    "SIGTERM shuts the server down gracefully",
    // Windows has no SIGTERM handler: `kill("SIGTERM")` ends the process at once
    { skip: process.platform === "win32" },
    () => {
      deepStrictEqual(run("sigterm.ts"), {
        status: 0,
        stdout: "200 close done false\n",
        stderr: "",
      });
    },
  );

  test("a logger that rejects does not crash the process", () => {
    deepStrictEqual(run("async-logger.ts"), {
      status: 0,
      stdout: "200 500 400\n",
      stderr: "",
    });
  });

  test("a logger derived from one of binden, or a proxy of one, logs a failure, and a context whose `log` throws gets its reply: no crash", () => {
    deepStrictEqual(run("derived-loggers.ts"), {
      status: 0,
      stdout:
        "derived 500 503 true 1\nproxy 500 503 true 0\nlying 500 503 false 0\n",
      stderr: "",
    });
  });

  test("the records of binden go through the private paths of its loggers, and what getting the logger or a field throws drops the record only: every reply arrives, no crash", () => {
    deepStrictEqual(run("guarded-records.ts"), {
      status: 0,
      stdout:
        "replaced 200 500 503 200 4 true\n" +
        "getter 200 500 503 200 0 false\n" +
        "subclass 200 500 503 200 4 false\n" +
        "id 200 500 503 200 4 false\n" +
        "throwing-child 200 500 503 200 4 true\n" +
        "replaced-binden 200 500 503 200 4 true\n" +
        "replaced-application 200 500 503 200 4 true\n",
      stderr: "",
    });
  });

  test("a logger whose `child()` throws does not crash the process", () => {
    deepStrictEqual(run("throwing-logger.ts"), {
      status: 0,
      stdout: "200 ok true\n",
      stderr: "",
    });
  });
});
