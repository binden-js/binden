// Run by `guard-refusals.test.ts` with `--expose-gc`: sources whose guard
// cannot be installed (they refuse its listener of `error`, the second one),
// a Node.js `Readable` and a stream-like source, which keep the listener of
// `error` of their send, and a Node.js `Readable` whose guard stays (it never
// closes), each sent whole by a third of the requests. Neither listener may
// keep the response once the send has settled: each holds nothing but the
// report of a late error. Prints whether the responses are collected, the
// listeners of `error` left on the sources of each kind (one each), the late
// errors that they log once the sources fail, and the refusals logged.
import { Agent, get } from "node:http";
import { Binden, BindenResponse, type Context } from "../../index.js";
import { EventEmitter, once } from "node:events";
import { capture, pollUntil } from "../helpers.js";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { queryObjects } from "node:v8";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 25_000).unref();

/**
 * Makes a source refuse its second listener of `error`: a listener of its
 * `newListener` throws for it (a `Readable`, whose guard is added by the
 * methods of `EventEmitter`), or its own `on()` (a stream-like source)
 */
function refusing<T extends EventEmitter>(source: T): T {
  let listeners = 0;
  const refuse = (event: string): void => {
    if (event === "error") {
      listeners += 1;
      if (listeners === 2) {
        throw new Error("No guard");
      }
    }
  };
  if (source instanceof Readable) {
    return source.on("newListener", refuse);
  }
  const on = Reflect.get(source, "on") as (...args: unknown[]) => unknown;
  return Object.assign(source, {
    on(event: string, listener: () => void): unknown {
      refuse(event);
      return Reflect.apply(on, source, [event, listener]);
    },
  });
}

/** A stream-like source, sent whole on the next turn */
class Whole extends EventEmitter {
  public constructor() {
    super();
    setImmediate(() => {
      this.emit("data", Buffer.from("ok"));
      this.emit("end");
    });
  }

  public pause(): this {
    return this;
  }

  public resume(): this {
    return this;
  }
}

/** The kinds of sources, by path: each other request gets one of them */
const kinds = ["/readable", "/like", "/guarded"];
const requests = 300;
/** The sources, by kind */
const sources = new Map<string, EventEmitter[]>(
  kinds.map((kind) => [kind, []]),
);
const captured = capture();
const app = new Binden({
  logger: captured.logger,
  log_error_details: true,
}).use(async (context: Context) => {
  const { pathname } = context.url;
  const readable = (): Readable =>
    new Readable({
      autoDestroy: false,
      read(): void {
        this.push("ok");
        this.push(null);
      },
    });
  const source =
    pathname === "/like"
      ? refusing(new Whole())
      : pathname === "/readable"
        ? refusing(readable())
        : readable();
  sources.get(pathname)?.push(source);
  await context.send(source);
});

const server = app.createServer();
server.listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address() as AddressInfo;
const agent = new Agent({ keepAlive: true, maxSockets: 8 });
const request = (path: string): Promise<void> =>
  new Promise((resolve, reject) => {
    get({ port, agent, path, host: "127.0.0.1" }, (response) => {
      response.resume().once("end", resolve);
    }).once("error", reject);
  });
for (let sent = 0; sent < requests; sent += 6) {
  await Promise.all(
    Array.from({ length: 6 }, (_value, index) =>
      request(kinds[index % kinds.length]),
    ),
  );
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
/** The listeners of `error` left on the sources of each kind */
const listeners = kinds.map((kind) =>
  (sources.get(kind) ?? []).reduce(
    (count, source) => count + source.listenerCount("error"),
    0,
  ),
);
/** The guards that could not be installed */
const refused = captured.records.filter(
  ({ failure }) =>
    (failure as { message?: unknown } | undefined)?.message === "No guard",
).length;
// Each source fails: its listener of `error` logs it
for (const source of [...sources.values()].flat()) {
  source.emit("error", new Error("Late failure"));
}
const late = (): number =>
  captured.records.filter(
    ({ level, failure }) =>
      level === 20 &&
      (failure as { message?: unknown } | undefined)?.message ===
        "Late failure",
  ).length;
await pollUntil(() => late() >= requests, 5_000).catch(() => null);
process.stdout.write(
  `${left < requests / 10 ? "collected" : `kept ${left}`} ${listeners.join(" ")} ${late()} ${refused}\n`,
);
