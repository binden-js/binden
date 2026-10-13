/* eslint-disable init-declarations */
import { ok } from "node:assert/strict";
import { type Server, request } from "node:http";
import { afterEach, beforeEach, suite, test } from "node:test";
import { gzipSync } from "node:zlib";
import { Binden, type Context, ct_text } from "binden";

import { BodyParser } from "../index.js";

const port = 8080;

suite("BodyParser (aborted request)", () => {
  let server: Server;
  let started: Promise<void>;
  let settled: Promise<unknown>;

  beforeEach((_t, done) => {
    let start: () => void;
    let settle: (value: unknown) => void;
    started = new Promise<void>((resolve) => {
      start = resolve;
    });
    settled = new Promise<unknown>((resolve) => {
      settle = resolve;
    });

    const parser = new BodyParser();
    const app = new Binden().use(async (ct: Context) => {
      start();
      try {
        await parser.run(ct);
        settle(null);
      } catch (error: unknown) {
        settle(error);
      }
    });

    server = app.createServer().listen(port, done);
  });

  test(
    "settles when a compressed upload is aborted",
    { timeout: 5000 },
    async () => {
      const body = gzipSync("Hello World".repeat(10_000));
      const req = request({
        port,
        method: "POST",
        headers: {
          "Content-Type": ct_text,
          "Content-Encoding": "gzip",
          "Content-Length": body.length,
        },
      });
      req.on("error", () => {
        // The request is aborted on purpose
      });
      req.write(body.subarray(0, body.length / 2));

      await started;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      req.destroy();

      ok((await settled) instanceof Error);
    },
  );

  afterEach((_t, done) => {
    server.closeAllConnections();
    server.close(done);
  });
});
