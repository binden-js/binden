// Run by `process.test.ts`: a logger whose methods return rejected promises
// (or throw) must neither crash the process (`unhandledRejection`) nor keep
// the requests from being handled, whoever logs (the framework or a context)
import { Binden, BindenError } from "../../index.js";
import { type IncomingMessage, request } from "node:http";
import type { AddressInfo } from "node:net";
import type { ILogger } from "@binden/logger";
import { once } from "node:events";

process.on("unhandledRejection", () => {
  process.stderr.write("unhandledRejection\n");
  process.exitCode = 1;
});
setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 10_000).unref();

const reject = (): Promise<never> =>
  Promise.reject(new Error("A rejecting logger"));
const logger: ILogger = {
  fatal: reject,
  error: reject,
  warn: reject,
  info: reject,
  debug: reject,
  trace: reject,
  child: () => logger,
};

const app = new Binden({ logger }).use((context) => {
  context.log.info("Handled", { path: context.url.pathname });
  context.log.child({ middleware: "test" }).debug("A child");
  if (context.url.pathname === "/fails") {
    throw new Error("A failure");
  } else if (context.url.pathname === "/client") {
    throw new BindenError(400);
  }
  return context.send("ok");
});

const server = app.createServer().listen(0);
await once(server, "listening");
const { port } = server.address() as AddressInfo;

const statuses: number[] = [];
for (const path of ["/", "/fails", "/client"]) {
  const response = await new Promise<IncomingMessage>((resolve, failed) => {
    request({ agent: false, path, port }, resolve).on("error", failed).end();
  });
  response.resume();
  await once(response, "end");
  statuses.push(response.statusCode ?? 0);
}

await new Promise((resolve) => {
  setImmediate(resolve);
});
server.close();
process.stdout.write(`${statuses.join(" ")}\n`);
