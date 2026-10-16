import {
  Binden,
  BindenAbortError,
  BindenError,
  type Context,
  ct_text,
} from "binden";
import {
  type IBody,
  type IReply,
  chunked,
  echo,
  listen,
  send,
  serve,
  sleep,
  within,
} from "./helpers.js";
import { type IncomingMessage, request } from "node:http";
import {
  brotliCompressSync,
  constants,
  createZstdCompress,
  deflateSync,
  gzipSync,
  zstdCompressSync,
} from "node:zlib";
import { deepStrictEqual, ok } from "node:assert/strict";
import { suite, test } from "node:test";
import { BodyParser } from "../index.js";
import { once } from "node:events";
import { randomBytes } from "node:crypto";

/** The magic number of a `zstd` frame */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const hello = "Hello World";

/** A block of a crafted frame: raw bytes, or a byte repeated (RLE) */
type IBlock = { raw: string } | { rle: string; count: number };

/** The header of a crafted frame */
interface IHeader {
  /** A single segment (no `Window_Descriptor`), which has its size */
  single?: boolean;
  /** `Dictionary_ID_flag` (the identifier is `0`: no dictionary) */
  dictionary?: number;
  /** `Frame_Content_Size_flag` */
  content?: number;
  /** `Frame_Content_Size` (by default, the size of the content) */
  declared?: bigint;
}

/** The header of a block: its size, its type and whether it is the last one */
function blockHeader(size: number, type: number, last: boolean): Buffer {
  const header = Buffer.alloc(3);
  header.writeUIntLE((size << 3) | (type << 1) | Number(last), 0, 3);
  return header;
}

/** The bytes of a block once decoded */
function contentOf(block: IBlock): string {
  if ("raw" in block) {
    return block.raw;
  }
  return block.rle.repeat(block.count);
}

/**
 * A `zstd` frame of raw and RLE blocks (RFC 8878), with every kind of header:
 * its content is the bytes of its blocks
 */
function frame(
  blocks: readonly IBlock[],
  { single = true, dictionary = 0, content = 0, declared }: IHeader = {},
): Buffer {
  const text = blocks.map(contentOf).join("");
  const size = Number(declared ?? Buffer.byteLength(text));
  const descriptor = (content << 6) | (single ? 0x20 : 0) | dictionary;
  const parts: Buffer[] = [MAGIC, Buffer.from([descriptor])];
  if (!single) {
    // A window of 1 KiB
    parts.push(Buffer.from([0]));
  }
  parts.push(Buffer.alloc(dictionary === 3 ? 4 : dictionary));
  const field = Buffer.alloc(content === 0 ? Number(single) : 1 << content);
  if (field.length === 1) {
    field.writeUInt8(size);
  } else if (field.length === 2) {
    // With an offset of 256
    field.writeUInt16LE(size - 256);
  } else if (field.length === 4) {
    field.writeUInt32LE(size);
  } else if (field.length === 8) {
    field.writeBigUInt64LE(declared ?? BigInt(size));
  }
  parts.push(field);
  blocks.forEach((block, index) => {
    const last = index === blocks.length - 1;
    if ("raw" in block) {
      const bytes = Buffer.from(block.raw);
      parts.push(blockHeader(bytes.length, 0, last), bytes);
    } else {
      parts.push(blockHeader(block.count, 1, last), Buffer.from(block.rle));
    }
  });
  return Buffer.concat(parts);
}

/** A skippable frame (its magic number ends with `nibble`) */
function skippable(nibble: number, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(0x184d2a50 + nibble, 0);
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data]);
}

/** A compressed frame, with a checksum */
function compressed(input: Buffer | string): Buffer {
  return zstdCompressSync(input, {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  });
}

/** The chunks of a body: `size` bytes each (the last one may be shorter) */
function pieces(body: Buffer, size: number): Buffer[] {
  const list: Buffer[] = [];
  for (let offset = 0; offset < body.length; offset += size) {
    list.push(body.subarray(offset, offset + size));
  }
  return list;
}

/** Sends one request through a parser of `zstd` (then `echo`) */
async function post(
  body: IBody,
  coding = "zstd",
  parser = new BodyParser({ zstd: true }),
): Promise<IReply> {
  const server = await serve(parser);
  try {
    return await send(server.url, body, {
      "Content-Type": ct_text,
      "Content-Encoding": coding,
    });
  } finally {
    await server.close();
  }
}

/** A `200` reply of a text */
function parsed(value: string): IReply {
  return {
    status: 200,
    connection: "keep-alive",
    body: { type: "text", value },
  };
}

/** A `zstd` frame that declares a window of 128 MiB */
async function largeWindow(): Promise<Buffer> {
  const encoder = createZstdCompress({
    params: { [constants.ZSTD_c_windowLog]: 27 },
  });
  encoder.end(hello);
  return Buffer.concat(await encoder.toArray());
}

const refused: IReply = { status: 400, connection: "close", body: null };

/** Frames of every kind of header and block, and their content */
const crafted: readonly [Buffer, string][] = [
  [compressed(hello.repeat(20)), hello.repeat(20)],
  [frame([{ raw: "ab" }]), "ab"],
  [
    frame([{ raw: "ab" }, { rle: "c", count: 3 }, { raw: "" }], {
      single: false,
    }),
    "abccc",
  ],
  [frame([{ raw: "x".repeat(300) }], { content: 1 }), "x".repeat(300)],
  [frame([{ raw: "cd" }], { content: 2 }), "cd"],
  [frame([{ raw: "ef" }], { content: 3 }), "ef"],
  [frame([{ raw: "gh" }], { dictionary: 1 }), "gh"],
  [frame([{ raw: "ij" }], { dictionary: 2 }), "ij"],
  [
    frame([{ rle: "k", count: 4 }, { raw: "l" }], {
      single: false,
      dictionary: 3,
      content: 2,
    }),
    "kkkkl",
  ],
  [zstdCompressSync(""), ""],
];

/** Every crafted frame, between skippable frames */
const all = Buffer.concat([
  skippable(0, Buffer.from("abc")),
  ...crafted.slice(0, 4).map(([bytes]) => bytes),
  // An empty skippable frame between two frames
  skippable(15, Buffer.alloc(0)),
  ...crafted.slice(4).map(([bytes]) => bytes),
  skippable(7, Buffer.from("trailer")),
]);
const content = crafted.map(([, text]) => text).join("");

suite("BodyParser (zstd)", () => {
  test("concatenated frames are one body, wherever the chunks end", async () => {
    // In one chunk (each frame is given to a decoder of its own)
    deepStrictEqual(await post(all), parsed(content));
    // Every frame, block and field split, the magic numbers included
    for (const size of [1, 2, 3, 5, 7, 13]) {
      deepStrictEqual(
        await post(chunked(...pieces(all, size))),
        parsed(content),
        `${size} bytes per chunk`,
      );
    }
  });

  test("skippable frames are ignored, an empty frame is an empty body", async () => {
    const only = Buffer.concat([
      skippable(0, Buffer.from("abc")),
      skippable(1, Buffer.alloc(0)),
    ]);
    deepStrictEqual(await post(only), parsed(""));
    deepStrictEqual(await post(zstdCompressSync("")), parsed(""));
    deepStrictEqual(
      await post(Buffer.concat([zstdCompressSync(""), only])),
      parsed(""),
    );
  });

  test("a body without a byte is a 400 for every coding, an empty content is not", async () => {
    const parser = new BodyParser({ zstd: true });
    for (const [coding, empty] of [
      ["zstd", zstdCompressSync("")],
      ["gzip", gzipSync("")],
      ["x-gzip", gzipSync("")],
      ["deflate", deflateSync("")],
      ["br", brotliCompressSync("")],
      ["zstd, gzip", gzipSync(zstdCompressSync(""))],
      ["gzip, zstd", zstdCompressSync(gzipSync(""))],
    ] as const) {
      deepStrictEqual(await post("", coding, parser), refused, coding);
      deepStrictEqual(await post(chunked(), coding, parser), refused, coding);
      deepStrictEqual(await post(empty, coding, parser), parsed(""), coding);
    }
  });

  test("a frame that is truncated or damaged is a 400, also after a valid one", async () => {
    const valid = compressed(hello);
    const next = compressed(hello.repeat(3));
    const corrupt = Buffer.from(next);
    // Its checksum
    corrupt[corrupt.length - 1] ^= 0xff;
    const garbled = Buffer.from(next);
    // Its first block
    garbled.fill(0xff, 9, 13);
    const reserved = Buffer.concat([MAGIC, Buffer.from([0x20, 2])]);
    const large = await largeWindow();
    for (const [name, damaged] of [
      ["part of a magic number", MAGIC.subarray(0, 3)],
      ["a frame header", next.subarray(0, 5)],
      ["a block header", next.subarray(0, 7)],
      ["a block", next.subarray(0, 12)],
      ["a checksum", next.subarray(0, next.length - 1)],
      ["a skippable header", skippable(2, Buffer.alloc(4)).subarray(0, 6)],
      ["a skippable frame", skippable(2, Buffer.alloc(4)).subarray(0, 10)],
      ["data that is not a frame", Buffer.from("junk")],
      ["zero padding", Buffer.alloc(8)],
      ["a reserved block", Buffer.concat([reserved, blockHeader(2, 3, true)])],
      ["a wrong checksum", corrupt],
      ["a window larger than 8 MiB", large],
      ["corrupt data", garbled],
    ] as const) {
      const body = Buffer.concat([valid, damaged]);
      deepStrictEqual(await post(body), refused, `whole: ${name}`);
      deepStrictEqual(
        await post(chunked(...pieces(body, 4))),
        refused,
        `in chunks: ${name}`,
      );
      // As the first frame too
      deepStrictEqual(await post(damaged), refused, `first: ${name}`);
    }
  });

  test("`limit` counts the content of every frame, `encoded_limit` the body", async () => {
    const twice = Buffer.concat([compressed(hello), compressed(hello)]);
    const tooLarge: IReply = { status: 413, connection: "close", body: null };
    // 11 bytes per frame
    deepStrictEqual(
      await post(twice, "zstd", new BodyParser({ zstd: true, limit: 21 })),
      tooLarge,
    );
    deepStrictEqual(
      await post(twice, "zstd", new BodyParser({ zstd: true, limit: 22 })),
      parsed(hello.repeat(2)),
    );
    // Without a `Content-Length`: counted as the body is read
    const encoded_limit = twice.length - 1;
    deepStrictEqual(
      await post(
        chunked(...pieces(twice, 8)),
        "zstd",
        new BodyParser({ zstd: true, encoded_limit }),
      ),
      tooLarge,
    );
  });

  test("`verify` gets the body as received once, and its content", async () => {
    const received: Buffer[] = [];
    const parser = new BodyParser({
      zstd: true,
      verify_encoded: true,
      verify: (decoded: Buffer, _context: Context, { encoded }): void => {
        ok(encoded !== null);
        received.push(encoded, decoded);
      },
    });
    deepStrictEqual(
      await post(chunked(...pieces(all, 9)), "zstd", parser),
      parsed(content),
    );
    deepStrictEqual(received, [all, Buffer.from(content)]);
  });

  test("frames within and around other codings", async () => {
    const parser = new BodyParser({ zstd: true });
    const frames = Buffer.concat([compressed("ab"), compressed("cd")]);
    const gzipped = gzipSync("abcd");
    const half = gzipped.length >> 1;
    for (const [coding, body] of [
      ["zstd, gzip", gzipSync(frames)],
      [
        "gzip, zstd",
        Buffer.concat([
          compressed(gzipped.subarray(0, half)),
          zstdCompressSync(gzipped.subarray(half)),
        ]),
      ],
      [
        "zstd, zstd",
        Buffer.concat([
          zstdCompressSync(frames.subarray(0, 5)),
          zstdCompressSync(frames.subarray(5)),
        ]),
      ],
    ] as const) {
      deepStrictEqual(await post(body, coding, parser), parsed("abcd"), coding);
    }
  });

  test(
    "a large body through two codings, with backpressure",
    { timeout: 20_000 },
    async () => {
      // Incompressible: the frames are about as large as their content
      const data = randomBytes(1 << 20);
      const gzipped = gzipSync(data);
      const third = Math.floor(gzipped.length / 3);
      const body = Buffer.concat([
        zstdCompressSync(gzipped.subarray(0, third)),
        skippable(3, Buffer.alloc(16)),
        zstdCompressSync(gzipped.subarray(third)),
      ]);
      const parser = new BodyParser({ zstd: true, raw: true });
      const server = await listen(
        new Binden().use(parser, (context: Context) =>
          context.json({
            same: data.equals(context.request.body as Buffer),
          }),
        ),
      );
      try {
        const reply = await send(server.url, chunked(...pieces(body, 65_536)), {
          "Content-Type": "application/octet-stream",
          "Content-Encoding": "gzip, zstd",
        });
        deepStrictEqual(reply, {
          status: 200,
          connection: "keep-alive",
          body: { same: true },
        });
      } finally {
        await server.close();
      }
    },
  );

  test("a frame whose content is not of its declared size is a 400, in one write and in chunks", async () => {
    const parser = new BodyParser({ zstd: true });
    // Ended by an empty block, whose end the decoder of Node.js does not
    // check against the declared size when it gets the frame in pieces
    const sized = (text: string, header: IHeader): Buffer =>
      frame([{ raw: text }, { raw: "" }], { single: false, ...header });
    const unsized = frame([{ raw: "xyz" }], { single: false });
    for (const [name, body] of [
      // R3's reproduction (RFC 8878 offsets a size of 2 bytes by 256)
      [
        "declares 300 bytes, has 3",
        sized("abc", { content: 1, declared: 300n }),
      ],
      [
        "declares 256 bytes, has 600",
        sized("a".repeat(600), { content: 1, declared: 256n }),
      ],
      // Sizes that compensate each other: [3, 2] declared, [2, 3] decoded
      [
        "compensating sizes",
        Buffer.concat([
          sized("ab", { content: 2, declared: 3n }),
          sized("cde", { content: 2, declared: 2n }),
        ]),
      ],
      [
        "compensating sizes, the other way",
        Buffer.concat([
          sized("abc", { content: 2, declared: 2n }),
          sized("de", { content: 2, declared: 3n }),
        ]),
      ],
      [
        "after a frame without a size",
        Buffer.concat([unsized, sized("ab", { content: 2, declared: 3n })]),
      ],
      [
        "before a frame without a size",
        Buffer.concat([sized("ab", { content: 2, declared: 3n }), unsized]),
      ],
      // A size of 8 bytes is read whole: its low 4 bytes are 3
      [
        "8 bytes: 2^32 + 3",
        sized("abc", { content: 3, declared: 2n ** 32n + 3n }),
      ],
      [
        "8 bytes: far above any limit",
        sized("abc", { content: 3, declared: 2n ** 64n - 1n }),
      ],
      // Whose window is its declared size
      [
        "8 bytes: a single segment far above any limit",
        frame([{ raw: "abc" }], { content: 3, declared: 2n ** 63n }),
      ],
    ] as const) {
      for (const size of [body.length, 4, 1]) {
        deepStrictEqual(
          await post(chunked(...pieces(body, size)), "zstd", parser),
          refused,
          `${name}: ${size} bytes per chunk`,
        );
      }
      deepStrictEqual(await post(body, "zstd", parser), refused, name);
    }
    for (const [body, text] of [
      [frame([{ raw: "abc" }]), "abc"],
      [sized("x".repeat(300), { content: 1 }), "x".repeat(300)],
      [
        Buffer.concat([
          sized("ab", { content: 2 }),
          unsized,
          sized("cde", { content: 2 }),
        ]),
        "abxyzcde",
      ],
      [sized("abc", { content: 3 }), "abc"],
    ] as const) {
      for (const size of [body.length, 4, 1]) {
        deepStrictEqual(
          await post(chunked(...pieces(body, size)), "zstd", parser),
          parsed(text),
          `${text}: ${size} bytes per chunk`,
        );
      }
    }
  });

  test("the reading of a frame stops at the deadline", async () => {
    const { promise: settled, resolve: settle } =
      Promise.withResolvers<unknown>();
    const parser = new BodyParser({ zstd: true });
    const server = await listen(
      new Binden({ timeout: 100 }).use(async (context: Context) => {
        await parser.run(context).catch((error: unknown) => {
          settle(error);
          throw error;
        });
      }, echo),
    );
    const client = request({
      port: server.port,
      method: "POST",
      agent: false,
      headers: {
        "Content-Type": ct_text,
        "Content-Encoding": "zstd",
        "Content-Length": 1024,
      },
    });
    client.on("error", () => {
      // The server closes the connection after its reply
    });
    try {
      // A frame, and the first bytes of the next one
      client.write(
        Buffer.concat([compressed(hello), compressed(hello).subarray(0, 8)]),
      );
      const [response] = (await within(once(client, "response"))) as [
        IncomingMessage,
      ];
      deepStrictEqual(
        [response.statusCode, response.headers.connection],
        [503, "close"],
      );
      response.resume();
      const error = await within(settled);
      ok(error instanceof BindenAbortError);
      deepStrictEqual(error.reason, "deadline");
    } finally {
      client.destroy();
      await server.close();
    }
  });

  test("a client that goes away within a frame", async () => {
    const { promise: settled, resolve: settle } =
      Promise.withResolvers<unknown>();
    const { promise: started, resolve: start } = Promise.withResolvers<null>();
    const parser = new BodyParser({ zstd: true });
    const server = await listen(
      new Binden().use(async (context: Context) => {
        start(null);
        await parser.run(context).catch((error: unknown) => {
          settle(error);
          throw error;
        });
      }, echo),
    );
    const client = request({
      port: server.port,
      method: "POST",
      agent: false,
      headers: {
        "Content-Type": ct_text,
        "Content-Encoding": "zstd",
        "Content-Length": 1024,
      },
    });
    client.on("error", () => {
      // Closed on purpose
    });
    try {
      client.write(compressed(hello.repeat(50)).subarray(0, 20));
      await within(started);
      // Once the parser has read what has been sent
      await sleep(50);
      client.destroy();
      const error = await within(settled);
      ok(error instanceof BindenError);
      deepStrictEqual([error.status, error.code], [400, "aborted"]);
    } finally {
      await server.close();
    }
  });
});
