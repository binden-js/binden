import { Binden, BindenError, type Context, ct_text } from "binden";
import { Duplex, finished } from "node:stream";
import {
  type IZstdFrameCount,
  ZSTD_MAX_FRAMES,
  ZstdDecoding,
  concatenated,
} from "../src/zstd.js";
import {
  ZstdDecompress,
  createZstdDecompress,
  gzipSync,
  zstdCompressSync,
} from "node:zlib";
import { deepStrictEqual, ok } from "node:assert/strict";
import { echo, listen, send, sleep, within } from "./helpers.js";
import { mock, suite, test } from "node:test";
import { BodyParser } from "../index.js";
import { randomBytes } from "node:crypto";
import { request } from "node:http";

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

/**
 * Counts the writes to the decoders of Node.js (the decoding of the parser
 * gives its decoder one piece per write) while `run` runs
 */
async function counting<T>(
  run: (writes: () => number) => Promise<T>,
): Promise<T> {
  const write = mock.method(Duplex.prototype, "write");
  try {
    return await run(
      () =>
        write.mock.calls.filter((call) => call.this instanceof ZstdDecompress)
          .length,
    );
  } finally {
    write.mock.restore();
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

/** What a decoding gets out of chunks (until it fails), and what its decoder of Node.js gets */
interface IDecoded {
  content: string;
  error: unknown;
  /** The writes to the decoder of Node.js */
  writes: number;
}

/** Writes the chunks to a decoding (`whole` or not), each once it has taken the previous one */
async function decode(
  chunks: readonly Buffer[],
  whole: boolean,
  count: IZstdFrameCount = { frames: 0 },
): Promise<IDecoded> {
  const decoding = new ZstdDecoding(count, whole);
  const output: Buffer[] = [];
  decoding.on("data", (chunk: Buffer) => output.push(chunk));
  const ended = new Promise((resolve) => {
    finished(decoding, (failure) => {
      resolve(failure ?? null);
    });
  });
  return counting(async (writes) => {
    for (const chunk of chunks) {
      decoding.write(chunk);
    }
    decoding.end();
    const error = await within(ended);
    return {
      content: Buffer.concat(output).toString(),
      error,
      writes: writes(),
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

  test("whether the decoder of Node.js decodes concatenated frames is found once", async () => {
    const decoder = createZstdDecompress();
    decoder.end(
      Buffer.concat([zstdCompressSync("ab"), zstdCompressSync("cd")]),
    );
    const content = Buffer.concat(await decoder.toArray()).toString();
    deepStrictEqual(concatenated, content === "abcd");
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

  for (const whole of [false, true]) {
    suite(whole ? "whole chunks" : "one frame at a time", () => {
      test("1024 frames are decoded, a chunk with the 1025th never reaches the decoder", async () => {
        const all = frames(1025, one);
        const size = all.length / 1025;
        // The bytes of one frame per chunk, with any decoder
        const each = Array.from({ length: 1025 }, (_, index) =>
          all.subarray(index * size, (index + 1) * size),
        );
        deepStrictEqual(await decode(each.slice(0, 1024), whole), {
          content: "a".repeat(1024),
          error: null,
          writes: 1024,
        });
        const outcome = await decode(each, whole);
        ok(beyond(outcome.error));
        deepStrictEqual(outcome.writes, 1024);

        // All of them in one chunk (which the decoder of Node.js 24 cannot
        // decode whole: the parser never gives it one)
        const inside = await decode([all.subarray(0, 1024 * size)], whole);
        deepStrictEqual(inside.writes, whole ? 1 : 1024);
        if (!whole || concatenated) {
          deepStrictEqual(inside.content, "a".repeat(1024));
        }
        const over = await decode([all], whole);
        ok(beyond(over.error));
        deepStrictEqual(over.writes, 0);
      });

      test("the frames count in the count of the request", async () => {
        const count = { frames: 1000 };
        deepStrictEqual(await decode([empty()], whole, count), {
          content: "",
          error: null,
          writes: 1,
        });
        deepStrictEqual(count, { frames: 1001 });
        const parts = Array.from({ length: 23 }, () => empty());
        deepStrictEqual((await decode(parts, whole, count)).error, null);
        ok(beyond((await decode([empty()], whole, count)).error));
      });

      test("a frame split over chunks, and a chunk of several frames", async () => {
        const first = zstdCompressSync("first");
        const second = skippable(5, Buffer.from("skipped"));
        const third = zstdCompressSync("third");
        // Every chunk ends within a frame, or at its end
        const split = [
          first.subarray(0, 3),
          first.subarray(3),
          second,
          third.subarray(0, 7),
          third.subarray(7),
        ];
        deepStrictEqual((await decode(split, whole)).content, "firstthird");
        if (!whole || concatenated) {
          const several = Buffer.concat([first, second, third]);
          const halves = [several.subarray(0, 20), several.subarray(20)];
          deepStrictEqual((await decode(halves, whole)).content, "firstthird");
        }
      });

      test("the decoder gets a piece once it has taken the previous one", async () => {
        // Incompressible: more than the buffers of the decoder
        const data = randomBytes(2 * 1024 * 1024);
        const half = data.length / 2;
        const parts = [
          zstdCompressSync(data.subarray(0, half)),
          zstdCompressSync(data.subarray(half)),
        ];
        const decoding = new ZstdDecoding({ frames: 0 }, whole);
        await counting(async (writes) => {
          // In one chunk, or one chunk per frame
          for (const chunk of whole ? parts : [Buffer.concat(parts)]) {
            decoding.write(chunk);
          }
          decoding.end();
          // Nothing reads the content yet
          await sleep(100);
          deepStrictEqual(writes(), 1);
          const content = Buffer.concat(await within(decoding.toArray()));
          ok(content.equals(data));
          deepStrictEqual(writes(), 2);
        });
      });
    });
  }
});
