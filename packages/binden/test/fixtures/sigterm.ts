// Run by `process.test.ts`: on SIGTERM, `shutdown()` lets the request in
// progress complete (its connection then closes), and the process exits once
// it has resolved, with nothing left to keep it alive
import { type IncomingMessage, request } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { Binden, shutdown } from "../../index.js";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 10_000).unref();

const app = new Binden().use(async (context) => {
  await new Promise((resolve) => {
    setTimeout(resolve, 100);
  });
  await context.send("done");
});

const server = app.createServer().listen(0);
await once(server, "listening");
const { port } = server.address() as AddressInfo;

const closing = new Promise<void>((resolve, reject) => {
  process.once("SIGTERM", () => {
    shutdown(server).then(resolve, reject);
  });
});

const pending = new Promise<IncomingMessage>((resolve, reject) => {
  request({ agent: false, port }, resolve).on("error", reject).end();
});
await new Promise((resolve) => {
  setTimeout(resolve, 20);
});
process.kill(process.pid, "SIGTERM");

const response = await pending;
let body = "";
response.setEncoding("utf8").on("data", (chunk: string) => {
  body += chunk;
});
await once(response, "end");
await closing;
const { statusCode, headers } = response;
process.stdout.write(
  `${statusCode} ${headers.connection} ${body} ${server.listening}\n`,
);
