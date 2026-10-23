// Run by `process.test.ts`, without a handler of the process: a send of a
// `Readable` whose head the application commits around binden (by
// `writeHead()` of Node.js) once it has set a `Content-Length` of another
// type (an object whose conversion is a length), after the send has started.
// The client goes away once it has read the first chunk of the body: whether
// the body is complete is decided as the response closes, which must neither
// throw (the process would crash) nor take the refused value for the length.
// Prints how the send has settled.
import { type AddressInfo, connect } from "node:net";
import { Binden, type Context } from "../../index.js";
import { HOST } from "../helpers.js";
import type { ILogger } from "@binden/logger";
import { Readable } from "node:stream";
import { ServerResponse } from "node:http";
import { once } from "node:events";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 25_000).unref();

const silent: ILogger = {
  fatal: () => null,
  error: () => null,
  warn: () => null,
  info: () => null,
  debug: () => null,
  trace: () => null,
  child: () => silent,
};

const { promise: settled, resolve } = Promise.withResolvers<string>();
const app = new Binden({ logger: silent }).use(async (context: Context) => {
  const { response } = context;
  response.setHeader("Content-Length", 6);
  const source = new Readable({
    read(): void {
      // Pushed below
    },
  });
  const sent = response.send(source);
  response.setHeader("Content-Length", {
    toString: (): string => "6",
  } as never);
  ServerResponse.prototype.writeHead.call(response, 200);
  source.push("abc");
  resolve(
    await sent.then(
      () => "resolved",
      () => "rejected",
    ),
  );
});
const server = app.createServer().listen(0, HOST);
await once(server, "listening");
const { port } = server.address() as AddressInfo;
const socket = connect(port, HOST);
let received = "";
socket.setEncoding("latin1").on("data", (chunk: string) => {
  received += chunk;
  if (received.endsWith("abc")) {
    socket.destroy();
  }
});
socket.on("error", () => {
  // Gone
});
await once(socket, "connect");
socket.write(`GET / HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`);
const outcome = await settled;
server.close();
process.stdout.write(`${outcome}\n`);
