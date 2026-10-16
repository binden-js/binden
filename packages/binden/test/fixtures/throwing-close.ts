// Run by `process.test.ts`: a `close` listener of the application that throws
// surfaces as with Node.js (an uncaught exception, observed here), and the
// framework still completes the request, after the listeners of the
// application: its cleanup runs, and its access log is written.
import { type AddressInfo, connect } from "node:net";
import { Binden, type Context } from "../../index.js";
import { Logger } from "@binden/logger";
import { once } from "node:events";

const thrown: string[] = [];
process.on("uncaughtException", (error: Error) => {
  thrown.push(error.message);
});
setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 10_000).unref();

const lines: string[] = [];
const logger = new Logger({
  destination: {
    write(line: string): void {
      lines.push(line);
    },
  },
  level: "info",
});
const events: string[] = [];
const app = new Binden({ logger, access_log: true }).use(
  async (context: Context) => {
    context.onCleanup(() => {
      events.push("cleanup");
    });
    context.response.on("close", () => {
      events.push("listener");
      throw new Error("A close listener has failed");
    });
    await context.text("ok");
  },
);
const server = app.createServer().listen(0);
await once(server, "listening");
const { port } = server.address() as AddressInfo;

const socket = connect(port, "localhost").resume();
await once(socket, "connect");
socket.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
await once(socket, "close");
while (!events.includes("cleanup")) {
  await new Promise((resolve) => {
    setTimeout(resolve, 5);
  });
}
server.close();
const logged = lines.filter((line) =>
  line.includes("The request has completed"),
).length;
process.stdout.write(
  `${events.join(",")} ${thrown.join(",")} logged:${logged}\n`,
);
