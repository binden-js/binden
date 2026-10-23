// Run by `stream-like.test.ts` with `--expose-gc`: a stream-like source whose
// `destroy()` emits nothing (which its contract does not require), cancelled
// at the deadline, must not keep the response: the send removes its listeners
// at once, and the guard that stays on the source holds nothing but the
// report of a late error. Prints whether the responses are collected, and
// the listeners left on the sources (of `data`, `end`, `error` and `close`).
import { Agent, get } from "node:http";
import { Binden, BindenResponse, type Context } from "../../index.js";
import { EventEmitter, once } from "node:events";
import type { AddressInfo } from "node:net";
import { capture } from "../helpers.js";
import { queryObjects } from "node:v8";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 25_000).unref();

/** A stream-like source whose `destroy()` emits nothing */
class Silent extends EventEmitter {
  public pause(): this {
    return this;
  }

  public resume(): this {
    return this;
  }

  public destroy(): this {
    return this;
  }
}

const requests = 400;
const sources: Silent[] = [];
// The report of the guards logs through it
const { logger } = capture();
const app = new Binden({ logger, timeout: 10 }).use(
  async (context: Context) => {
    const source = new Silent();
    sources.push(source);
    await context.send(source);
  },
);

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
const left = queryObjects(BindenResponse, { format: "count" });
const listeners = ["data", "end", "error", "close"].map((event) =>
  sources.reduce((count, source) => count + source.listenerCount(event), 0),
);
process.stdout.write(
  `${left < requests / 10 ? "collected" : `kept ${left}`} ${listeners.join(" ")}\n`,
);
