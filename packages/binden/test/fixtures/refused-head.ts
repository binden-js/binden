// Run by `process.test.ts`: a reason phrase or a header that Node.js refuses
// when it sends the headers (given to `writeHead()`, assigned, or a `Trailer`
// of a body that is not chunked) must neither crash the process nor keep the
// request without a reply: the error handler replies `500`
import { Binden, type Context } from "../../index.js";
import { type IncomingMessage, request } from "node:http";
import type { AddressInfo } from "node:net";
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
const routes: Partial<Record<string, (context: Context) => unknown>> = {
  "/reason": ({ response }) => response.writeHead(200, invalid),
  "/header": ({ response }) => response.writeHead(200, { "X-A": invalid }),
  "/pairs": ({ response }) => response.writeHead(200, ["X-A"]),
  "/assigned": async ({ response }) => {
    response.statusMessage = invalid;
    await response.send("body");
  },
  "/assigned-empty": async ({ response }) => {
    response.statusMessage = invalid;
    await response.send();
  },
  "/stream": async ({ response }) => {
    response.statusMessage = invalid;
    await response.send(Readable.from(["body"]));
  },
  "/empty-stream": async ({ response }) => {
    response.statusMessage = invalid;
    await response.send(Readable.from([]));
  },
  "/file": async ({ response }) => {
    response.statusMessage = invalid;
    await response.sendFile(import.meta.filename);
  },
  "/flush": async ({ response }) => {
    response.statusMessage = invalid;
    await response.flush();
  },
  "/trailer": async ({ response }) => {
    response.setHeader("Trailer", "X-T");
    await response.send("body");
  },
};

const app = new Binden().use(async (context: Context) => {
  await routes[context.url.pathname]?.(context);
});
const server = app.createServer().listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address() as AddressInfo;

const replies: string[] = [];
for (const path of Object.keys(routes)) {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    request({ agent: false, path, host: "127.0.0.1", port }, resolve)
      .on("error", reject)
      .end();
  });
  response.resume();
  await once(response, "end");
  replies.push(`${response.statusCode} ${response.statusMessage}`);
}

server.close();
process.stdout.write(
  `${[...new Set(replies)].join(", ")} (${replies.length})\n`,
);
