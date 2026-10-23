// Run by `kept-guards.test.ts` with `--expose-gc`: the guards that stay on
// stream-like sources whose state cannot tell that they have closed
// (`PassThrough`s of `readable-stream` 3, and emitters of their own whose
// destroy emits `close`), cancelled at the deadline, must not keep the
// responses: they hold nothing but the report of a late error. Prints
// whether the responses are collected, and the listeners of `error` and
// `close` left on the sources (one each, of its guard).
import { Agent, get } from "node:http";
import { Binden, BindenResponse, type Context } from "../../index.js";
import { EventEmitter, once } from "node:events";
import type { AddressInfo } from "node:net";
import { capture } from "../helpers.js";
import { createRequire } from "node:module";
import { queryObjects } from "node:v8";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 25_000).unref();

const require = createRequire(import.meta.url);

/** A `PassThrough` of `readable-stream` 3 */
type IPassThrough = new () => EventEmitter;

const { PassThrough } = require("readable-stream-v3") as {
  PassThrough: IPassThrough;
};

/** An emitter of its own whose destroy emits `close` */
class Closing extends EventEmitter {
  public closed = false;

  public pause(): this {
    return this;
  }

  public resume(): this {
    return this;
  }

  public destroy(): this {
    process.nextTick(() => {
      this.closed = true;
      this.emit("close");
    });
    return this;
  }
}

const requests = 400;
const sources: EventEmitter[] = [];
// The report of the guards logs through it
const { logger } = capture();
const app = new Binden({ logger, timeout: 10 }).use(
  async (context: Context) => {
    const source = sources.length % 2 === 0 ? new PassThrough() : new Closing();
    sources.push(source);
    // @ts-expect-error -- both are stream-like sources
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
// Destroyed (each `PassThrough` emits its `close`), or closed
const closed = sources.filter(
  (source) =>
    Reflect.get(source, "destroyed") === true ||
    Reflect.get(source, "closed") === true,
).length;
const listeners = ["data", "end", "error", "close"].map((event) =>
  sources.reduce((count, source) => count + source.listenerCount(event), 0),
);
process.stdout.write(
  `${left < requests / 10 ? "collected" : `kept ${left}`} ${closed} ${listeners.join(" ")}\n`,
);
