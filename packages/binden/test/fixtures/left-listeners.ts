// Run by `stream-like-left-listeners.test.ts` with `--expose-gc`: a
// stream-like source whose `removeListener()` throws for one event (the
// argument: `data`, `end` or `close`) keeps the listener of that event that
// the send has added, and the application keeps the sources: those listeners
// must not keep the responses (nor anything of their sends). Prints whether
// the responses are collected, and the listeners of that event left on the
// sources.
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

const [left = "data"] = process.argv.slice(2);

/** A stream-like source whose `removeListener()` throws for one event */
class Source extends EventEmitter {
  public pause(): this {
    return this;
  }

  public resume(): this {
    return this;
  }

  public destroy(): this {
    return this;
  }

  public override removeListener(
    event: string,
    listener: (...args: unknown[]) => void,
  ): this {
    if (event === left) {
      throw new Error("The listener cannot be removed");
    }
    return super.removeListener(event, listener);
  }
}

const requests = 200;
const sources: Source[] = [];
// The report of the guards logs through it
const { logger } = capture();
const app = new Binden({ logger }).use(async (context: Context) => {
  const source = new Source();
  sources.push(source);
  const sent = context.send(source);
  source.emit("data", Buffer.from("ok"));
  source.emit("end");
  await sent;
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
const kept = queryObjects(BindenResponse, { format: "count" });
const listeners = sources.reduce(
  (count, source) => count + source.listenerCount(left),
  0,
);
process.stdout.write(
  `${kept < requests / 10 ? "collected" : `kept ${kept}`} ${listeners}\n`,
);
