// Run by `process.test.ts`: a `filter` that returns a rejected promise (or a
// thenable whose `then` throws) must not crash the process
// (`unhandledRejection`): the response is replaced with 500
import { Binden, type Context } from "binden";
import { type IncomingMessage, request } from "node:http";
import type { AddressInfo } from "node:net";
import { Compression } from "../../index.js";
import { Logger } from "@binden/logger";
import { once } from "node:events";

process.on("unhandledRejection", () => {
  process.stderr.write("unhandledRejection\n");
  process.exitCode = 1;
});
setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 10_000).unref();

const thenable = {
  get then(): never {
    throw new Error("A throwing `then`");
  },
};
const filter = (context: Context): boolean =>
  (context.url.pathname === "/thenable"
    ? thenable
    : Promise.reject(new Error("A rejecting filter"))) as unknown as boolean;

const app = new Binden({ logger: new Logger({ level: "silent" }) }).use(
  new Compression({ filter }),
  (context: Context) => context.text("Some text to compress. ".repeat(64)),
);

const server = app.createServer().listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address() as AddressInfo;

const statuses: number[] = [];
for (const path of ["/", "/thenable"]) {
  const response = await new Promise<IncomingMessage>((resolve, failed) => {
    request(
      {
        agent: false,
        path,
        host: "127.0.0.1",
        port,
        headers: { "Accept-Encoding": "gzip" },
      },
      resolve,
    )
      .on("error", failed)
      .end();
  });
  response.resume();
  await once(response, "end");
  statuses.push(response.statusCode ?? 0);
}

// Time for a rejection to be reported
await new Promise((resolve) => {
  setTimeout(resolve, 50);
});
server.close();
process.stdout.write(`${statuses.join(" ")}\n`);
