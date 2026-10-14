// Run by `process.test.ts`: a custom logger whose `child()` throws must not
// crash the process, nor keep the request from being handled
import { type IncomingMessage, request } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { Logger } from "@binden/logger";
import { Binden } from "../../index.js";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 10_000).unref();

class ThrowingLogger extends Logger {
  // eslint-disable-next-line class-methods-use-this -- a logger that always fails
  public override child(): Logger {
    throw new Error("The logger cannot create a child");
  }
}

const lines: string[] = [];
const logger = new ThrowingLogger({
  destination: {
    write(line: string): void {
      lines.push(line);
    },
  },
  level: "info",
});

const app = new Binden({ logger }).use((context) => {
  context.log.info("Handled");
  return context.send("ok");
});

const server = app.createServer().listen(0);
await once(server, "listening");
const { port } = server.address() as AddressInfo;

const response = await new Promise<IncomingMessage>((resolve, reject) => {
  request({ agent: false, port }, resolve).on("error", reject).end();
});
let body = "";
response.setEncoding("utf8").on("data", (chunk: string) => {
  body += chunk;
});
await once(response, "end");
server.close();

// The logs of the context go to the logger itself
const handled = lines.some((line) => line.includes("Handled"));
process.stdout.write(`${response.statusCode} ${body} ${handled}\n`);
