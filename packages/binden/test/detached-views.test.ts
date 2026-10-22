import { Binden, type Context } from "../index.js";
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { listen, send, within } from "./helpers.js";
import { suite, test } from "node:test";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** The message of the refusal of a view of a detached `ArrayBuffer` */
const refusal = "TypeError: The data is a view of a detached ArrayBuffer";

/**
 * Runs `fixtures/detached-chunks.ts` in a process of its own, without a
 * handler of the process: a crash is its exit code and output
 */
function chunks(mode: string): Record<string, unknown> {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--import",
      "tsx",
      join(import.meta.dirname, "fixtures", "detached-chunks.ts"),
      mode,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  return { status, stdout, stderr };
}

/**
 * Replies one request by `send()` of `data`, then (once it has rejected) by
 * `200 replied`: the status and the body that the client gets, and what the
 * send has settled with (with whether the headers were sent then)
 */
async function sending(
  data: Uint8Array,
): Promise<[number, string, string, unknown]> {
  const outcome = Promise.withResolvers<string>();
  let committed: unknown = null;
  const app = new Binden().use(async (context: Context) => {
    context.response.setHeader("X-Before", "kept");
    try {
      await context.send(data);
      outcome.resolve("resolved");
    } catch (error: unknown) {
      committed = context.response.headersSent;
      outcome.resolve(
        `${(error as Error).constructor.name}: ${(error as Error).message}`,
      );
      await context.response
        .status(200)
        .send(`replied ${String(context.response.getHeader("X-Before"))}`);
    }
  });
  const listening = await listen(app);
  try {
    const { status, body } = await send(listening.port);
    return [status, body, await within(outcome.promise), committed];
  } finally {
    await listening.close();
  }
}

suite(
  "A view of a detached ArrayBuffer is refused before it is written (R24-1)",
  () => {
    test("given to send(): it rejects with a TypeError of binden before anything is changed, and the work replies", async () => {
      const bytes = new Uint8Array(4);
      bytes.buffer.transfer();
      deepStrictEqual(await sending(bytes), [
        200,
        "replied kept",
        refusal,
        false,
      ]);
    });

    test("of a SharedArrayBuffer, never detached, given to send(): it is sent", async () => {
      const shared = new Uint8Array(new SharedArrayBuffer(2));
      shared.set([0x6f, 0x6b]);
      const [status, body, outcome] = await sending(shared);
      deepStrictEqual([status, body, outcome], [200, "ok", "resolved"]);
    });

    test("the first chunk of a Readable (a Uint8Array or a DataView): the send rejects with a TypeError of binden before the headers are committed, the work replies, and the pipelined request is answered", () => {
      for (const mode of ["first", "view"]) {
        deepStrictEqual(
          chunks(mode),
          {
            status: 0,
            stdout: `${JSON.stringify({
              send: refusal,
              headersSent: false,
              destroyed: true,
              replies: ["HTTP/1.1 500", "HTTP/1.1 200", "second"],
            })}\n`,
            stderr: "",
          },
          mode,
        );
      }
    });

    test("a later chunk of a Readable: the send rejects with a TypeError of binden, and the response is cut, without a crash", () => {
      const { status, stdout, stderr } = chunks("later");
      strictEqual(stderr, "");
      strictEqual(status, 0);
      const { replies, ...outcome } = JSON.parse(String(stdout)) as Record<
        string,
        unknown
      >;
      deepStrictEqual(outcome, {
        send: refusal,
        headersSent: true,
        destroyed: true,
      });
      // Never complete, nor followed by the pipelined response
      strictEqual(Array.isArray(replies) && replies.includes("second"), false);
    });
  },
);

suite(
  "Bytes that application code detaches inside the write of binden (H26-1)",
  () => {
    test("by the toString() of a cookie as the head is committed (a view given to send(), a chunk of a Readable with a Content-Length or chunked, or a view whose resizable ArrayBuffer shrinks): the send rejects with the TypeError of binden, formatted, the connection is closed before the head is flushed, and the pipelined response is never read as the body", () => {
      for (const mode of ["send", "cl", "chunked", "shrink"]) {
        const { status, stdout, stderr } = spawnSync(
          process.execPath,
          [
            "--no-warnings",
            "--import",
            "tsx",
            join(import.meta.dirname, "fixtures", "detaching-writes.ts"),
            mode,
          ],
          { encoding: "utf8", timeout: 30_000 },
        );
        deepStrictEqual(
          { status, stdout, stderr },
          {
            status: 0,
            stdout: `${JSON.stringify({
              formatted: true,
              send: refusal,
              headersSent: true,
              destroyed: true,
              received: "",
            })}\n`,
            stderr: "",
          },
          mode,
        );
      }
    });

    test("by a writer that gives them to binden, then ends the response inside that write, that gives them to binden by end() instead (also of a chunk of a Readable), or that replaces the response with a 406 and drops them without reporting it: the send still rejects with the TypeError of binden, formatted, and the connection is closed, the pipelined response never read as the body (C27-1, H28-1)", () => {
      for (const mode of [
        "ending",
        "end",
        "end-chunks",
        "unreported",
        "unreported-chunks",
      ]) {
        const { status, stdout, stderr } = spawnSync(
          process.execPath,
          [
            "--no-warnings",
            "--import",
            "tsx",
            join(import.meta.dirname, "fixtures", "detaching-writes.ts"),
            mode,
          ],
          { encoding: "utf8", timeout: 30_000 },
        );
        deepStrictEqual({ status, stderr }, { status: 0, stderr: "" }, mode);
        const { received, ...outcome } = JSON.parse(String(stdout)) as Record<
          string,
          unknown
        >;
        deepStrictEqual(
          outcome,
          {
            formatted: true,
            send: refusal,
            headersSent: true,
            destroyed: true,
          },
          mode,
        );
        // The end of the writer may have flushed the head (Node.js uncorks
        // the socket), but never a body, nor the pipelined response
        ok(
          typeof received === "string" &&
            !received.includes("next") &&
            (received === "" || received.endsWith("\r\n\r\n")),
          `${mode} ${String(received)}`,
        );
      }
    });

    test("by the head of a writer that replaces the response inside that write, which drops them, reports it (kDiscardWrite) and calls the write back: no part of the response, the send resolves, and the pipelined request is answered (C27-1)", () => {
      for (const mode of ["replaced", "replaced-chunks"]) {
        const { status, stdout, stderr } = spawnSync(
          process.execPath,
          [
            "--no-warnings",
            "--import",
            "tsx",
            join(import.meta.dirname, "fixtures", "detaching-writes.ts"),
            mode,
          ],
          { encoding: "utf8", timeout: 30_000 },
        );
        deepStrictEqual({ status, stderr }, { status: 0, stderr: "" }, mode);
        const { send: settled, received } = JSON.parse(
          String(stdout),
        ) as Record<string, unknown>;
        strictEqual(settled, "resolved", mode);
        ok(
          typeof received === "string" &&
            /^HTTP\/1\.1 406 [^]*\r\nContent-Length: 0\r\n[^]*\r\n\r\nHTTP\/1\.1 200 [^]*\r\n\r\nnext$/u.test(
              received,
            ),
          `${mode} ${String(received)}`,
        );
      }
    });
  },
);

test("The refusal of send() for a view of a detached ArrayBuffer, kept by the application without its stack read, keeps neither the request nor the response", () => {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [
      "--expose-gc",
      "--no-warnings",
      "--import",
      "tsx",
      join(import.meta.dirname, "fixtures", "created-error-retention.ts"),
      "detached",
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  // 60 requests, whose errors are kept
  deepStrictEqual(
    { status, stdout, stderr },
    { status: 0, stdout: "collected 60 TypeError\n", stderr: "" },
  );
});
