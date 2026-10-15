import {
  type IServed,
  converse,
  framed,
  serve,
  sleep,
  text,
} from "./helpers.js";
import { afterEach, suite, test } from "node:test";
import { deepStrictEqual, ok } from "node:assert/strict";
import { Compression } from "../index.js";
import type { Context } from "binden";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import zlib from "node:zlib";

const hints = { link: "</style.css>; rel=preload; as=style" };
const body = Buffer.from(text(2048));

/** A promise with its `resolve()` */
function gate(): { promise: Promise<void>; open(): void } {
  const { promise, resolve } = Promise.withResolvers<never>();
  return { promise, open: resolve as () => void };
}

/** The compressed replies of bytes, by path: their body */
const replies: Partial<
  Record<string, (context: Context) => Promise<Buffer> | Buffer>
> = {
  "/send": async (context) => {
    await context.send(body);
    return body;
  },
  "/text": async (context) => {
    await context.text(body.toString());
    return body;
  },
  "/write-head": ({ response }) => {
    // Its head is committed before the body: Node.js queues it after the 103
    response.writeHead(200, { "Content-Type": "text/plain" }).end(body);
    return body;
  },
  "/write": ({ response }) => {
    response.setHeader("Content-Type", "text/plain");
    response.write(new Uint8Array(body));
    response.end();
    return body;
  },
  "/stream": async (context) => {
    await context.response
      .type("text/plain")
      .send(Readable.from([body.subarray(0, 1024), body.subarray(1024)]));
    return body;
  },
  "/file": async (context) => {
    await context.response.sendFile(import.meta.filename, {
      content_type: "text/plain",
    });
    return readFileSync(import.meta.filename);
  },
};

suite("Early hints of a pipelined request with a compressed reply", () => {
  let served: IServed | null = null;
  // The first request replies once the second has replied: the response of
  // the second (with its `103 Early Hints`) is queued until then
  const replied = { current: gate() };
  const expected = new Map<string, Buffer>();

  afterEach(async () => {
    const current = served;
    served = null;
    await current?.close();
  });

  const start = async (): Promise<string> => {
    served = await serve(
      {},
      new Compression({ format: "gzip" }),
      async (context: Context) => {
        const { pathname } = context.url;
        if (pathname === "/first") {
          await replied.current.promise;
          await sleep(20);
          await context.send("first");
          return;
        }
        context.response.writeEarlyHints(hints);
        const reply = replies[pathname]?.(context);
        replied.current.open();
        expected.set(pathname, await (reply as Promise<Buffer>));
      },
    );
    return served.url;
  };

  for (const version of ["1.1", "1.0"]) {
    test(`are sent before the response, never inside its body (HTTP/${version})`, async () => {
      const url = await start();
      for (const path of Object.keys(replies)) {
        replied.current = gate();
        const keep = version === "1.0" ? "Connection: keep-alive\r\n" : "";
        const responses = await converse(
          url,
          `GET /first HTTP/${version}\r\nHost: a\r\n${keep}\r\n` +
            `GET ${path} HTTP/${version}\r\nHost: a\r\nAccept-Encoding: gzip\r\nConnection: close\r\n\r\n`,
        );
        const [first, early, second] = responses;
        deepStrictEqual(responses.length, 3, path);
        ok(first.head.startsWith("http/1.1 200 "), path);
        deepStrictEqual(first.body.toString(), "first", path);
        deepStrictEqual(
          [early.head, early.body.length],
          [`http/1.1 103 early hints\r\nlink: ${hints.link}`, 0],
          path,
        );
        ok(second.head.startsWith("http/1.1 200 "), path);
        ok(second.head.includes("\r\ncontent-encoding: gzip"), path);
        // Framed exactly (in chunks, or by the close of HTTP/1.0)
        const decoded = zlib.gunzipSync(framed(second));
        ok(decoded.equals(expected.get(path) ?? Buffer.alloc(0)), path);
      }
    });
  }
});
