// Run by `zstd-frames.test.ts`: the most decoders that a request may cost
// (`ZSTD_MAX_DECODER_MEMORY`), each by a decoder of its own, of frames that
// each declare the largest window (8 MiB) and decode an RLE block of 128 KiB:
// `decoders` is 256 frames that declare their size (the least charge each),
// `windows` 8 frames that declare none (the charge of their window each).
// Prints the size of the content, the time that it takes and how much the
// peak memory of the process grows (in MiB).
import {
  ZSTD_DECODER_CHARGE,
  ZSTD_MAX_DECODER_MEMORY,
  ZstdDecoding,
} from "../../src/zstd.js";
import { once } from "node:events";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 20_000).unref();

const declared = process.argv[2] === "decoders";
const size = 128 * 1024;
const block = Buffer.alloc(4);
// The last block, of type RLE: 128 KiB of `a`
block.writeUIntLE((size << 3) | (1 << 1) | 1, 0, 3);
block.writeUInt8(0x61, 3);
// A window of 8 MiB (`Exponent` 13), and a `Frame_Content_Size` of 4 bytes
const fcs = Buffer.alloc(declared ? 4 : 0);
if (declared) {
  fcs.writeUInt32LE(size);
}
const frame = Buffer.concat([
  Buffer.from([0x28, 0xb5, 0x2f, 0xfd, declared ? 0x80 : 0, 13 << 3]),
  fcs,
  block,
]);
const count =
  ZSTD_MAX_DECODER_MEMORY / (declared ? ZSTD_DECODER_CHARGE : 8 * 1024 * 1024);
const body = Buffer.concat(Array.from({ length: count }, () => frame));

const before = process.resourceUsage().maxRSS;
const started = performance.now();
const decoding = new ZstdDecoding({ frames: 0, memory: 0 });
let decoded = 0;
decoding.on("data", (chunk: Buffer) => {
  decoded += chunk.byteLength;
});
decoding.end(body);
await once(decoding, "end");
const ms = Math.round(performance.now() - started);
const growth = Math.round((process.resourceUsage().maxRSS - before) / 1024);
process.stdout.write(`${JSON.stringify({ size: decoded, ms, growth })}\n`);
