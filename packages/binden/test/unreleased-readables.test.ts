import { suite, test } from "node:test";
import { deepStrictEqual } from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Runs a fixture (`test/fixtures`) in a process of its own, without a handler
 * of the process: a crash (e.g. an unhandled `error` event) is its exit code
 * and output, not a failure of the test runner
 */
function fixture(name: string): Record<string, unknown> {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--import",
      "tsx",
      join(import.meta.dirname, "fixtures", name),
    ],
    { encoding: "utf8", timeout: 40_000 },
  );
  return { status, stdout, stderr };
}

suite("A Node.js `Readable` that refuses every listener of `error`", () => {
  test("is left untouched, never paused nor resumed (a listener of its `pause` or its `resume` that fails it later would crash the process), and that is logged; one paused by its send fails later harmlessly", () => {
    // Sent (its send rejects with the refusal), paused by the application
    // before, released to `HEAD` or for an informational status, or ignored
    // once the response has ended: never paused nor resumed by binden (its
    // send adds no other listener before the one of its `error`), nor
    // destroyed, and nothing of the send is left on it
    const line = (path: string, reply: string, flowing: string): string =>
      `${path} ${reply} pauses=0 resumes=0 flowing=${flowing} destroyed=false listeners=0/0/0/0`;
    deepStrictEqual(fixture("unreleased-readables.ts"), {
      status: 0,
      stdout:
        `${[
          line("/send", "500 rejected:No listener of error (/send)", "null"),
          line(
            "/paused",
            "500 rejected:No listener of error (/paused)",
            "false",
          ),
          line("/head", "200 resolved", "null"),
          line("/ignored", "200 resolved", "null"),
          line(
            "/informational",
            "500 rejected:Status code 103 is informational (use writeEarlyHints())",
            "null",
          ),
        ].join("\n")}\n` +
        // Once per source
        "left=5\n" +
        // Paused by its send only, while the send listens: the listener of
        // the send, which its guard could not replace, logs the error of its
        // pause that comes once the send has been cut, once
        "/listened 200 rejected:The request has been aborted (deadline) pauses=1 destroyed=true listeners=0/0/1/0 late=1\n",
      stderr: "",
    });
  });
});
