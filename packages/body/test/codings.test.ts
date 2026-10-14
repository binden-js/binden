import { deepStrictEqual, ok } from "node:assert/strict";
import { suite, test } from "node:test";
import {
  brotliCompressSync,
  deflateSync,
  gzipSync,
  zstdCompressSync,
} from "node:zlib";
import { ct_json, ct_text } from "binden";

import { BodyParser } from "../index.js";
import { type IBody, type IReply, send, serve } from "./helpers.js";

/** Sends one request through the parser (then `echo`) */
async function post(
  parser: BodyParser,
  body: IBody,
  headers: Record<string, string>,
): Promise<IReply> {
  const server = await serve(parser);
  try {
    return await send(server.url, body, headers);
  } finally {
    await server.close();
  }
}

/** The headers of a text body with content codings */
function text(coding: string): Record<string, string> {
  return { "Content-Type": ct_text, "Content-Encoding": coding };
}

const hello = "Hello World";
const parsed = { type: "text", value: hello };

suite("BodyParser (content codings)", () => {
  test("gzip, x-gzip, deflate and br", async () => {
    const parser = new BodyParser();
    const bodies: [string, Buffer][] = [
      ["gzip", gzipSync(hello)],
      ["x-gzip", gzipSync(hello)],
      ["GZIP", gzipSync(hello)],
      ["deflate", deflateSync(hello)],
      ["br", brotliCompressSync(hello)],
      // Empty list elements are ignored
      [" , br", brotliCompressSync(hello)],
    ];
    for (const [coding, body] of bodies) {
      deepStrictEqual(await post(parser, body, text(coding)), {
        status: 200,
        connection: "keep-alive",
        body: parsed,
      });
    }
  });

  test("two codings, removed in the reverse order", async () => {
    const parser = new BodyParser();
    const body = brotliCompressSync(gzipSync(hello));
    deepStrictEqual((await post(parser, body, text("gzip, br"))).body, parsed);
    const other = gzipSync(deflateSync(hello));
    deepStrictEqual(
      (await post(parser, other, text("deflate, gzip"))).body,
      parsed,
    );
  });

  test("more than two codings are a 415", async () => {
    const parser = new BodyParser();
    const body = gzipSync(gzipSync(gzipSync(hello)));
    deepStrictEqual(await post(parser, body, text("gzip, gzip, gzip")), {
      status: 415,
      connection: "close",
      body: null,
    });
  });

  test("unknown and unsupported codings are a 415", async () => {
    const parser = new BodyParser();
    for (const coding of ["foo", "gzip, foo", "identity", "compress", "zstd"]) {
      const body = coding === "zstd" ? zstdCompressSync(hello) : hello;
      deepStrictEqual(
        await post(parser, body, text(coding)),
        { status: 415, connection: "close", body: null },
        coding,
      );
    }
  });

  test("corrupt data is a 400", async () => {
    const parser = new BodyParser();
    const truncated = gzipSync(hello).subarray(0, 12);
    for (const [coding, body] of [
      ["br", Buffer.from(hello)],
      ["gzip", truncated],
      ["deflate", Buffer.from(hello)],
    ] as const) {
      deepStrictEqual(
        (await post(parser, body, text(coding))).status,
        400,
        coding,
      );
    }
  });

  test("the codings of a body that is not selected are not checked", async () => {
    const parser = new BodyParser();
    deepStrictEqual(
      (
        await post(parser, hello, {
          "Content-Type": "application/x-unknown",
          "Content-Encoding": "foo, bar, baz",
        })
      ).body,
      { type: "undefined" },
    );
  });

  test("JSON with codings", async () => {
    const parser = new BodyParser();
    const body = brotliCompressSync(deflateSync('{"a":1}'));
    ok(body.byteLength > 0);
    deepStrictEqual(
      (
        await post(parser, body, {
          "Content-Type": ct_json,
          "Content-Encoding": "deflate, br",
        })
      ).body,
      { type: "json", value: { a: 1 } },
    );
  });
});
