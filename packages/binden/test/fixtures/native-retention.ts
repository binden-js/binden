// Run by `retention.test.ts` with `--expose-gc`: a Node.js `Readable` that the
// application keeps once its send has settled must not keep the response.
// The send removes every listener that it has added to the source, and the
// guard that stays on it (until the turn after its close) holds nothing but
// the report of a late error. Modes: `sent` (sent in full), `ended` (ended and
// closed before the send) and `cancelled` (at the deadline, with a destroy
// that does not complete). With `bound`, the listeners of each source are
// bound as the `context.bind()` of OpenTelemetry binds them (see `bind()`).
// Prints whether the responses are collected, and the listeners left on the
// sources (of `data`, `end`, `error` and `close`).
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

const [mode = "sent", binding = "unbound"] = process.argv.slice(2);
const requests = 400;
const sources: Readable[] = [];

/** A method of an emitter */
type IMethod = (this: Readable, ...args: unknown[]) => unknown;

/**
 * Binds the listeners of a source as the `context.bind()` of OpenTelemetry
 * binds those of an emitter: its own `on()`, `addListener()` and
 * `prependListener()` add a wrapper of each listener in its place, which
 * its own `removeListener()` and `off()` find (but `once()` is not patched:
 * it adds a wrapper of its own through `on()`, which they do not find)
 */
function bind(source: Readable): Readable {
  const wrappers = new Map<string, WeakMap<object, IMethod>>();
  for (const name of ["on", "addListener", "prependListener"]) {
    const add = Reflect.get(source, name) as IMethod;
    Object.defineProperty(source, name, {
      configurable: true,
      writable: true,
      value(this: Readable, event: string, listener: IMethod): unknown {
        function bound(this: unknown, ...args: unknown[]): unknown {
          return Reflect.apply(listener, this, args);
        }
        const map = wrappers.get(event) ?? new WeakMap<object, IMethod>();
        wrappers.set(event, map.set(listener, bound));
        return Reflect.apply(add, this, [event, bound]);
      },
    });
  }
  for (const name of ["removeListener", "off"]) {
    const remove = Reflect.get(source, name) as IMethod;
    Object.defineProperty(source, name, {
      configurable: true,
      writable: true,
      value(this: Readable, event: string, listener: IMethod): unknown {
        const bound = wrappers.get(event)?.get(listener) ?? listener;
        return Reflect.apply(remove, this, [event, bound]);
      },
    });
  }
  return source;
}

/** The source of a send, as the mode makes it */
async function created(): Promise<Readable> {
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

/** The source of a send, as the mode makes it (bound with `bound`) */
async function sourceOf(): Promise<Readable> {
  const source = await created();
  return binding === "bound" ? bind(source) : source;
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
