// Run by `retention.test.ts` with `--expose-gc`: a `child()` of the logger
// of the application that gives the last `context.log` (e.g. a cache) must
// not make a `context.log` keep the ones made before it. Prints whether the
// first one is collected, and how many loggers of binden are left, after a
// full collection.
import { Agent, get } from "node:http";
import { Binden, type Context } from "../../index.js";
import type { AddressInfo } from "node:net";
import type { ILogger } from "@binden/logger";
import { once } from "node:events";
import { queryObjects } from "node:v8";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 25_000).unref();

const requests = Number(process.argv[2] ?? "1000");
let last: ILogger | null = null;
let first = null as WeakRef<ILogger> | null;
const write = (): void => {
  // Dropped
};
const caching: ILogger = {
  fatal: write,
  error: write,
  warn: write,
  info: write,
  debug: write,
  trace: write,
  child: (): ILogger => last ?? caching,
};

const app = new Binden({ logger: caching }).use(async (context: Context) => {
  last = context.log;
  first ??= new WeakRef(last);
  await context.text("ok");
});

const server = app.createServer();
server.listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address() as AddressInfo;
const agent = new Agent({ keepAlive: true, maxSockets: 8 });
const request = (): Promise<void> =>
  new Promise((resolve, reject) => {
    get({ port, agent, host: "127.0.0.1" }, (response) => {
      response.resume().once("end", resolve);
    }).once("error", reject);
  });
for (let sent = 0; sent < requests; sent += 8) {
  await Promise.all(Array.from({ length: 8 }, request));
}
agent.destroy();
server.close();
await once(server, "close");
const gc = Reflect.get(globalThis, "gc") as () => void;
for (let round = 0; round < 3; round += 1) {
  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
  gc();
}
const kept = last as unknown as ILogger;
const left = queryObjects(kept.constructor, { format: "count" });
const collected = typeof first?.deref() === "undefined";
process.stdout.write(`${collected ? "collected" : "kept"} ${left}\n`);
// Still in use
kept.info("kept");
