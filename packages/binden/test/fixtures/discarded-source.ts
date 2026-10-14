// Run by `process.test.ts`: the sources that a response does not send are
// destroyed, and their errors must not crash the process
import { type IncomingMessage, request } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { once } from "node:events";
import { Binden } from "../../index.js";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 10_000).unref();

/** A source whose `destroy()` fails */
function failing(): Readable {
  return new Readable({
    read(): void {
      // Nothing to read
    },
    destroy(_error, callback): void {
      callback(new Error("The source failed to close"));
    },
  });
}

const app = new Binden().use(async (context) => {
  const { pathname } = context.url;
  if (pathname === "/no-content") {
    context.status(204);
  } else if (pathname === "/ended") {
    context.response.end();
  }
  await context.send(failing());
});

const server = app.createServer().listen(0);
await once(server, "listening");
const { port } = server.address() as AddressInfo;

const statuses: number[] = [];
for (const [method, path] of [
  ["HEAD", "/"],
  ["GET", "/no-content"],
  ["GET", "/ended"],
]) {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    request({ agent: false, method, path, port }, resolve)
      .on("error", reject)
      .end();
  });
  response.resume();
  await once(response, "end");
  statuses.push(response.statusCode ?? 0);
}

// The errors of the destroyed sources are emitted asynchronously
await new Promise((resolve) => {
  setImmediate(resolve);
});
server.close();
process.stdout.write(`${statuses.join(" ")}\n`);
