import { type IServed, converse, dechunk, serve, text } from "./helpers.js";
import { afterEach, suite, test } from "node:test";
import { deepStrictEqual, ok } from "node:assert/strict";
import { Compression } from "../index.js";
import type { Context } from "binden";
import zlib from "node:zlib";

const body = text(2048);

suite("The framing of a compressed body", () => {
  const servers: IServed[] = [];

  /** Serves `body` through a `gzip` compression, after a middleware */
  const start = async (before: (context: Context) => void): Promise<string> => {
    const served = await serve(
      {},
      new Compression({ format: "gzip" }),
      (context: Context) => {
        before(context);
        if (context.url.pathname === "/write") {
          // Without `send()`, which frames the body of binden
          context.done = true;
          context.response.setHeader("Content-Type", "text/plain");
          context.response.end(body);
          return Promise.resolve();
        }
        return context.text(body);
      },
    );
    servers.push(served);
    return served.url;
  };

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (served) => served.close()));
  });

  test("HTTP/1.1: in chunks, the connection kept alive, also after a stale `Transfer-Encoding`", async () => {
    const url = await start((context) => {
      if (context.request.headers["x-stale"] === "te") {
        // E.g. copied from the response of an upstream
        context.response.setHeader("Transfer-Encoding", "chunked");
      } else if (context.request.headers["x-stale"] === "removed") {
        context.response.removeHeader("Transfer-Encoding");
      }
    });
    for (const [path, stale] of [
      ["/", "none"],
      ["/", "te"],
      ["/write", "removed"],
    ]) {
      const responses = await converse(
        url,
        `GET ${path} HTTP/1.1\r\nHost: localhost\r\nAccept-Encoding: gzip\r\nX-Stale: ${stale}\r\n\r\n` +
          `HEAD ${path} HTTP/1.1\r\nHost: localhost\r\nAccept-Encoding: gzip\r\nConnection: close\r\n\r\n`,
      );
      // Both, on one connection
      deepStrictEqual(responses.length, 2, stale);
      for (const { head } of responses) {
        ok(head.startsWith("http/1.1 200 "), stale);
        ok(head.includes("\r\ncontent-encoding: gzip"), stale);
        ok(head.includes("\r\ntransfer-encoding: chunked"), stale);
        ok(!head.includes("content-length"), stale);
      }
      const [get, head] = responses.map((response) => response.body);
      const { body: compressed, complete } = dechunk(get);
      ok(complete, stale);
      deepStrictEqual(zlib.gunzipSync(compressed).toString(), body);
      deepStrictEqual(head.length, 0);
    }
  });

  test("HTTP/1.0: delimited by closing the connection, never in chunks", async () => {
    const url = await start((context) => {
      const stale = context.request.headers["x-stale"];
      if (stale === "te") {
        context.response.setHeader("Transfer-Encoding", "chunked");
      } else if (stale === "keep-alive") {
        context.response.setHeader("Connection", "keep-alive");
      }
    });
    for (const [path, stale] of [
      ["/", "none"],
      ["/write", "te"],
      ["/", "keep-alive"],
    ]) {
      const responses = await converse(
        url,
        `GET ${path} HTTP/1.0\r\nHost: localhost\r\nAccept-Encoding: gzip\r\nConnection: keep-alive\r\nX-Stale: ${stale}\r\n\r\n`,
      );
      deepStrictEqual(responses.length, 1, stale);
      for (const { head, body: raw } of responses) {
        ok(head.includes("\r\ncontent-encoding: gzip"), stale);
        ok(head.includes("\r\nconnection: close"), `${stale}: ${head}`);
        ok(!head.includes("keep-alive"), stale);
        ok(!head.includes("transfer-encoding"), `${stale}: ${head}`);
        ok(!head.includes("content-length"), stale);
        deepStrictEqual(zlib.gunzipSync(raw).toString(), body, stale);
      }
    }
  });
});
