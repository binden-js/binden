// Run by `process.test.ts`, without a handler of the process: the compression
// is run on a context of the application whose every use throws once `run()`
// has returned (a proxy of the context, its request and its response, whose
// traps fail from then on). Every later use of them by the compression must
// throw (formatted) to its caller, or not happen, never out of any call: the
// framework then replies (here, by closing the connection), and the process
// does not crash. Prints how the connection has ended. With `request`, a
// context whose request can be read once only: the compression decides by
// what it has read as it was installed (prints the coding of the reply).
import { type AddressInfo, connect } from "node:net";
import { Binden, type Context } from "binden";
import { Compression } from "../../index.js";
import { Logger } from "@binden/logger";
import { once } from "node:events";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 25_000).unref();

/** An error of the traps */
class TrapError extends Error {}

/** A switch that the traps of a proxy read (see `late()`) */
interface ISwitch {
  armed: boolean;
}

/** Throws the error of a late use */
function fail(): never {
  throw new TrapError("A late use");
}

/** A trap that forwards to `Reflect` until the switch is armed */
function forward(state: ISwitch, key: keyof typeof Reflect): unknown {
  const method = Reflect.get(Reflect, key) as (...values: unknown[]) => unknown;
  return (...args: unknown[]): unknown => {
    if (state.armed) {
      return fail();
    }
    return Reflect.apply(method, Reflect, args);
  };
}

/** A proxy of a value whose traps throw once it is armed (the objects that it gives as well) */
function late(value: object): [proxy: object, arm: () => void] {
  const state: ISwitch = { armed: false };
  const proxies = new WeakMap<object, object>();
  const handler: ProxyHandler<object> = {
    get(target: object, key: PropertyKey): unknown {
      if (state.armed) {
        return fail();
      }
      const got: unknown = Reflect.get(target, key, target);
      if (typeof got === "function") {
        return (got as (...args: unknown[]) => unknown).bind(target);
      } else if (typeof got !== "object" || got === null) {
        return got;
      }
      const proxy = proxies.get(got) ?? new Proxy(got, handler);
      proxies.set(got, proxy);
      return proxy;
    },
  };
  for (const key of [
    "defineProperty",
    "getOwnPropertyDescriptor",
    "getPrototypeOf",
    "has",
    "ownKeys",
    "set",
  ] as const) {
    Reflect.set(handler, key, forward(state, key));
  }
  return [
    new Proxy(value, handler),
    (): void => {
      state.armed = true;
    },
  ];
}

const [mode = "proxy"] = process.argv.slice(2);
const compression = new Compression({ threshold: 0 });
const app = new Binden({ logger: new Logger({ level: "silent" }) }).use(
  async (context: Context) => {
    if (mode === "request") {
      // Its request read once, as the compression is installed: the decision
      // of the reply reads nothing more of it
      let reads = 0;
      compression.run({
        get request(): Context["request"] {
          reads += 1;
          return reads === 1 ? context.request : fail();
        },
        response: context.response,
      } as Context);
      await context.send("text");
      return;
    }
    const [proxy, arm] = late(context);
    compression.run(proxy as Context);
    arm();
    // The framework replies once this middleware has returned
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  },
);
const server = app.createServer().listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address() as AddressInfo;
const socket = connect(port, "127.0.0.1");
let received = "";
socket.setEncoding("latin1").on("data", (chunk: string) => {
  received += chunk;
});
socket.on("error", () => {
  // E.g. a reset of the closed response
});
await once(socket, "connect");
socket.write(
  "GET / HTTP/1.1\r\nHost: localhost\r\nAccept-Encoding: gzip\r\nConnection: close\r\n\r\n",
);
await once(socket, "close");
server.close();
process.stdout.write(
  mode === "request"
    ? `${received.includes("\r\nContent-Encoding: gzip\r\n") ? "gzip" : received}\n`
    : `closed ${JSON.stringify(received.slice(0, 12))}\n`,
);
