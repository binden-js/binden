// Run by `zstd-frames.test.ts`: 20 concurrent requests of the most costly
// `zstd` bodies within the limits, through a parser of `zstd`:
//   empty     1024 empty frames that each declare a window of 8 MiB (no decoder)
//   windows   256 frames of 1 byte that each declare a window of 8 MiB and their
//             size (the least charge each: 256 decoders)
//   rle       256 frames of an RLE block of 1 byte (256 decoders)
// Prints the statuses of the replies, the CPU time per request (in ms), the
// garbage collections meanwhile, and how much the peak memory of the process
// grows (in MiB).
import { Binden, type Context } from "binden";
import type { AddressInfo } from "node:net";
import { BodyParser } from "../../index.js";
import { PerformanceObserver } from "node:perf_hooks";
import { once } from "node:events";
import { request } from "node:http";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 20_000).unref();

const magic = [0x28, 0xb5, 0x2f, 0xfd];
// A window of 8 MiB (`Exponent` 13), and of 1 KiB
const large = 13 << 3;
const frames: Record<string, [number, number[]]> = {
  // The empty last block (raw, of no byte)
  empty: [1024, [...magic, 0, large, 1, 0, 0]],
  // A `Frame_Content_Size` of 4 bytes (1), then an RLE block of 1 byte
  windows: [256, [...magic, 0x80, large, 1, 0, 0, 0, 0x0b, 0, 0, 0x61]],
  rle: [256, [...magic, 0, 0, 0x0b, 0, 0, 0x61]],
};
const [count, frame] = frames[process.argv[2] ?? ""] ?? [0, []];
const body = Buffer.concat(
  Array.from({ length: count }, () => Buffer.from(frame)),
);

const server = new Binden()
  .use(new BodyParser({ zstd: true, raw: true }), (context: Context) =>
    context.json({ size: (context.request.body as Buffer).length }),
  )
  .createServer();
server.listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address() as AddressInfo;

/** Sends the body: the status of the reply */
function post(): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const client = request(
      {
        port,
        method: "POST",
        agent: false,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Encoding": "zstd",
          "Content-Length": body.length,
        },
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          resolve(response.statusCode);
        });
      },
    );
    client.once("error", reject);
    client.end(body);
  });
}

// Warmed up
await Promise.all([post(), post()]);
let gcs = 0;
const observer = new PerformanceObserver((list) => {
  gcs += list.getEntries().length;
});
observer.observe({ entryTypes: ["gc"] });
const before = process.resourceUsage().maxRSS;
const cpu = process.cpuUsage();
const statuses = await Promise.all(Array.from({ length: 20 }, post));
const { user, system } = process.cpuUsage(cpu);
const growth = Math.round((process.resourceUsage().maxRSS - before) / 1024);
// The entries of the last collections are delivered asynchronously
await new Promise((resolve) => {
  setTimeout(resolve, 20);
});
observer.disconnect();
server.close();
process.stdout.write(
  `${JSON.stringify({
    statuses: [...new Set(statuses)],
    cpu: Math.round((user + system) / 1000 / 20),
    gcs,
    growth,
  })}\n`,
);
