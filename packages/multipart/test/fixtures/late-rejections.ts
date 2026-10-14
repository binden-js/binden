// Run by `process.test.ts`: callbacks that never settle, or that fail once
// the request has been aborted, must neither crash the process
// (`unhandledRejection`) nor keep a request without a reply
import { Binden, type Context } from "binden";
import { type IncomingMessage, request } from "node:http";
import type { AddressInfo } from "node:net";
import multipart from "../../index.js";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

process.on("unhandledRejection", () => {
  process.stderr.write("unhandledRejection\n");
  process.exitCode = 1;
});
setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 10_000).unref();

const never = (): Promise<boolean> =>
  new Promise(() => {
    // Never settles
  });
const failsLate = async (): Promise<boolean> => {
  await sleep(80);
  throw new Error("A late failure");
};

const app = new Binden({ timeout: 30 })
  .use("/hangs", multipart({ file_filter: never }))
  .use("/fails-late", multipart({ file_filter: failsLate }))
  .use((context: Context) => context.send());

const server = app.createServer().listen(0);
await once(server, "listening");
const { port } = server.address() as AddressInfo;

const boundary = "binden-boundary";
const head = [
  `--${boundary}`,
  'Content-Disposition: form-data; name="file"; filename="file.txt"',
  "",
  "Hello",
].join("\r\n");

const statuses: number[] = [];
for (const path of ["/hangs", "/fails-late"]) {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    request({
      agent: false,
      method: "POST",
      path,
      port,
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": 1024,
      },
    })
      .once("response", resolve)
      .once("error", reject)
      .write(head);
  });
  response.resume();
  await once(response, "end");
  statuses.push(response.statusCode ?? 0);
}

// The late failures come after the replies
await sleep(150);
server.close();
process.stdout.write(`${statuses.join(" ")}\n`);
