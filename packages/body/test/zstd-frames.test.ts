import { Binden, BindenError, type Context, ct_text } from "binden";
import { Duplex, finished } from "node:stream";
import {
  type IZstdBudget,
  ZSTD_DECODER_CHARGE,
  ZSTD_MAX_DECODER_MEMORY,
  ZSTD_MAX_FRAMES,
  ZstdDecoding,
  ZstdFrames,
} from "../src/zstd.js";
import {
  ZstdDecompress,
  constants,
  createZstdDecompress,
  gzipSync,
  zstdCompressSync,
  zstdDecompressSync,
} from "node:zlib";
import { deepStrictEqual, ok } from "node:assert/strict";
import { echo, listen, send, sleep, within } from "./helpers.js";
import { mock, suite, test } from "node:test";
import { BodyParser } from "../index.js";
import fc from "fast-check";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { spawnSync } from "node:child_process";

/** The magic number of a `zstd` frame */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const KiB = 1024;
const MiB = 1024 * KiB;

/** The `Window_Descriptor` of a window of 8 MiB (`Exponent` 13) */
const WINDOW_8_MIB = 13 << 3;

/**
 * A frame of one RLE block of `count` bytes of `a` (128 KiB at most), of a
 * `Window_Descriptor` (1 KiB by default), that declares `declared` bytes of
 * content in 4 bytes, or nothing when `null`
 */
function rle(
  count: number,
  window = 0,
  declared: number | null = null,
): Buffer {
  const size = Buffer.alloc(declared === null ? 0 : 4);
  if (declared !== null) {
    size.writeUInt32LE(declared);
  }
  const block = Buffer.alloc(4);
  block.writeUIntLE((count << 3) | (1 << 1) | 1, 0, 3);
  block.writeUInt8(0x61, 3);
  return Buffer.concat([
    MAGIC,
    Buffer.from([declared === null ? 0 : 0x80, window]),
    size,
    block,
  ]);
}

/** A skippable frame (its magic number ends with `nibble`) */
function skippable(nibble: number, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(0x184d2a50 + nibble, 0);
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data]);
}

/** The `index`th of `count` slices of `data` of about the same size (none empty) */
function slice(data: Buffer, index: number, count: number): Buffer {
  const at = (part: number): number => Math.floor((part * data.length) / count);
  return data.subarray(at(index), at(index + 1));
}

/** `count` frames of `make(index)` */
function frames(count: number, make: (index: number) => Buffer): Buffer {
  return Buffer.concat(
    Array.from({ length: count }, (_, index) => make(index)),
  );
}

/**
 * A frame of a window of 1 KiB of raw blocks of `texts` and an empty last
 * block (whose end the decoder of Node.js does not check against the
 * declared size when it gets the frame in pieces): it declares `declared`
 * bytes of content in 4 bytes (8 when `long`), or nothing when `null`
 */
function sized(
  texts: readonly string[],
  declared: bigint | null,
  long = false,
): Buffer {
  const size = Buffer.alloc(declared === null ? 0 : long ? 8 : 4);
  if (long) {
    size.writeBigUInt64LE(declared ?? 0n);
  } else if (declared !== null) {
    size.writeUInt32LE(Number(declared));
  }
  const blocks = texts.map((text) => {
    const header = Buffer.alloc(3);
    header.writeUIntLE(Buffer.byteLength(text) << 3, 0, 3);
    return Buffer.concat([header, Buffer.from(text)]);
  });
  return Buffer.concat([
    MAGIC,
    Buffer.from([declared === null ? 0 : long ? 0xc0 : 0x80, 0]),
    size,
    ...blocks,
    // The empty last block
    Buffer.from([1, 0, 0]),
  ]);
}

/** Whether an error is the refusal of a frame whose content is not of its declared size */
function missized(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === "The content of a zstd frame is not of its declared size"
  );
}

/** A frame of one byte of content (`a`) */
const one = (): Buffer => zstdCompressSync("a");

/** A frame of an empty content */
const empty = (): Buffer => zstdCompressSync("");

/** Skippable frames of each magic number */
const skipped = (index: number): Buffer =>
  skippable(index % 16, Buffer.alloc(index % 3));

/**
 * An empty frame, a frame of data, an empty frame and a skippable one, in
 * turn: 256 frames of data (of a decoder each) in 1024 frames
 */
function mixed(index: number): Buffer {
  if (index % 4 === 1) {
    return one();
  }
  return index % 4 === 3 ? skipped(index) : empty();
}

/** What the decoders of Node.js have got so far */
interface IFed {
  /** The decoders (one per data frame) */
  decoders: number;
  /** The writes to them (with the writes of `end()`) */
  writes: number;
}

/** Counts the decoders of Node.js and their writes while `run` runs */
async function counting<T>(run: (fed: () => IFed) => Promise<T>): Promise<T> {
  const write = mock.method(Duplex.prototype, "write");
  const end = mock.method(Duplex.prototype, "end");
  try {
    return await run(() => {
      const calls = [...write.mock.calls, ...end.mock.calls].filter(
        (call) => call.this instanceof ZstdDecompress,
      );
      return {
        decoders: new Set(calls.map((call) => call.this)).size,
        writes: calls.length,
      };
    });
  } finally {
    write.mock.restore();
    end.mock.restore();
  }
}

/** What a request gets: its status and `Connection`, the content (or the `code` of the refusal) */
interface IOutcome {
  status: number;
  connection: unknown;
  content: unknown;
}

/** Sends a body of `coding` through a parser of `zstd` (then `echo`) */
async function post(body: Buffer, coding: string): Promise<IOutcome> {
  let code: unknown = null;
  const parser = new BodyParser({ zstd: true });
  const server = await listen(
    new Binden().use(async (context: Context) => {
      await parser.run(context).catch((error: unknown) => {
        code = error instanceof BindenError ? error.code : error;
        throw error;
      });
    }, echo),
  );
  try {
    const reply = await send(server.url, body, {
      "Content-Type": ct_text,
      "Content-Encoding": coding,
    });
    const { value } = (reply.body ?? {}) as { value?: unknown };
    return {
      status: reply.status,
      connection: reply.connection,
      content: reply.status === 200 ? value : code,
    };
  } finally {
    await server.close();
  }
}

/** A body within the limit of frames */
const accepted = (content: string): IOutcome => ({
  status: 200,
  connection: "keep-alive",
  content,
});

/** A body of more frames (or decoders) than the limits */
const refused: IOutcome = {
  status: 413,
  connection: "close",
  content: "zstd_frames",
};

/** What a decoding gets out of chunks (until it fails), and what its decoders of Node.js get */
interface IDecoded extends IFed {
  content: string;
  error: unknown;
}

/** Writes the chunks to a decoding, each once it has taken the previous one */
async function decode(
  chunks: readonly Buffer[],
  budget: IZstdBudget = { frames: 0, memory: 0 },
): Promise<IDecoded> {
  const decoding = new ZstdDecoding(budget);
  const output: Buffer[] = [];
  decoding.on("data", (chunk: Buffer) => output.push(chunk));
  const ended = new Promise((resolve) => {
    finished(decoding, (failure) => {
      resolve(failure ?? null);
    });
  });
  return counting(async (fed) => {
    for (const chunk of chunks) {
      decoding.write(chunk);
    }
    decoding.end();
    const error = await within(ended);
    return {
      content: Buffer.concat(output).toString(),
      error,
      ...fed(),
    };
  });
}

/** Whether an error is the refusal of a frame (or a decoder) beyond the limits */
function beyond(error: unknown): boolean {
  return (
    error instanceof BindenError &&
    error.status === 413 &&
    error.code === "zstd_frames"
  );
}

suite("BodyParser (zstd frames)", () => {
  test("the limits are 1024 frames and 64 MiB of decoders (at least 256 KiB each), whatever the version of Node.js", () => {
    deepStrictEqual(
      [ZSTD_MAX_FRAMES, ZSTD_MAX_DECODER_MEMORY, ZSTD_DECODER_CHARGE],
      [1024, 64 * MiB, 256 * KiB],
    );
  });

  test("a request has at most 1024 frames: data, empty and skippable ones", async () => {
    for (const [name, make, content] of [
      ["empty", empty, ""],
      ["skippable", skipped, ""],
      ["mixed", mixed, "a".repeat(256)],
    ] as const) {
      deepStrictEqual(
        await post(frames(1024, make), "zstd"),
        accepted(content),
        `${name}: 1024`,
      );
      deepStrictEqual(
        await post(frames(1025, make), "zstd"),
        refused,
        `${name}: 1025`,
      );
    }
  });

  test("a request has at most 64 MiB of decoders: 256 of the least charge, 8 of the largest window", async () => {
    // Frames of 1 byte (a single segment: a window of 1 byte)
    deepStrictEqual(
      await post(frames(256, one), "zstd"),
      accepted("a".repeat(256)),
    );
    deepStrictEqual(await post(frames(257, one), "zstd"), refused);
    // One byte of a window of 8 MiB, of no declared size
    const windowed = (): Buffer => rle(1, WINDOW_8_MIB);
    deepStrictEqual(
      await post(frames(8, windowed), "zstd"),
      accepted("a".repeat(8)),
    );
    deepStrictEqual(await post(frames(9, windowed), "zstd"), refused);
    deepStrictEqual(await post(frames(1024, windowed), "zstd"), refused);
    // That declares its size of 1 byte, or of 1 MiB (which it does not have)
    const declaring = (): Buffer => rle(1, WINDOW_8_MIB, 1);
    deepStrictEqual(
      await post(frames(256, declaring), "zstd"),
      accepted("a".repeat(256)),
    );
    deepStrictEqual(await post(frames(257, declaring), "zstd"), refused);
    deepStrictEqual(
      await post(
        frames(65, () => rle(1, WINDOW_8_MIB, MiB)),
        "zstd",
      ),
      refused,
    );
  });

  test("a decoder is charged its window, or its declared size when smaller, and at least 256 KiB", () => {
    /** What the decoder of a frame is charged (its header and its first block are enough) */
    const charge = (frame: Buffer): number => {
      const budget = { frames: 0, memory: 0 };
      new ZstdFrames(budget).scan(frame);
      return budget.memory;
    };
    // A window of 6 MiB: 4 MiB (`Exponent` 12) and 4 eighths of it
    const window6 = (12 << 3) | 4;
    for (const [name, frame, charged] of [
      ["a single segment of 1 byte", one(), 256 * KiB],
      ["a window of 1 KiB", rle(1), 256 * KiB],
      ["a window of 8 MiB", rle(1, WINDOW_8_MIB), 8 * MiB],
      ["a window of 6 MiB", rle(1, window6), 6 * MiB],
      [
        "a window of 8 MiB, 3 MiB declared",
        rle(1, WINDOW_8_MIB, 3 * MiB),
        3 * MiB,
      ],
      ["a window of 6 MiB, 7 MiB declared", rle(1, window6, 7 * MiB), 6 * MiB],
      [
        "a window of 8 MiB, 1 KiB declared",
        rle(1, WINDOW_8_MIB, KiB),
        256 * KiB,
      ],
      [
        "a single segment of 5 MiB",
        Buffer.from([...MAGIC, 0xa0, 0, 0, 0x50, 0, 9, 0, 0, 0x61]),
        5 * MiB,
      ],
      ["an empty frame", empty(), 0],
      ["an empty frame of a window of 8 MiB", rle(0, WINDOW_8_MIB), 0],
      ["a skippable frame", skippable(0, Buffer.alloc(4)), 0],
    ] as const) {
      deepStrictEqual(charge(frame), charged, name);
    }
  });

  test("the 257th decoder of a request never gets a byte", async () => {
    const all = frames(257, one);
    const size = all.length / 257;
    // A frame per chunk
    const each = Array.from({ length: 257 }, (_, index) =>
      all.subarray(index * size, (index + 1) * size),
    );
    const outcome = await decode(each);
    ok(beyond(outcome.error));
    deepStrictEqual(
      [outcome.content, outcome.decoders, outcome.writes],
      ["a".repeat(256), 256, 512],
    );
    // All of them in one chunk
    const over = await decode([all]);
    ok(beyond(over.error));
    deepStrictEqual([over.content, over.decoders, over.writes], ["", 0, 0]);
  });

  test("the decoders of every `zstd` coding of a request count together", async () => {
    // The frames of the inner coding are in the content of the outer one, of
    // a decoder each
    const inner = (count: number): Buffer => frames(count, one);
    const outer = (content: Buffer, count: number): Buffer =>
      frames(count, (index) => zstdCompressSync(slice(content, index, count)));
    deepStrictEqual(
      await post(outer(inner(128), 128), "zstd, zstd"),
      accepted("a".repeat(128)),
    );
    deepStrictEqual(await post(outer(inner(129), 128), "zstd, zstd"), refused);
    deepStrictEqual(await post(outer(inner(128), 129), "zstd, zstd"), refused);
  });

  test("the frames of every `zstd` coding of a request count together", async () => {
    // The frames of the inner coding are in the content of the outer one:
    // one frame of data, then empty ones
    const inner = (count: number): Buffer =>
      Buffer.concat([one(), frames(count - 1, empty)]);
    const outer = (content: Buffer, count: number): Buffer =>
      frames(count, (index) => zstdCompressSync(slice(content, index, count)));
    deepStrictEqual(
      await post(outer(inner(896), 128), "zstd, zstd"),
      accepted("a"),
    );
    deepStrictEqual(await post(outer(inner(897), 128), "zstd, zstd"), refused);
    deepStrictEqual(await post(outer(inner(896), 129), "zstd, zstd"), refused);

    // A coding of another kind has no frames
    const gzipped = gzipSync("gzip");
    const withEmpty = (count: number): Buffer =>
      Buffer.concat([zstdCompressSync(gzipped), frames(count - 1, empty)]);
    deepStrictEqual(
      await post(withEmpty(1024), "gzip, zstd"),
      accepted("gzip"),
    );
    deepStrictEqual(await post(withEmpty(1025), "gzip, zstd"), refused);
    deepStrictEqual(
      await post(gzipSync(inner(1024)), "zstd, gzip"),
      accepted("a"),
    );
    deepStrictEqual(await post(gzipSync(inner(1025)), "zstd, gzip"), refused);
  });

  test(
    "a body of tiny frames costs at most 1024 steps of the decoding, and 256 decoders",
    { timeout: 30_000 },
    async () => {
      const deadline = 5000;
      // 1 MiB of 256 frames is decoded in time
      const data = randomBytes(1024 * 1024);
      const large = frames(256, (index) =>
        zstdCompressSync(data.subarray(index * 4096, (index + 1) * 4096)),
      );
      const parser = new BodyParser({ zstd: true, raw: true });
      const server = await listen(
        new Binden().use(parser, (context: Context) =>
          context.json({ same: data.equals(context.request.body as Buffer) }),
        ),
      );
      try {
        const started = performance.now();
        const reply = await send(server.url, large, {
          "Content-Type": "application/octet-stream",
          "Content-Encoding": "zstd",
        });
        deepStrictEqual(reply.body, { same: true });
        ok(performance.now() - started < deadline);
      } finally {
        await server.close();
      }

      // 1024 frames that each declare a window of 8 MiB (and one raw byte of
      // content, without its size): refused at the 9th decoder
      const windowed = Buffer.from([
        0x28,
        0xb5,
        0x2f,
        0xfd,
        0,
        WINDOW_8_MIB,
        0x09,
        0,
        0,
        0x61,
      ]);
      const before = performance.now();
      deepStrictEqual(
        await post(
          frames(1024, () => windowed),
          "zstd",
        ),
        refused,
      );
      ok(performance.now() - before < deadline);

      // 1 MiB of empty frames (9 bytes each) is refused at once
      const tiny = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0, 1, 0, 0]);
      const body = frames(Math.floor((1024 * 1024) / tiny.length), () => tiny);
      const { promise: settled, resolve: settle } =
        Promise.withResolvers<unknown>();
      const refusing = await listen(
        new Binden().use(async (context: Context) => {
          await parser.run(context).catch((error: unknown) => {
            settle(error);
            throw error;
          });
        }, echo),
      );
      const client = request({
        host: "127.0.0.1",
        port: refusing.port,
        method: "POST",
        agent: false,
        headers: {
          "Content-Type": ct_text,
          "Content-Encoding": "zstd",
          "Content-Length": body.length,
        },
      });
      client.on("error", () => {
        // The server closes the connection after its reply, while the rest of
        // the body is still sent (its status is checked with smaller bodies)
      });
      try {
        const started = performance.now();
        client.write(body);
        ok(beyond(await within(settled, deadline)));
        ok(performance.now() - started < deadline);
      } finally {
        client.destroy();
        await refusing.close();
      }
    },
  );

  test("the most decoders that a request may cost, each of the largest window, take little time and memory", () => {
    for (const [kind, content] of [
      // 256 decoders of 128 KiB each
      ["decoders", 256 * 128 * KiB],
      // 8 decoders of a window of 8 MiB each
      ["windows", 8 * 128 * KiB],
    ] as const) {
      const { status, stdout, stderr } = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          join(import.meta.dirname, "fixtures", "zstd-decoders.ts"),
          kind,
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      deepStrictEqual([status, stderr], [0, ""], kind);
      const { size, ms, growth } = JSON.parse(stdout) as Record<string, number>;
      deepStrictEqual(size, content, kind);
      // One decoder at a time: about 40 ms and 20 MiB (256 decoders), and
      // 20 ms and 50 MiB (8 windows of 8 MiB) on a laptop
      ok(ms < 5000, `${kind}: ${ms} ms`);
      ok(growth < 160, `${kind}: ${growth} MiB`);
    }
  });

  test("1024 frames are decoded, a chunk with the 1025th never reaches a decoder", async () => {
    // The bytes of one frame per chunk: 256 frames of data among them, and
    // the 1025th is empty
    const each = Array.from({ length: 1025 }, (_, index) => mixed(index));
    // A decoder per frame of data, which gets its head, then the rest
    deepStrictEqual(await decode(each.slice(0, 1024)), {
      content: "a".repeat(256),
      error: null,
      decoders: 256,
      writes: 512,
    });
    const outcome = await decode(each);
    ok(beyond(outcome.error));
    deepStrictEqual([outcome.decoders, outcome.writes], [256, 512]);

    // All of them in one chunk
    deepStrictEqual(await decode([Buffer.concat(each.slice(0, 1024))]), {
      content: "a".repeat(256),
      error: null,
      decoders: 256,
      writes: 512,
    });
    const over = await decode([Buffer.concat(each)]);
    ok(beyond(over.error));
    deepStrictEqual([over.decoders, over.writes], [0, 0]);
  });

  test("the frames and the decoders count in the budget of the request", async () => {
    const budget = { frames: 1000, memory: 0 };
    // An empty frame has no decoder
    deepStrictEqual(await decode([empty()], budget), {
      content: "",
      error: null,
      decoders: 0,
      writes: 0,
    });
    deepStrictEqual(budget, { frames: 1001, memory: 0 });
    deepStrictEqual(await decode([one()], budget), {
      content: "a",
      error: null,
      decoders: 1,
      writes: 2,
    });
    deepStrictEqual(budget, { frames: 1002, memory: 256 * KiB });
    const parts = Array.from({ length: 22 }, () => empty());
    deepStrictEqual((await decode(parts, budget)).error, null);
    ok(beyond((await decode([empty()], budget)).error));

    // The decoder that the budget still has
    const memory = { frames: 0, memory: 64 * MiB - 256 * KiB };
    deepStrictEqual((await decode([one()], memory)).content, "a");
    deepStrictEqual(memory, { frames: 1, memory: 64 * MiB });
    const over = await decode([one()], memory);
    ok(beyond(over.error));
    deepStrictEqual([over.decoders, over.writes], [0, 0]);
  });

  test("a frame split over chunks, and a chunk of several frames", async () => {
    const first = zstdCompressSync("first");
    const second = skippable(5, Buffer.from("skipped"));
    const third = zstdCompressSync("third");
    // Every chunk ends within a frame (its magic number too), or at its end
    const split = [
      first.subarray(0, 3),
      first.subarray(3, 4),
      first.subarray(4),
      second.subarray(0, 2),
      second.subarray(2),
      third.subarray(0, 4),
      third.subarray(4, 7),
      third.subarray(7),
    ];
    deepStrictEqual(await decode(split), {
      content: "firstthird",
      error: null,
      decoders: 2,
      // Not the skippable frame: the head of a frame (once its declared size
      // is read), then the rest of each chunk
      writes: 5,
    });
    const several = Buffer.concat([first, second, third]);
    for (let offset = 1; offset < several.length; offset += 1) {
      const halves = [several.subarray(0, offset), several.subarray(offset)];
      const { content, error, decoders } = await decode(halves);
      deepStrictEqual(
        { content, error, decoders },
        { content: "firstthird", error: null, decoders: 2 },
        `split at ${offset}`,
      );
    }
  });

  test("a frame is decoded once the decoder of the previous one has ended, and its decoder gets a piece once it has taken the previous one", async () => {
    // Incompressible: more than the buffers of the decoders
    const data = randomBytes(2 * 1024 * 1024);
    const half = data.length / 2;
    const parts = [
      zstdCompressSync(data.subarray(0, half)),
      zstdCompressSync(data.subarray(half)),
    ];
    const whole = Buffer.concat(parts);
    const quarter = Math.floor(parts[0].length / 2);
    // Before anything reads the content (the magic number and the first
    // frame, or its first half), and once it has been read
    for (const [name, chunks, before, after] of [
      ["one chunk", [whole], 2, 4],
      ["a chunk per frame", parts, 2, 4],
      [
        "halves of a frame",
        [whole.subarray(0, quarter), whole.subarray(quarter)],
        2,
        5,
      ],
    ] as const) {
      const decoding = new ZstdDecoding({ frames: 0, memory: 0 });
      await counting(async (fed) => {
        for (const chunk of chunks) {
          decoding.write(chunk);
        }
        decoding.end();
        await sleep(100);
        deepStrictEqual(fed(), { decoders: 1, writes: before }, name);
        const content = Buffer.concat(await within(decoding.toArray()));
        ok(content.equals(data), name);
        deepStrictEqual(fed(), { decoders: 2, writes: after }, name);
      });
    }
  });

  test("the content of a frame is checked against its declared size once its decoder has ended, before the next frame", async () => {
    // [3, 2] declared, [2, 3] decoded
    const compensating = Buffer.concat([sized(["ab"], 3n), sized(["cde"], 2n)]);
    const outcome = await decode([compensating]);
    ok(missized(outcome.error));
    // The decoder of the next frame never starts
    deepStrictEqual(
      [outcome.content, outcome.decoders, outcome.writes],
      ["ab", 1, 2],
    );
    deepStrictEqual(
      await decode([Buffer.concat([sized(["ab"], 2n), sized(["cde"], 3n)])]),
      { content: "abcde", error: null, decoders: 2, writes: 4 },
    );
  });

  test("a frame that produces more than its declared size fails at once, before more than its size goes on", async () => {
    // Larger than its window (and its blocks): the decoder of Node.js
    // decodes it through a ring buffer, and does not check its size
    const texts = Array.from({ length: 6 }, () => "a".repeat(1000));
    const over = sized(texts, 5000n);
    const whole = await decode([over, one()]);
    ok(missized(whole.error));
    // In one piece, or one byte at a time
    deepStrictEqual([whole.content, whole.decoders], ["", 1]);
    const bytes = await decode([...over].map((byte) => Buffer.from([byte])));
    ok(missized(bytes.error));
    ok(bytes.content.length <= 5000);
    // Unless it does not declare its size
    deepStrictEqual(await decode([sized(texts, null), one()]), {
      content: `${texts.join("")}a`,
      error: null,
      decoders: 2,
      writes: 4,
    });
  });

  test("the declared sizes are checked wherever the chunks end: within a header, within the last block", async () => {
    const unsized = sized(["xyz"], null);
    for (const [name, body, content] of [
      ["compensating sizes", [sized(["ab"], 3n), sized(["cde"], 2n)], null],
      ["before a frame without a size", [sized(["ab"], 3n), unsized], null],
      ["after a frame without a size", [unsized, sized(["ab"], 3n)], null],
      ["8 bytes: 2^32 + 2", [sized(["ab"], 2n ** 32n + 2n, true)], null],
      ["8 bytes: 2^64 - 1", [sized(["ab"], 2n ** 64n - 1n, true)], null],
      [
        "of their sizes",
        [sized(["ab"], 2n), unsized, sized(["c", "d"], 2n)],
        "abxyzcd",
      ],
      ["8 bytes", [sized(["ab"], 2n, true), unsized], "abxyz"],
    ] as const) {
      const all = Buffer.concat(body);
      const splits = [
        // One byte at a time
        Array.from({ length: all.length }, (_, index) =>
          all.subarray(index, index + 1),
        ),
        ...Array.from({ length: all.length - 1 }, (_, index) => [
          all.subarray(0, index + 1),
          all.subarray(index + 1),
        ]),
      ];
      for (const chunks of splits) {
        const outcome = await decode(chunks);
        const where = `${name}: ${chunks.map((chunk) => chunk.length).join(", ")}`;
        if (content === null) {
          ok(missized(outcome.error), where);
        } else {
          deepStrictEqual(
            [outcome.content, outcome.error],
            [content, null],
            where,
          );
        }
      }
    }
  });
});

/** A frame of the given bytes (in hexadecimal) after its magic number */
function hex(bytes: string): Buffer {
  return Buffer.concat([MAGIC, Buffer.from(bytes.replaceAll(" ", ""), "hex")]);
}

/** Decodes a frame whole as Node.js does, with the largest window of the parser */
function decodedByNode(frame: Buffer): Buffer {
  return zstdDecompressSync(frame, {
    params: { [constants.ZSTD_d_windowLogMax]: 23 },
  });
}

/**
 * Empty frames of every kind of header and of empty block, which need no
 * decoder (the low 4 bytes of the XXH64 of no data are `99e9d851`)
 */
const emptyFrames: readonly [string, Buffer][] = [
  ["a window of 8 MiB", hex("00 68 010000")],
  ["a single segment of size 0", hex("20 00 010000")],
  ["a single segment of size 0, a checksum", hex("24 00 010000 99e9d851")],
  ["a size of 0 in 4 bytes", hex("80 68 00000000 010000")],
  [
    "a size of 0 in 8 bytes, a checksum",
    hex("c4 68 0000000000000000 010000 99e9d851"),
  ],
  ["a dictionary ID of 0 in 1 byte", hex("01 68 00 010000")],
  ["a dictionary ID of 0 in 2 bytes", hex("02 68 0000 010000")],
  [
    "a dictionary ID of 0 in 4 bytes, a single segment",
    hex("23 00000000 00 010000"),
  ],
  ["the unused bit", hex("10 68 010000")],
  ["an RLE block of no byte", hex("00 68 030000 61")],
  ["a compressed block of no byte", hex("00 68 050000")],
  [
    "empty blocks of each type, a checksum",
    hex("04 00 000000 020000 61 040000 010000 99e9d851"),
  ],
];

/**
 * Frames without content that a decoder refuses, and the content size that
 * they declare (those that declare one get a decoder)
 */
const refusedFrames: readonly [string, Buffer, bigint | null][] = [
  [
    "a checksum that is not that of an empty content",
    hex("24 00 010000 98e9d851"),
    0n,
  ],
  ["a dictionary ID of 5", hex("01 68 05 010000"), null],
  ["a dictionary ID of 2^24 in 4 bytes", hex("03 68 00000001 010000"), null],
  ["the reserved bit", hex("08 68 010000"), null],
  ["a window of 9 MiB", hex("00 69 010000"), null],
  ["a window of 3.75 TiB", hex("00 ff 010000"), null],
  [
    "a single segment of 8 MiB and 1 byte",
    hex("a0 01008000 010000"),
    8n * 1024n * 1024n + 1n,
  ],
  ["a reserved block of no byte", hex("00 68 070000"), null],
  // Whose window is its content size: none, for the 1 byte of an RLE block
  ["an RLE block in a single segment of size 0", hex("20 00 030000 61"), 0n],
  ["a declared size of 256", hex("40 68 0000 010000"), 256n],
  ["a single segment of size 1", hex("20 01 010000"), 1n],
];

/** One chunk of each byte */
const bytewise = (data: Buffer): Buffer[] =>
  [...data].map((byte) => Buffer.from([byte]));

/**
 * What the decoder of Node.js produces out of a frame that it gets in
 * pieces, as a decoding gives it, with the size check of a decoding: its
 * size, or `null` when it refuses it
 */
async function decodedInPieces(
  frame: Buffer,
  declared: bigint | null,
): Promise<number | null> {
  const decoder = createZstdDecompress({
    params: { [constants.ZSTD_d_windowLogMax]: 23 },
  });
  for (const chunk of bytewise(frame)) {
    decoder.write(chunk);
  }
  decoder.end();
  try {
    const size = Buffer.concat(await within(decoder.toArray())).length;
    return declared === null || BigInt(size) === declared ? size : null;
  } catch {
    return null;
  }
}

/** A frame of a property: its bytes, and the content size that it declares */
interface ICrafted {
  bytes: Buffer;
  declared: bigint | null;
}

/**
 * Frames of any header, of up to 3 blocks without content (or of a byte),
 * among them of the reserved type, and of a checksum of an empty content or
 * of any other
 */
const craftedFrame: fc.Arbitrary<ICrafted> = fc
  .record({
    descriptor: fc.integer({ min: 0, max: 255 }),
    window: fc.constantFrom(0x00, 0x58, 0x68, 0x69, 0xff),
    dictionary: fc.oneof(
      fc.constant(0),
      fc.integer({ min: 0, max: 2 ** 32 - 1 }),
    ),
    size: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 3 })),
    blocks: fc.array(
      fc.constantFrom(
        "000000",
        "020000 61",
        "040000",
        "060000",
        "080000 62",
        "0a0000 63",
      ),
      { minLength: 1, maxLength: 3 },
    ),
    checksum: fc.oneof(
      fc.constant(0x51d8e999),
      fc.integer({ min: 0, max: 2 ** 32 - 1 }),
    ),
  })
  .map(({ descriptor, window, dictionary, size, blocks, checksum }) => {
    const single = (descriptor & 0x20) !== 0;
    const flag = descriptor >>> 6;
    const sizeBytes = flag === 0 ? Number(single) : 1 << flag;
    const dictionaryBytes = [0, 1, 2, 4][descriptor & 0x03] ?? 0;
    const field = (value: number, length: number): Buffer => {
      const bytes = Buffer.alloc(8);
      bytes.writeBigUInt64LE(BigInt(value));
      return bytes.subarray(0, length);
    };
    const last = blocks.map((block, index) => {
      const bytes = Buffer.from(block.replaceAll(" ", ""), "hex");
      bytes[0] |= Number(index === blocks.length - 1);
      return bytes;
    });
    const sum = Buffer.alloc(4);
    sum.writeUInt32LE(checksum);
    return {
      bytes: Buffer.concat([
        MAGIC,
        Buffer.from(single ? [descriptor] : [descriptor, window]),
        field(dictionary, dictionaryBytes),
        field(size, sizeBytes),
        ...last,
        (descriptor & 0x04) === 0 ? Buffer.alloc(0) : sum,
      ]),
      declared:
        sizeBytes === 0 ? null : BigInt(size + (sizeBytes === 2 ? 256 : 0)),
    };
  });

suite("BodyParser (empty zstd frames)", () => {
  test("1024 empty frames of every kind get no decoder, and are an empty body", async () => {
    for (const [name, frame] of emptyFrames) {
      // As Node.js decodes them
      deepStrictEqual(decodedByNode(frame).length, 0, name);
      const all = frames(1024, () => frame);
      const rest = frames(1023, () => frame);
      for (const chunks of [[all], bytewise(frame), [frame, rest]]) {
        deepStrictEqual(
          await decode(chunks),
          { content: "", error: null, decoders: 0, writes: 0 },
          `${name}: ${chunks.length} chunks`,
        );
      }
      deepStrictEqual(await post(all, "zstd"), accepted(""), name);
      deepStrictEqual(
        await post(
          frames(1025, () => frame),
          "zstd",
        ),
        refused,
        name,
      );
    }
  });

  test("an empty frame is refused as its decoder would refuse it, without one", async () => {
    for (const [name, frame, declared] of refusedFrames) {
      // As a decoding gives it to a decoder (and with the check of its size)
      deepStrictEqual(await decodedInPieces(frame, declared), null, name);
      // A frame that declares content (but too large a window) has a decoder
      const decoders = Number(
        declared !== null && declared > 0n && declared <= 8n * 1024n * 1024n,
      );
      for (const chunks of [[frame], bytewise(frame)]) {
        const outcome = await decode(chunks);
        ok(
          outcome.error instanceof Error &&
            !(outcome.error instanceof BindenError),
          name,
        );
        deepStrictEqual(
          [outcome.content, outcome.decoders],
          ["", decoders],
          name,
        );
      }
      deepStrictEqual(
        await post(Buffer.concat([one(), frame]), "zstd"),
        { status: 400, connection: "close", content: null },
        name,
      );
    }
    // Truncated: within its empty blocks, within its checksum
    for (const truncated of [
      hex("00 68 000000"),
      hex("00 68 0100"),
      hex("24 00 010000 99e9"),
    ]) {
      const outcome = await decode([truncated]);
      ok(outcome.error instanceof Error, truncated.toString("hex"));
      deepStrictEqual(outcome.decoders, 0);
    }
  });

  test("the empty blocks before the first block of content are left out of its decoder, which gets a head of 21 bytes at most", async () => {
    // Raw, RLE and compressed empty blocks, then "hello" (and its checksum),
    // of the largest header: a dictionary ID of 0 in 4 bytes, and a size of
    // 0 in 8 bytes (which a frame of content contradicts)
    const empties = "000000 020000 61 040000 ".repeat(1000);
    const hello = hex(`07 00 00000000 ${empties} 290000 68656c6c6f a36d9f88`);
    deepStrictEqual(decodedByNode(hello).toString(), "hello");
    const write = mock.method(ZstdDecompress.prototype, "write");
    try {
      for (const chunks of [[hello], bytewise(hello)]) {
        write.mock.resetCalls();
        const outcome = await decode(chunks);
        deepStrictEqual(
          [outcome.content, outcome.error, outcome.decoders],
          ["hello", null, 1],
        );
        deepStrictEqual(
          write.mock.calls[0]?.arguments[0],
          hex("07 00 00000000 290000"),
        );
      }
      // Which its decoder refuses
      const largest = hex(
        `c3 00 00000000 0000000000000000 ${empties} 290000 68656c6c6f`,
      );
      write.mock.resetCalls();
      ok((await decode([largest])).error instanceof Error);
      const head = write.mock.calls[0]?.arguments[0] as Buffer | undefined;
      deepStrictEqual(head?.length, 21);
    } finally {
      write.mock.restore();
    }
  });

  test("a body of frames without content is decoded as the decoder of Node.js decodes each frame", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(craftedFrame, { minLength: 1, maxLength: 3 }),
        fc.array(fc.integer({ min: 1, max: 9 }), { minLength: 1 }),
        async (crafted, sizes) => {
          // A frame refused by a decoder of its own (also for a content not
          // of its declared size) refuses the body
          const each = await Promise.all(
            crafted.map(({ bytes, declared }) =>
              decodedInPieces(bytes, declared),
            ),
          );
          const expected = each.includes(null)
            ? null
            : "".padEnd(
                each.reduce<number>((a, b) => a + (b ?? 0), 0),
                "?",
              );
          const body = Buffer.concat(crafted.map(({ bytes }) => bytes));
          const chunks: Buffer[] = [];
          for (let at = 0, index = 0; at < body.length; index += 1) {
            const size = sizes[index % sizes.length] ?? 1;
            chunks.push(body.subarray(at, at + size));
            at += size;
          }
          for (const split of [[body], bytewise(body), chunks]) {
            const { content, error } = await decode(split);
            const actual =
              error === null ? content.replaceAll(/[^?]/gu, "?") : null;
            if (actual !== expected) {
              return false;
            }
          }
          return true;
        },
      ),
      // Fixed, so that every run checks the same bodies (`FC_SEED` and
      // `FC_RUNS` check others)
      {
        seed: Number.parseInt(process.env.FC_SEED ?? "20261016", 10),
        numRuns: Number.parseInt(process.env.FC_RUNS ?? "200", 10),
      },
    );
  });

  test("20 concurrent requests of the most costly bodies take little time and memory", () => {
    for (const [kind, cpu] of [
      // 1024 empty frames of a window of 8 MiB each (no decoder)
      ["empty", 20],
      // 256 decoders of a window of 8 MiB each, that declare 1 byte
      ["windows", 150],
      // 256 decoders of an RLE block of 1 byte
      ["rle", 150],
    ] as const) {
      const { status, stdout, stderr } = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          join(import.meta.dirname, "fixtures", "zstd-concurrent.ts"),
          kind,
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      deepStrictEqual([status, stderr], [0, ""], kind);
      const outcome = JSON.parse(stdout) as Record<string, unknown>;
      deepStrictEqual(outcome.statuses, [200], kind);
      // About 3 ms (empty) and 18 ms (decoders) of CPU per request, 3 and 12
      // collections, and 2 and 100 to 220 MiB on a laptop (with a decoder
      // per frame, empty frames took 260 ms and 800 collections)
      ok(Number(outcome.cpu) < cpu, `${kind}: ${String(outcome.cpu)} ms`);
      ok(Number(outcome.gcs) < 200, `${kind}: ${String(outcome.gcs)} GCs`);
      const memory = kind === "empty" ? 64 : 512;
      ok(
        Number(outcome.growth) < memory,
        `${kind}: ${String(outcome.growth)} MiB`,
      );
    }
  });
});
