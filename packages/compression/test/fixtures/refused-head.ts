// Run by `process.test.ts`: a reason phrase, a header or a status that Node.js
// refuses once a compression has taken its decision must neither crash the
// process (on every supported version of Node.js) nor send compressed bytes
// after the reply of the error, an empty `500`
import { type AddressInfo, connect } from "node:net";
import { Binden, type BindenResponse, type Context } from "binden";
import { Compression } from "../../index.js";
import { Logger } from "@binden/logger";
import { Readable } from "node:stream";
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

const invalid = "bad\n";
const body = "Some text to compress. ".repeat(256);
const routes: Partial<
  Record<string, (response: BindenResponse) => Promise<void> | void>
> = {
  "/reason": (response) => {
    response.writeHead(200, invalid);
  },
  "/header": (response) => {
    response.writeHead(200, { "X-A": invalid });
  },
  "/end": (response) => {
    response.statusMessage = invalid;
    response.end(body);
  },
  "/write": (response) => {
    response.statusMessage = invalid;
    response.write(body);
  },
  "/send": async (response) => {
    response.statusMessage = invalid;
    await response.send(body);
  },
  "/stream": async (response) => {
    response.statusMessage = invalid;
    await response.send(Readable.from([body]));
  },
  "/file": async (response) => {
    response.statusMessage = invalid;
    await response.sendFile(import.meta.filename, {
      content_type: "text/plain",
    });
  },
  "/flush": async (response) => {
    response.statusMessage = invalid;
    await response.flush();
  },
  "/status": (response) => {
    response.statusCode = 1000;
    response.end(body);
  },
  "/trailer": (response) => {
    // Of a body that is not chunked: of HTTP/1.0
    response.setHeader("Trailer", "X-T");
    response.end(body);
  },
};

const app = new Binden({ logger: new Logger({ level: "silent" }) }).use(
  new Compression({ format: "gzip" }),
  async (context: Context) => {
    context.response.type("text/plain");
    await routes[context.url.pathname]?.(context.response);
  },
);
const server = app.createServer().listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address() as AddressInfo;

const replies: string[] = [];
for (const version of ["1.1", "1.0"]) {
  // Chunked (HTTP/1.1), its trailers are valid
  const paths = Object.keys(routes).filter(
    (path) => version === "1.0" || path !== "/trailer",
  );
  for (const path of paths) {
    const socket = connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.write(
      `GET ${path} HTTP/${version}\r\nHost: localhost\r\nAccept-Encoding: gzip\r\nConnection: close\r\n\r\n`,
    );
    await once(socket, "close");
    const received = Buffer.concat(chunks).toString("latin1");
    const index = received.indexOf("\r\n\r\n");
    const [status = ""] = received.split("\r\n");
    // Nothing after the head of the empty reply
    replies.push(`${status} (${received.length - index - 4} bytes)`);
  }
}

server.close();
process.stdout.write(
  `${[...new Set(replies)].join(", ")} (${replies.length})\n`,
);
