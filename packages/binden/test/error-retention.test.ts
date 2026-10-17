import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { suite, test } from "node:test";
import { formatStack } from "../src/exchange.js";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Runs the fixture of the errors that binden hands over in a process of its
 * own, whose collections the test controls (`--expose-gc`): whether the
 * responses are collected while the sources and the application keep them
 */
function retained(kind: string, mode: string): Record<string, unknown> {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [
      "--expose-gc",
      "--no-warnings",
      "--import",
      "tsx",
      join(import.meta.dirname, "fixtures", "error-retention.ts"),
      kind,
      mode,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  return { status, stdout, stderr };
}

suite("An error that binden creates and hands over", () => {
  for (const [kind, mode, how, kept] of [
    [
      "like",
      "deadline",
      "the reason of the deadline, which a stream-like source keeps",
      "BindenAbortError",
    ],
    [
      "native",
      "deadline",
      "the reason of the deadline, which the send of a Readable rejects with",
      "BindenAbortError",
    ],
    [
      "like",
      "gone",
      "the reason of a client gone away, which a stream-like source keeps",
      "BindenAbortError, Error ERR_STREAM_PREMATURE_CLOSE",
    ],
    [
      "native",
      "gone",
      "the premature close that the send rejects with once the client has gone away",
      "Error ERR_STREAM_PREMATURE_CLOSE",
    ],
    [
      "like",
      "mismatch",
      "the mismatch of a stream-like body shorter than its Content-Length",
      "Error ERR_HTTP_CONTENT_LENGTH_MISMATCH",
    ],
    [
      "native",
      "mismatch",
      "the mismatch of a body shorter than its Content-Length",
      "Error ERR_HTTP_CONTENT_LENGTH_MISMATCH",
    ],
    [
      "native",
      "refused",
      "the refusal of a pipe, which fails its work",
      "TypeError",
    ],
  ] as const) {
    test(`does not keep the response: ${how}`, () => {
      // 60 requests, whose errors are kept
      deepStrictEqual(retained(kind, mode), {
        status: 0,
        stdout: `collected ${kept}\n`,
        stderr: "",
      });
    });
  }

  test("is handed over as it is when a `prepareStackTrace` of the application throws: its stack is left to it", () => {
    const prepare: unknown = Reflect.get(Error, "prepareStackTrace");
    const error = new Error("unformatted");
    Reflect.set(Error, "prepareStackTrace", (): never => {
      throw new Error("prepareStackTrace");
    });
    try {
      strictEqual(formatStack(error), error);
    } finally {
      Reflect.set(Error, "prepareStackTrace", prepare);
    }
    // Formatted once it is read again
    const { stack = "" } = error;
    ok(stack.startsWith("Error: unformatted\n"), stack);
  });
});
