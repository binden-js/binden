import { type IBody, type IReply, send, serve, within } from "./helpers.js";
import { type IncomingMessage, request } from "node:http";
import {
  brotliCompressSync,
  constants,
  createZstdCompress,
  deflateSync,
  gzipSync,
  zstdCompressSync,
} from "node:zlib";
import { ct_json, ct_text } from "binden";
import { deepStrictEqual, ok } from "node:assert/strict";
import { suite, test } from "node:test";
import { BodyParser } from "../index.js";
import { once } from "node:events";

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

/** A `zstd` frame that declares a window of 128 MiB */
async function largeWindow(): Promise<Buffer> {
  const encoder = createZstdCompress({
    params: { [constants.ZSTD_c_windowLog]: 27 },
  });
  encoder.end(hello);
  return Buffer.concat(await encoder.toArray());
}

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

  test("`zstd`", async () => {
    const parser = new BodyParser({ zstd: true });
    const body = zstdCompressSync(hello);
    deepStrictEqual((await post(parser, body, text("zstd"))).body, parsed);
    const both = gzipSync(zstdCompressSync(hello));
    deepStrictEqual(
      (await post(parser, both, text("zstd, gzip"))).body,
      parsed,
    );
    // A window larger than 8 MiB (RFC 9659)
    const large = await largeWindow();
    deepStrictEqual(await post(parser, large, text("zstd")), {
      status: 400,
      connection: "close",
      body: null,
    });
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

  test("data after the end of a coding is a 400", async () => {
    const parser = new BodyParser({ zstd: true });
    const junk = Buffer.from("junk");
    const zeros = Buffer.alloc(16);
    for (const [coding, body] of [
      ["deflate", Buffer.concat([deflateSync(hello), junk])],
      ["deflate", Buffer.concat([deflateSync(hello), deflateSync(hello)])],
      ["br", Buffer.concat([brotliCompressSync(hello), junk])],
      ["gzip", Buffer.concat([gzipSync(hello), junk])],
      // Padding, which the decoder of Node.js would ignore
      ["gzip", Buffer.concat([gzipSync(hello), zeros])],
      ["zstd", Buffer.concat([zstdCompressSync(hello), zeros])],
      // After the end of the first coding to remove
      [
        "deflate, br",
        brotliCompressSync(Buffer.concat([deflateSync(hello), junk])),
      ],
      // After the end of the second one
      [
        "deflate, br",
        Buffer.concat([brotliCompressSync(deflateSync(hello)), junk]),
      ],
    ] as const) {
      deepStrictEqual(
        await post(parser, body, text(coding)),
        { status: 400, connection: "close", body: null },
        coding,
      );
    }
  });

  test("concatenated `gzip` members and `zstd` frames are one body", async () => {
    const parser = new BodyParser({ zstd: true });
    for (const [coding, body] of [
      ["gzip", Buffer.concat([gzipSync(hello), gzipSync(hello)])],
      [
        "zstd",
        Buffer.concat([zstdCompressSync(hello), zstdCompressSync(hello)]),
      ],
    ] as const) {
      deepStrictEqual(
        (await post(parser, body, text(coding))).body,
        { type: "text", value: hello.repeat(2) },
        coding,
      );
    }
  });

  test(
    "the reading stops once a coding has ended, also with `verify_encoded`",
    { timeout: 20_000 },
    async () => {
      for (const coding of ["deflate", "br"]) {
        let verified = false;
        const parser = new BodyParser({
          limit: 1024,
          verify_encoded: true,
          verify: (): void => {
            verified = true;
          },
        });
        const server = await serve(parser);
        // An endless body (until the reply), which the client stops at `cap`
        const cap = 64 * 1024 * 1024;
        const chunk = Buffer.alloc(64 * 1024, 0x20);
        const client = request({
          port: server.port,
          method: "POST",
          agent: false,
          headers: text(coding),
        });
        client.on("error", () => {
          // The server closes the connection after its reply
        });
        let replied = false;
        const response = new Promise<IncomingMessage>((resolve) => {
          client.once("response", (reply: IncomingMessage) => {
            replied = true;
            resolve(reply);
          });
        });
        const writing = (): boolean => !replied;
        try {
          client.write(
            coding === "br" ? brotliCompressSync(hello) : deflateSync(hello),
          );
          let sent = 0;
          while (writing() && sent < cap) {
            sent += chunk.byteLength;
            if (!client.write(chunk)) {
              await Promise.race([once(client, "drain"), response]);
            }
          }
          const reply = await within(response);
          reply.resume();
          deepStrictEqual(
            [reply.statusCode, reply.headers.connection, verified],
            [400, "close", false],
            coding,
          );
          ok(sent < cap, `${sent} bytes sent`);
        } finally {
          client.destroy();
          await server.close();
        }
      }
    },
  );

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
