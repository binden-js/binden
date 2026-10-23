import { BindenAbortError, type Context } from "binden";
import { type IServed, dechunk, exchange, serve } from "./helpers.js";
import { afterEach, suite, test } from "node:test";
import { deepStrictEqual, ok } from "node:assert/strict";
import { Compression } from "../index.js";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import zlib from "node:zlib";

/**
 * Runs `fn` while each `gzip` compressor that `node:zlib` creates counts the
 * compressed bytes that it gives (`produced()`), at its output: before the
 * compression gets them, so before anything could hold back their writes
 */
async function counting(
  fn: (produced: () => number) => Promise<void>,
): Promise<void> {
  let produced = 0;
  const original = Object.getOwnPropertyDescriptor(zlib, "createGzip");
  const create = original?.value as typeof zlib.createGzip;
  Object.defineProperty(zlib, "createGzip", {
    ...original,
    value: (options?: zlib.ZlibOptions): zlib.Gzip =>
      create(options).on("data", (chunk: Buffer) => {
        produced += chunk.length;
      }),
  });
  try {
    await fn(() => produced);
  } finally {
    Object.defineProperty(zlib, "createGzip", original as PropertyDescriptor);
  }
}

suite("A pipe into a compressed response", () => {
  const servers: IServed[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (served) => served.close()));
  });

  test("whose head Node.js refuses fails its work: one `500`, no crash", () => {
    const { status, stdout, stderr } = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(import.meta.dirname, "fixtures", "pipe-failure.ts"),
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    deepStrictEqual(
      { status, stdout, stderr },
      {
        status: 0,
        stdout: "500(open) 500(open)\npipeline:ERR_INVALID_CHAR\n",
        stderr: "",
      },
    );
  });

  test(
    "the deadline cuts a compressed body that has not been sent in full",
    {
      // Windows takes a whole write while its send buffer has room: the
      // response may finish before the client reads it
      skip: process.platform === "win32",
    },
    async () => {
      const body = randomBytes(8 * 1024 * 1024);
      // What the request has been aborted by, and what the compressor had
      // given by then
      const { promise: deadline, resolve } = Promise.withResolvers<{
        readonly reason: unknown;
        readonly produced: number;
      }>();
      await counting(async (produced) => {
        const served = await serve(
          { app: { timeout: 100 } },
          new Compression({ format: "gzip" }),
          async (context: Context) => {
            // The client reads once the request has been aborted (whenever
            // a loaded machine runs it), never by a timer of its own that
            // may come first
            context.signal.addEventListener(
              "abort",
              () => {
                resolve({
                  reason: context.signal.reason,
                  produced: produced(),
                });
              },
              { once: true },
            );
            context.response.type("text/plain");
            // Not awaited: the client reads slowly
            context.response.send(body).catch(() => null);
            await new Promise<void>(() => {
              // Abandoned at its deadline
            });
          },
        );
        servers.push(served);
        const { head, body: raw } = await exchange(served.url, deadline);
        const { reason, produced: given } = await deadline;
        // Cut by the deadline, not by anything else (e.g. a connection
        // closed before the first chunk)
        ok(reason instanceof BindenAbortError, String(reason));
        deepStrictEqual(reason.reason, "deadline");
        if (head === "" && raw.length === 0) {
          // Cut before anything of it was sent: only when the compressor had
          // not given its first chunk by the deadline (e.g. on a loaded
          // machine). The client gets nothing, and the connection is closed.
          deepStrictEqual(given, 0);
          return;
        }
        ok(head.startsWith("HTTP/1.1 200 "), head);
        const { body: compressed, complete } = dechunk(raw);
        ok(!complete);
        ok(
          zlib.gunzipSync(compressed, {
            finishFlush: zlib.constants.Z_SYNC_FLUSH,
          }).length < body.length,
        );
      });
    },
  );
});
