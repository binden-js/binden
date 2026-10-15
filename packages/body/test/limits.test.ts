import { type IBody, type IReply, chunked, send, serve } from "./helpers.js";
import {
  type IncomingMessage,
  type OutgoingHttpHeaders,
  request,
} from "node:http";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { deepStrictEqual, ok } from "node:assert/strict";
import { suite, test } from "node:test";
import { BodyParser } from "../index.js";
import { ct_text } from "binden";
import { once } from "node:events";
import { randomBytes } from "node:crypto";

/** Sends one request through the parser (then `echo`) */
async function post(
  parser: BodyParser,
  body: IBody,
  headers: Record<string, string> = {},
): Promise<IReply> {
  const server = await serve(parser);
  try {
    return await send(server.url, body, {
      "Content-Type": ct_text,
      ...headers,
    });
  } finally {
    await server.close();
  }
}

/**
 * Sends the headers of a request and the first chunks of its body (if any),
 * without ending it: the reply that comes before the rest of the body
 */
async function partial(
  parser: BodyParser,
  headers: OutgoingHttpHeaders,
  ...chunks: Buffer[]
): Promise<{ status: number | undefined; connection: unknown }> {
  const server = await serve(parser);
  const req = request({
    port: server.port,
    method: "POST",
    agent: false,
    headers: { "Content-Type": ct_text, ...headers },
  });
  req.on("error", () => {
    // The connection is closed after the reply
  });
  try {
    req.flushHeaders();
    for (const chunk of chunks) {
      req.write(chunk);
    }
    const [response] = (await once(req, "response", {
      signal: AbortSignal.timeout(3000),
    })) as [IncomingMessage];
    response.resume();
    return {
      status: response.statusCode,
      connection: response.headers.connection,
    };
  } finally {
    req.destroy();
    await server.close();
  }
}

/**
 * A gzip member whose header has a comment of `size` bytes: much larger than
 * the data it decodes to
 */
function commented(data: string, size: number): Buffer {
  const member = gzipSync(data);
  const header = Buffer.from(member.subarray(0, 10));
  // FCOMMENT (RFC 1952)
  header.writeUInt8(0x10, 3);
  const comment = Buffer.alloc(size + 1, 0x61);
  comment.writeUInt8(0, size);
  return Buffer.concat([header, comment, member.subarray(10)]);
}

const hello = "Hello World";

const accepted = (value: string): IReply => ({
  status: 200,
  connection: "keep-alive",
  body: { type: "text", value },
});

const refused = { status: 413, connection: "close", body: null };

suite("BodyParser (limits)", () => {
  test("`limit`: the size of the body", async () => {
    const parser = new BodyParser({ limit: 1024 });
    const fits = "a".repeat(1024);
    deepStrictEqual(await post(parser, fits), accepted(fits));
    deepStrictEqual(
      await post(parser, chunked(Buffer.from(fits))),
      accepted(fits),
    );
    // Counted while reading
    deepStrictEqual(
      await post(
        parser,
        chunked(Buffer.alloc(1000, 0x61), Buffer.alloc(25, 0x61)),
      ),
      refused,
    );
    deepStrictEqual(await post(parser, "a".repeat(1025)), refused);

    const none = new BodyParser({ limit: 0 });
    deepStrictEqual(await post(none, ""), accepted(""));
    deepStrictEqual(await post(none, "a"), refused);
  });

  test("no limit by default", async () => {
    const large = "a".repeat(4 * 1024 * 1024);
    for (const parser of [
      new BodyParser(),
      new BodyParser({ limit: Infinity, encoded_limit: Infinity }),
    ]) {
      const { status, body } = await post(parser, gzipSync(large), {
        "Content-Encoding": "gzip",
      });
      deepStrictEqual(status, 200);
      deepStrictEqual((body as { value: string }).value.length, large.length);
    }
  });

  test(
    "a larger `Content-Length` is refused before the body is read",
    { timeout: 10_000 },
    async () => {
      deepStrictEqual(
        await partial(new BodyParser({ limit: 1024 }), {
          "Content-Length": 1025,
        }),
        { status: 413, connection: "close" },
      );
      deepStrictEqual(
        await partial(new BodyParser({ encoded_limit: 1024 }), {
          "Content-Length": 1025,
          "Content-Encoding": "gzip",
        }),
        { status: 413, connection: "close" },
      );
    },
  );

  test("`limit` does not apply to the `Content-Length` of an encoded body", async () => {
    const parser = new BodyParser({ limit: 10 });
    const body = gzipSync("a");
    ok(body.byteLength > 10);
    deepStrictEqual(
      await post(parser, body, { "Content-Encoding": "gzip" }),
      accepted("a"),
    );
  });

  test("`encoded_limit`: the size of the body as received", async () => {
    const parser = new BodyParser({ encoded_limit: 1024 });
    const noise = randomBytes(1024).toString("hex");
    const body = gzipSync(noise);
    ok(body.byteLength > 1024);
    const gzip = { "Content-Encoding": "gzip" };
    deepStrictEqual(await post(parser, body, gzip), refused);
    // Counted while reading
    deepStrictEqual(await post(parser, chunked(body), gzip), refused);
    deepStrictEqual(
      await post(parser, chunked(Buffer.alloc(1025, 0x61))),
      refused,
    );
    deepStrictEqual(
      await post(parser, chunked(Buffer.alloc(1024, 0x61))),
      accepted("a".repeat(1024)),
    );
    // The decoded body may be larger
    const zeros = "0".repeat(64 * 1024);
    deepStrictEqual(
      await post(parser, chunked(gzipSync(zeros)), gzip),
      accepted(zeros),
    );
  });

  test("a small compressed body that decodes to more than `limit`", async () => {
    const parser = new BodyParser({ limit: 1024 });
    const zeros = Buffer.alloc(64 * 1024);
    for (const [coding, body] of [
      ["gzip", gzipSync(zeros)],
      ["br", brotliCompressSync(zeros)],
    ] as const) {
      ok(body.byteLength < 1024);
      deepStrictEqual(
        await post(parser, chunked(body), { "Content-Encoding": coding }),
        refused,
        coding,
      );
    }
  });

  test("`limit` applies to every stage of the decoding", async () => {
    // The outer coding decodes to 1 MiB, the inner one to a few bytes
    const body = gzipSync(commented(hello, 1024 * 1024));
    ok(body.byteLength < 64 * 1024);
    const headers = { "Content-Encoding": "gzip, gzip" };
    deepStrictEqual(
      await post(new BodyParser({ limit: 64 * 1024 }), body, headers),
      refused,
    );
    deepStrictEqual(
      await post(new BodyParser({ limit: 1024 * 1024 + 64 }), body, headers),
      accepted(hello),
    );
  });

  test(
    "the reply of a refusal reaches a client that still sends the body",
    { timeout: 10_000 },
    async () => {
      deepStrictEqual(
        await partial(
          new BodyParser({ limit: 1024 }),
          {},
          Buffer.alloc(4096, 0x61),
        ),
        { status: 413, connection: "close" },
      );
      deepStrictEqual(
        await partial(
          new BodyParser({ limit: 1024 }),
          { "Content-Encoding": "gzip" },
          gzipSync(Buffer.alloc(64 * 1024)),
        ),
        { status: 413, connection: "close" },
      );
    },
  );
});
