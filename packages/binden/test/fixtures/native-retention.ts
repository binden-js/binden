// Run by `retention.test.ts` with `--expose-gc`: a Node.js `Readable` that the
// application keeps once its send has settled must not keep the response.
// The send removes every listener that it has added to the source, and the
// guard that stays on it (until the turn after its close) holds nothing but
// the report of a late error. Modes: `sent` (sent in full), `ended` (ended and
// closed before the send) and `cancelled` (at the deadline, with a destroy
// that does not complete). Prints whether the responses are collected, and
// the listeners left on the sources (of `data`, `end`, `error` and `close`).
import { Agent, get } from "node:http";
import { Binden, BindenResponse, type Context } from "../../index.js";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { capture } from "../helpers.js";
import { once } from "node:events";
import { queryObjects } from "node:v8";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 25_000).unref();

const [mode = "sent"] = process.argv.slice(2);
const requests = 400;
const sources: Readable[] = [];

/** The source of a send, as the mode makes it */
async function sourceOf(): Promise<Readable> {
  if (mode === "sent") {
    return Readable.from(["x"]);
  } else if (mode === "ended") {
    const source = new Readable({
      read(): void {
        this.push(null);
      },
    });
    source.resume();
    await once(source, "close");
    return source;
  }
  return new Readable({
    read(): void {
      // Its first chunk never comes
    },
    destroy(error, callback): void {
      setTimeout(callback, 60_000, error).unref();
    },
  });
}

// The report of the guards logs through it
const { logger } = capture();
const app = new Binden({
  logger,
  ...(mode === "cancelled" ? { timeout: 10 } : {}),
}).use(async (context: Context) => {
  const source = await sourceOf();
  sources.push(source);
  await context.send(source);
});

const server = app.createServer();
server.listen(0, "localhost");
await once(server, "listening");
const { port } = server.address() as AddressInfo;
const agent = new Agent({ keepAlive: true, maxSockets: 8 });
const request = (): Promise<void> =>
  new Promise((resolve, reject) => {
    get({ port, agent, host: "localhost" }, (response) => {
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
