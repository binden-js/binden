import { Binden, BindenError, type Context, ct_text } from "binden";
import { Duplex, finished } from "node:stream";
import {
  type IZstdFrameCount,
  ZSTD_MAX_FRAMES,
  ZstdDecoding,
} from "../src/zstd.js";
import { ZstdDecompress, gzipSync, zstdCompressSync } from "node:zlib";
import { deepStrictEqual, ok } from "node:assert/strict";
import { echo, listen, send, sleep, within } from "./helpers.js";
import { mock, suite, test } from "node:test";
import { BodyParser } from "../index.js";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { spawnSync } from "node:child_process";

/** The magic number of a `zstd` frame */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** A skippable frame (its magic number ends with `nibble`) */
function skippable(nibble: number, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(0x184d2a50 + nibble, 0);
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data]);
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

/** A frame of data, an empty one and a skippable one, in turn */
function mixed(index: number): Buffer {
  if (index % 3 === 0) {
    return one();
  }
  return index % 3 === 1 ? empty() : skipped(index);
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

/** A body of more frames than the limit */
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
  count: IZstdFrameCount = { frames: 0 },
): Promise<IDecoded> {
  const decoding = new ZstdDecoding(count);
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

/** Whether an error is the refusal of a frame beyond the limit */
function beyond(error: unknown): boolean {
  return (
    error instanceof BindenError &&
    error.status === 413 &&
    error.code === "zstd_frames"
  );
}

suite("BodyParser (zstd frames)", () => {
  test("the limit is 1024 frames, whatever the version of Node.js", () => {
    deepStrictEqual(ZSTD_MAX_FRAMES, 1024);
  });

  test("a request has at most 1024 frames: data, empty and skippable ones", async () => {
    for (const [name, make, content] of [
      ["data", one, "a".repeat(1024)],
      ["empty", empty, ""],
      ["skippable", skipped, ""],
      ["mixed", mixed, "a".repeat(342)],
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

  test("the frames of every `zstd` coding of a request count together", async () => {
    // The frames of the inner coding are in the content of the outer one
    const inner = (count: number): Buffer => frames(count, one);
    const outer = (content: Buffer, count: number): Buffer => {
      const size = Math.ceil(content.length / count);
      return frames(count, (index) =>
        zstdCompressSync(content.subarray(index * size, (index + 1) * size)),
      );
    };
    deepStrictEqual(
      await post(outer(inner(512), 512), "zstd, zstd"),
      accepted("a".repeat(512)),
    );
    deepStrictEqual(await post(outer(inner(513), 512), "zstd, zstd"), refused);
    deepStrictEqual(await post(outer(inner(512), 513), "zstd, zstd"), refused);

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
      accepted("a".repeat(1024)),
    );
    deepStrictEqual(await post(gzipSync(inner(1025)), "zstd, gzip"), refused);
  });

  test(
    "a body of tiny frames costs at most 1024 steps of the decoding",
    { timeout: 30_000 },
    async () => {
      const deadline = 5000;
      // 1 MiB of 1024 frames is decoded in time
      const data = randomBytes(1024 * 1024);
      const large = frames(1024, (index) =>
        zstdCompressSync(data.subarray(index * 1024, (index + 1) * 1024)),
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

      // 1024 frames that each declare a window of 8 MiB (and one byte of
      // content, without its size): a decoder for each, in turn
      const windowed = Buffer.from([
        0x28,
        0xb5,
        0x2f,
        0xfd,
        0,
        13 << 3,
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
        accepted("a".repeat(1024)),
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
    const { status, stdout, stderr } = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(import.meta.dirname, "fixtures", "zstd-decoders.ts"),
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    deepStrictEqual([status, stderr], [0, ""]);
    const { size, ms, growth } = JSON.parse(stdout) as Record<string, number>;
    deepStrictEqual(size, 1024 * 128 * 1024);
    // One decoder at a time (1024 windows of 8 MiB would be 8 GiB): about
    // 200 ms and 70 MiB on a laptop
    ok(ms < 5000, `${ms} ms`);
    ok(growth < 160, `${growth} MiB`);
  });

  test("1024 frames are decoded, a chunk with the 1025th never reaches a decoder", async () => {
    const all = frames(1025, one);
    const size = all.length / 1025;
    // The bytes of one frame per chunk
    const each = Array.from({ length: 1025 }, (_, index) =>
      all.subarray(index * size, (index + 1) * size),
    );
    // A decoder per frame, which gets its magic number, then the rest
    deepStrictEqual(await decode(each.slice(0, 1024)), {
      content: "a".repeat(1024),
      error: null,
      decoders: 1024,
      writes: 2048,
    });
    const outcome = await decode(each);
    ok(beyond(outcome.error));
    deepStrictEqual([outcome.decoders, outcome.writes], [1024, 2048]);

    // All of them in one chunk
    deepStrictEqual(await decode([all.subarray(0, 1024 * size)]), {
      content: "a".repeat(1024),
      error: null,
      decoders: 1024,
      writes: 2048,
    });
    const over = await decode([all]);
    ok(beyond(over.error));
    deepStrictEqual([over.decoders, over.writes], [0, 0]);
  });

  test("the frames count in the count of the request", async () => {
    const count = { frames: 1000 };
    deepStrictEqual(await decode([empty()], count), {
      content: "",
      error: null,
      decoders: 1,
      writes: 2,
    });
    deepStrictEqual(count, { frames: 1001 });
    const parts = Array.from({ length: 23 }, () => empty());
    deepStrictEqual((await decode(parts, count)).error, null);
    ok(beyond((await decode([empty()], count)).error));
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
      // Not the skippable frame
      writes: 7,
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
      const decoding = new ZstdDecoding({ frames: 0 });
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
