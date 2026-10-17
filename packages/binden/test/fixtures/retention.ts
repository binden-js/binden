// Run by `retention.test.ts` with `--expose-gc`: what outlives a request in
// the async context of one of its works (`timers`: a long timer that it has
// created; `shared`: a listener of `end` that it has left on a long-lived
// source, in the window of its pipe) must not keep the request, once it has
// completed. Prints how many responses are left after a full collection.
import { Agent, get } from "node:http";
import { Binden, BindenResponse, type Context } from "../../index.js";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { queryObjects } from "node:v8";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 25_000).unref();

const [mode = "timers", count = "4000"] = process.argv.slice(2);
const requests = Number(count);
const shared = new PassThrough();
shared.setMaxListeners(0);

const app = new Binden().use(async (context: Context) => {
  if (mode === "timers") {
    // E.g. the expiry of a cache entry
    setTimeout(() => null, 600_000).unref();
  } else {
    shared.pipe(context.response);
    // In the window of the pipe: bound to its work
    shared.once("end", () => null);
    shared.unpipe(context.response);
  }
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
const left = queryObjects(BindenResponse, { format: "count" });
process.stdout.write(`${left < 100 ? "collected" : `kept ${left}`}\n`);
