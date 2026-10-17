import {
  type IRaw,
  type IServed,
  converse,
  decode,
  framed,
  none,
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
        // An HTTP/1.0 client gets no informational response (RFC 9110, 15.2)
        deepStrictEqual(responses.length, version === "1.0" ? 2 : 3, path);
        const [first, ...rest] = responses as [IRaw, ...IRaw[]];
        const early = version === "1.0" ? null : rest[0];
        const second = rest[rest.length - 1];
        ok(first.head.startsWith("http/1.1 200 "), path);
        deepStrictEqual(first.body.toString(), "first", path);
        if (early !== null) {
          deepStrictEqual(
            [early.head, early.body.length],
            [`http/1.1 103 early hints\r\nlink: ${hints.link}`, 0],
            path,
          );
        }
        ok(second.head.startsWith("http/1.1 200 "), path);
        ok(second.head.includes("\r\ncontent-encoding: gzip"), path);
        // Framed exactly (in chunks, or by the close of HTTP/1.0)
        const decoded = zlib.gunzipSync(framed(second));
        ok(decoded.equals(expected.get(path) ?? Buffer.alloc(0)), path);
      }
    });
  }
});

suite(
  "Early hints, then a native write in any encoding, with a compression",
  () => {
    let served: IServed | null = null;

    afterEach(async () => {
      const current = served;
      served = null;
      await current?.close();
    });

    /** A reply that passes `callback` to the methods of Node.js `callbacks` times */
    interface ICase {
      readonly callbacks: number;
      reply(response: Context["response"], callback: () => void): unknown;
    }

    /** Whether Node.js writes an odd hex string to a socket (see below) */
    const oddHex = Number(process.versions.node.split(".")[0]) >= 26;
    // Sent as they are (below the threshold), and compressed
    const sizes = { small: 100, large: 2048 };
    const cases: Record<string, (content: string) => ICase> = {
      "end(string, 'utf-8')": (content) => ({
        callbacks: 0,
        reply: (r): unknown => r.end(content, "utf-8"),
      }),
      "write(base64) + end()": (content) => ({
        callbacks: 0,
        reply: (r): unknown => {
          r.write(Buffer.from(content).toString("base64"), "base64");
          return r.end();
        },
      }),
      "end(odd hex)": (content) => ({
        callbacks: 0,
        reply: (r): unknown =>
          r.end(`${Buffer.from(content).toString("hex")}f`, "hex"),
      }),
      "write(bytes, undefined, callback) + end()": (content) => ({
        callbacks: 1,
        reply: (r, cb): unknown => {
          r.write(Buffer.from(content), none as unknown as BufferEncoding, cb);
          return r.end();
        },
      }),
      "write(bytes, null, callback) + end()": (content) => ({
        callbacks: 1,
        reply: (r, cb): unknown => {
          r.write(Buffer.from(content), null as unknown as BufferEncoding, cb);
          return r.end();
        },
      }),
      "end(bytes, undefined, callback)": (content) => ({
        callbacks: 1,
        reply: (r, cb): unknown =>
          r.end(Buffer.from(content), none as unknown as BufferEncoding, cb),
      }),
    };

    test("the hints come first, and the body is exact (callbacks once)", async () => {
      let replied = gate();
      const calls = new Map<string, number>();
      served = await serve(
        {},
        new Compression({ format: "gzip" }),
        async (context: Context) => {
          const { pathname } = context.url;
          if (pathname === "/first") {
            await replied.promise;
            await sleep(20);
            await context.send("first");
            return;
          }
          const [, size = "", name = ""] =
            decodeURIComponent(pathname).split("/");
          const reply = cases[name](text(sizes[size as keyof typeof sizes]));
          context.response
            .setHeader("Content-Type", "text/plain")
            .writeEarlyHints(hints);
          reply.reply(context.response, () => {
            const key = `${size}/${name}`;
            calls.set(key, (calls.get(key) ?? 0) + 1);
          });
          replied.open();
          await sleep(50);
        },
      );
      for (const [size, length] of Object.entries(sizes)) {
        // Node.js 24 aborts the process when it writes an odd hex string to
        // a socket (also without binden); a compressor decodes it
        const tested = Object.entries(cases).filter(
          ([name]) => oddHex || size === "large" || name !== "end(odd hex)",
        );
        for (const [name, make] of tested) {
          replied = gate();
          const key = `${size}/${name}`;
          const responses = await converse(
            served.url,
            `GET /first HTTP/1.1\r\nHost: a\r\n\r\n` +
              `GET /${size}/${encodeURIComponent(name)} HTTP/1.1\r\nHost: a\r\nAccept-Encoding: gzip\r\nConnection: close\r\n\r\n`,
          );
          deepStrictEqual(responses.length, 3, key);
          const [first, early, second] = responses as [IRaw, IRaw, IRaw];
          deepStrictEqual(first.body.toString(), "first", key);
          deepStrictEqual(
            [early.head, early.body.length],
            [`http/1.1 103 early hints\r\nlink: ${hints.link}`, 0],
            key,
          );
          ok(second.head.startsWith("http/1.1 200 "), key);
          // The bodies of an unknown length are compressed, as the large ones
          deepStrictEqual(
            second.head.includes("\r\ncontent-encoding: gzip"),
            size === "large" || name.startsWith("write("),
            key,
          );
          const coding = /\r\ncontent-encoding: (?<coding>\w+)/u.exec(
            second.head,
          )?.groups?.coding;
          deepStrictEqual(
            decode(coding, framed(second)).toString(),
            text(length),
            key,
          );
          // Once flushed
          await sleep(20);
          deepStrictEqual(calls.get(key) ?? 0, make("").callbacks, key);
        }
      }
    });
  },
);
