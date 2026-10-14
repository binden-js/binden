// Run by `process.test.ts`: hung middlewares and error handlers, and their late
// failures, must neither crash the process (`unhandledRejection`) nor keep a
// request without a reply
import { type IncomingMessage, request } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { Binden, BindenError, type Context } from "../../index.js";

process.on("unhandledRejection", () => {
  process.stderr.write("unhandledRejection\n");
  process.exitCode = 1;
});
setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 10_000).unref();

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
const never = (): Promise<void> =>
  new Promise(() => {
    // Never settles
  });

const handlers: Partial<Record<string, () => Promise<void> | void>> = {
  "/handler-hangs": never,
  "/handler-fails-late": async () => {
    await sleep(80);
    throw new Error("A late failure");
  },
  "/handler-throws": () => {
    throw new Error("A failure");
  },
};

const app = new Binden({
  timeout: 30,
  error_handler_timeout: 30,
  error_handler: async (context: Context): Promise<void> => {
    await handlers[context.url.pathname]?.();
  },
}).use(async (context) => {
  const { pathname } = context.url;
  if (pathname === "/hangs") {
    await never();
  } else if (pathname === "/fails-late") {
    await sleep(80);
    throw new Error("A late failure");
  }
  throw new BindenError(400);
});

const server = app.createServer().listen(0);
await once(server, "listening");
const { port } = server.address() as AddressInfo;

const statuses: number[] = [];
for (const path of [
  "/hangs",
  "/fails-late",
  "/handler-hangs",
  "/handler-fails-late",
  "/handler-throws",
]) {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    request({ agent: false, path, port }, resolve).on("error", reject).end();
  });
  response.resume();
  await once(response, "end");
  statuses.push(response.statusCode ?? 0);
}

// The late failures come after the replies
await sleep(150);
server.close();
process.stdout.write(`${statuses.join(" ")}\n`);
