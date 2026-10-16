// Run by `zstd-frames.test.ts`: the most decoders that a request may cost,
// 1024 frames that each declare the largest window (8 MiB) and no content
// size, and decode an RLE block of 128 KiB, each by a decoder of its own.
// Prints the size of the content, the time that it takes and how much the
// peak memory of the process grows (in MiB).
import { ZSTD_MAX_FRAMES, ZstdDecoding } from "../../src/zstd.js";
import { once } from "node:events";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 20_000).unref();

const block = Buffer.alloc(4);
// The last block, of type RLE: 128 KiB of `a`
block.writeUIntLE(((128 * 1024) << 3) | (1 << 1) | 1, 0, 3);
block.writeUInt8(0x61, 3);
// A window of 8 MiB (`Exponent` 13)
const frame = Buffer.concat([
  Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 13 << 3]),
  block,
]);
const body = Buffer.concat(
  Array.from({ length: ZSTD_MAX_FRAMES }, () => frame),
);

const before = process.resourceUsage().maxRSS;
const started = performance.now();
const decoding = new ZstdDecoding({ frames: 0 });
let size = 0;
decoding.on("data", (chunk: Buffer) => {
  size += chunk.byteLength;
});
decoding.end(body);
await once(decoding, "end");
const ms = Math.round(performance.now() - started);
const growth = Math.round((process.resourceUsage().maxRSS - before) / 1024);
process.stdout.write(`${JSON.stringify({ size, ms, growth })}\n`);
