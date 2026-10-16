import { type IServed, dechunk, exchange, serve } from "./helpers.js";
import { afterEach, suite, test } from "node:test";
import { Compression } from "../index.js";
import type { Context } from "binden";
import { ok } from "node:assert/strict";
import { randomBytes } from "node:crypto";
import zlib from "node:zlib";

suite("A pipe into a compressed response", () => {
  const servers: IServed[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (served) => served.close()));
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
      const served = await serve(
        { app: { timeout: 100 } },
        new Compression({ format: "gzip" }),
        async (context: Context) => {
          context.response.type("text/plain");
          // Not awaited: the client reads slowly
          context.response.send(body).catch(() => null);
          await new Promise<void>(() => {
            // Abandoned at its deadline
          });
        },
      );
      servers.push(served);
      const { head, body: raw } = await exchange(served.url, 400);
      ok(head.startsWith("HTTP/1.1 200 "), head);
      const { body: compressed, complete } = dechunk(raw);
      ok(!complete);
      ok(
        zlib.gunzipSync(compressed, {
          finishFlush: zlib.constants.Z_SYNC_FLUSH,
        }).length < body.length,
      );
    },
  );
});
