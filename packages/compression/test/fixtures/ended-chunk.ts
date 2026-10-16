// Run by `process.test.ts`: once the compression has ended a response
// (replaced with `406`, or by the end of its compressor), a chunk that Node.js
// refuses throws as for a response that has not ended, uncaught by the
// application, rather than the `error` event that Node.js emits for an ended
// one: the response has no listener of it, which would crash the process
import { type AddressInfo, connect } from "node:net";
import { Binden, type BindenResponse, type Context } from "binden";
import { Compression } from "../../index.js";
import { Logger } from "@binden/logger";
import { once } from "node:events";

for (const event of ["unhandledRejection", "uncaughtException"]) {
  process.on(event, () => {
    process.stderr.write(`${event}\n`);
    process.exit(1);
  });
}
setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 10_000).unref();

const body = "Some text to compress. ".repeat(256);
const routes: Partial<
  Record<string, (response: BindenResponse) => Promise<void> | void>
> = {
  // Replaced with `406` by a write, or by `writeHead()`
  "/write-end": (response) => {
    response.write(body);
    response.end(42);
  },
  "/write-end-object": (response) => {
    response.write(body);
    response.end({});
  },
  "/write-write": (response) => {
    response.write(body);
    response.write({});
  },
  "/head-end": (response) => {
    response.writeHead(200);
    response.end(42);
  },
  "/head-end-object": (response) => {
    response.writeHead(200);
    response.end({});
  },
  "/head-write": (response) => {
    response.writeHead(200);
    response.write({});
  },
  // Compressed, then ended: once the response has finished
  "/compressed": async (response) => {
    response.end(body);
    await once(response, "finish");
    response.end({});
  },
};

const app = new Binden({ logger: new Logger({ level: "silent" }) }).use(
  new Compression({ format: "gzip" }),
  async (context: Context) => {
    context.response.type("text/plain");
    await routes[context.url.pathname]?.(context.response);
  },
);
const server = app.createServer().listen(0);
await once(server, "listening");
const { port } = server.address() as AddressInfo;

const replies: string[] = [];
for (const path of Object.keys(routes)) {
  const accept = path === "/compressed" ? "gzip" : "identity;q=0";
  const socket = connect(port, "localhost");
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: localhost\r\nAccept-Encoding: ${accept}\r\nConnection: close\r\n\r\n`,
  );
  await once(socket, "close");
  const [status = ""] = Buffer.concat(chunks).toString("latin1").split("\r\n");
  replies.push(`${path} ${status}`);
}

server.close();
process.stdout.write(`${replies.join("\n")}\n`);
