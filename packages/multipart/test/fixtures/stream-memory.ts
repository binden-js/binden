// Run by `process.test.ts` (with `--expose-gc`): the memory of the stream
// storage stays bounded, whatever the size of the files it streams
import { Binden, type Context } from "binden";
import { type IncomingMessage, request } from "node:http";
import multipart, { type IMultipartOptions } from "../../index.js";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 25_000).unref();

const MiB = 1 << 20;
/** The size of the file: much more than the growth of the memory allowed */
const size = 128 * MiB;
const chunk = Buffer.alloc(64 * 1024, "a");
const boundary = "binden-boundary";

let received = 0;
const storage: IMultipartOptions["storage"] =
  process.argv[2] === "memory"
    ? "memory"
    : {
        on_file: async ({ stream }): Promise<void> => {
          for await (const data of stream) {
            received += (data as Buffer).length;
          }
        },
      };
const app = new Binden()
  .use(multipart({ storage }))
  .use((context: Context) => context.send());
const server = app.createServer().listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address() as AddressInfo;

function* upload(): Generator<Buffer | string> {
  yield `--${boundary}\r\nContent-Disposition: form-data; name="f"; filename="f.bin"\r\n\r\n`;
  for (let sent = 0; sent < size; sent += chunk.length) {
    yield chunk;
  }
  yield `\r\n--${boundary}--\r\n`;
}

globalThis.gc?.();
const baseline = process.memoryUsage().rss;
let peak = baseline;
// The garbage is collected first: only what is kept counts
const sampler = setInterval(() => {
  globalThis.gc?.();
  peak = Math.max(peak, process.memoryUsage().rss);
}, 20);

const client = request({
  agent: false,
  method: "POST",
  host: "127.0.0.1",
  port,
  headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
});
const responded = once(client, "response") as Promise<[IncomingMessage]>;
await pipeline(Readable.from(upload()), client);
const [response] = await responded;
response.resume();
await once(response, "end");
clearInterval(sampler);
peak = Math.max(peak, process.memoryUsage().rss);
server.close();

const growth = Math.round((peak - baseline) / MiB);
process.stdout.write(
  `${response.statusCode} ${received / MiB} ${growth < 32 ? "bounded" : "unbounded"}\n`,
);
