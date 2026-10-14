// Run by `process.test.ts`: on SIGTERM, `shutdown()` lets the request in
// progress complete (its connection then closes), and the process exits once
// it has resolved, with nothing left to keep it alive. No step depends on
// timing: SIGTERM is sent once the request is in progress (the client never
// connects to a server that has stopped listening), and the request completes
// once the shutdown has begun.
import { Binden, shutdown } from "../../index.js";
import { type IncomingMessage, request } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 10_000).unref();

const received = Promise.withResolvers<null>();
const terminated = Promise.withResolvers<null>();

const app = new Binden().use(async (context) => {
  received.resolve(null);
  await terminated.promise;
  await context.send("done");
});

const server = app.createServer().listen(0);
await once(server, "listening");
const { port } = server.address() as AddressInfo;

const closing = new Promise<void>((resolve, reject) => {
  process.once("SIGTERM", () => {
    shutdown(server).then(resolve, reject);
    terminated.resolve(null);
  });
});

const pending = new Promise<IncomingMessage>((resolve, reject) => {
  request({ agent: false, port }, resolve).on("error", reject).end();
});
await received.promise;
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
