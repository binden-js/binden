// Run by `carrier-stacks.test.ts`, without a handler of the process: a source
// brings a value (`V`) whose `stack` is a getter of its own, which Node.js
// cannot read safely, so that binden destroys a readable with a carrier of it,
// while a `prepareStackTrace` of the application is armed: for every error
// that V8 formats meanwhile, it redefines its `stack` as a getter that throws
// and cannot be configured (`nonconf`), or freezes it and throws (`freeze`).
// The source (the other arguments): a stream-like source of its own that emits
// V (`emit`), or whose `pause()` (once the response is full, `pause`) or
// `resume()` (`resume`) throws it; a Node.js `Readable` whose own `pause()`
// throws it (`node-pause`); a `PassThrough` of `readable-stream` 4 or 3 that
// the application destroys with V after a first chunk (`rs4`, `rs3`); or a
// Node.js `Readable` whose own `resume()` throws V and whose `_destroy()`
// redefines the `stack` of what it is destroyed with as a getter that throws
// before it calls back on a later turn (`redefine`: Node.js reads that stack
// again then). The send must reject with V, the source must be destroyed
// once, and nothing may be thrown into its events. Prints, for the kind and
// each way, whether the response is cut or replied (with the status that the
// client gets), how the send has settled, what the source has been
// destroyed with (V, its carrier, or nothing: `none`), whether it is
// destroyed, and what its events have thrown.
import { type AddressInfo, connect } from "node:net";
import { Binden, type Context } from "../../index.js";
import { EventEmitter, once } from "node:events";
import { Readable } from "node:stream";
import { createRequire } from "node:module";
import { pollUntil } from "../helpers.js";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 25_000).unref();

const require = createRequire(import.meta.url);
const [kind = "nonconf", ...ways] = process.argv.slice(2);

/** Whether the `prepareStackTrace` of the application acts on what it formats */
let armed = false;
Reflect.set(
  Error,
  "prepareStackTrace",
  (error: Error, frames: readonly unknown[]): string => {
    if (armed && kind === "freeze") {
      Object.freeze(error);
      throw new Error("Frozen");
    } else if (armed) {
      try {
        Object.defineProperty(error, "stack", {
          get(): never {
            throw new Error("Its stack cannot be read");
          },
        });
      } catch {
        // E.g. frozen: left as it is
      }
    }
    return [`${error.name}: ${error.message}`, ...frames.map(String)].join(
      "\n    at ",
    );
  },
);

/** A value whose `stack` is a getter of its own (`V`) */
function unsafe(): Error {
  const value = new Error("V");
  Object.defineProperty(value, "stack", {
    configurable: true,
    get(): string {
      return "Error: V (its own getter)";
    },
  });
  return value;
}

/** What a source has been destroyed with */
function described(error: unknown, value: Error): string {
  return error === value
    ? "V"
    : (error as Error | undefined)?.cause === value
      ? "carrier"
      : typeof error === "undefined" || error === null
        ? "none"
        : String((error as Error).message);
}

/** The message of what has been thrown, read safely */
function messageOf(error: unknown): string {
  try {
    return String((error as Error).message);
  } catch {
    return "?";
  }
}

/** A source, its value, and what it records */
interface ISourceOf {
  readonly source: object;
  readonly value: Error;
  readonly destroys: string[];
  readonly threw: string[];
  /** Brings the value (a timer of its own), once the send listens */
  bring(): void;
  /** Whether it is destroyed */
  destroyed(): boolean;
}

/** A chunk that fills the response once the client no longer reads */
const big = Buffer.alloc(1 << 20, 0x61);

/** A stream-like source of its own, which brings its value in its way */
function streamLike(way: string): ISourceOf {
  const value = unsafe();
  const destroys: string[] = [];
  const threw: string[] = [];
  let thrown = false;
  /** Whether it has thrown its value (read by its loop, which it ends) */
  const isThrown = (): boolean => thrown;
  let destroyed = false;
  const throwing = (method: string): void => {
    if (way === method && !thrown) {
      thrown = true;
      armed = true;
      throw value;
    }
  };
  const source = Object.assign(new EventEmitter(), {
    pause(): void {
      throwing("pause");
    },
    resume(): void {
      throwing("resume");
    },
    destroy(error?: unknown): void {
      destroys.push(described(error, value));
      destroyed = true;
    },
  });
  const fire = (event: string, chunk: unknown): void => {
    try {
      source.emit(event, chunk);
    } catch (error: unknown) {
      threw.push(messageOf(error));
    }
  };
  return {
    source,
    value,
    destroys,
    threw,
    bring(): void {
      setTimeout(() => {
        if (way === "emit") {
          armed = true;
          fire("error", value);
        }
        // Until the response is full, and its `pause()` throws
        if (way === "pause") {
          for (let chunk = 0; chunk < 64 && !isThrown(); chunk += 1) {
            fire("data", big);
          }
        }
      }, 10);
    },
    destroyed: (): boolean => destroyed,
  };
}

/** A Node.js `Readable` whose own `pause()` or `resume()` throws its value */
function readable(way: string): ISourceOf {
  const value = unsafe();
  const destroys: string[] = [];
  const threw: string[] = [];
  let thrown = false;
  /** Whether it has thrown its value (read by its loop, which it ends) */
  const isThrown = (): boolean => thrown;
  const source = new Readable({
    read(): void {
      // Pushed by `bring()`
    },
    destroy(error, callback): void {
      if (way !== "redefine") {
        destroys.push(described(error, value));
        callback(error);
        return;
      }
      try {
        Object.defineProperty(error, "stack", {
          configurable: true,
          get(): never {
            throw new Error("Redefined by its _destroy()");
          },
        });
        destroys.push(`${described(error, value)}:redefined`);
      } catch {
        destroys.push(`${described(error, value)}:refused`);
      }
      setImmediate(callback, error);
    },
  });
  const method = way === "redefine" ? "resume" : "pause";
  const original: unknown = Reflect.get(Readable.prototype, method);
  Object.defineProperty(source, method, {
    configurable: true,
    value(this: Readable): Readable {
      if (!thrown) {
        thrown = true;
        armed = true;
        throw value;
      }
      return Reflect.apply(original as () => Readable, this, []);
    },
  });
  return {
    source,
    value,
    destroys,
    threw,
    bring(): void {
      setTimeout(() => {
        // Until the response is full, and its `pause()` throws
        if (way !== "redefine") {
          for (let chunk = 0; chunk < 64 && !isThrown(); chunk += 1) {
            try {
              source.push(big);
            } catch (error: unknown) {
              threw.push(messageOf(error));
            }
          }
        }
      }, 10);
    },
    destroyed: (): boolean => source.destroyed,
  };
}

/** A `PassThrough` of `readable-stream` that the application destroys with its value */
function passThrough(way: string): ISourceOf {
  const { PassThrough } = require(
    way === "rs3" ? "readable-stream-v3" : "readable-stream-v4",
  ) as {
    PassThrough: new () => EventEmitter & {
      destroyed: boolean;
      write(chunk: string): boolean;
      destroy(error?: unknown): unknown;
    };
  };
  const value = unsafe();
  const destroys: string[] = [];
  const threw: string[] = [];
  const source = new PassThrough();
  const destroy = source.destroy.bind(source);
  source.destroy = (error?: unknown): unknown => {
    destroys.push(described(error, value));
    return destroy(error);
  };
  return {
    source,
    value,
    destroys,
    threw,
    bring(): void {
      setTimeout(() => {
        source.write("ab");
        setTimeout(() => {
          armed = true;
          try {
            source.destroy(value);
          } catch (error: unknown) {
            threw.push(messageOf(error));
          }
        }, 10);
      }, 10);
    },
    destroyed: (): boolean => source.destroyed,
  };
}

const sources = new Map<string, ISourceOf>();
const outcomes = new Map<string, string>();
const app = new Binden().use(async (context: Context) => {
  const way = context.url.pathname.slice(1);
  const of = way.startsWith("rs")
    ? passThrough(way)
    : way === "node-pause" || way === "redefine"
      ? readable(way)
      : streamLike(way);
  sources.set(way, of);
  of.bring();
  const outcome = await context.send(of.source as Readable).then(
    () => "resolved",
    (error: unknown) =>
      `rejected:${error === of.value ? "V" : messageOf(error)}`,
  );
  armed = false;
  // A response whose headers are committed is cut (what the client has read
  // of it then depends on the system), otherwise replied
  outcomes.set(
    way,
    `${context.response.headersSent ? "cut" : "replied"} ${outcome}`,
  );
  throw new Error(outcome);
});

const server = app.createServer().listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address() as AddressInfo;

const lines: string[] = [];
for (const way of ways) {
  const socket = connect(port, "127.0.0.1");
  let received = "";
  socket.setEncoding("latin1").on("data", (chunk: string) => {
    received += chunk;
  });
  socket.on("error", () => null);
  const closed = once(socket, "close");
  socket.write(`GET /${way} HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n`);
  if (way === "pause" || way === "node-pause") {
    // The client reads nothing until the send has settled: the response fills
    socket.pause();
  }
  await pollUntil(() => outcomes.has(way));
  socket.resume();
  await closed;
  const of = sources.get(way) as ISourceOf;
  // Its destroy (e.g. a `_destroy()` that calls back on a later turn)
  await pollUntil(() => of.destroyed());
  await new Promise(setImmediate);
  const outcome = String(outcomes.get(way));
  const status = outcome.startsWith("cut")
    ? ""
    : ` ${/^HTTP\/1\.1 (?<code>\d{3})/u.exec(received)?.groups?.code ?? "none"}`;
  lines.push(
    `${kind}:${way} ${outcome}${status} destroys=${of.destroys.join(",")} destroyed=${of.destroyed()} threw=${of.threw.join(",")}`,
  );
}
server.close();
process.stdout.write(`${lines.join("\n")}\n`);
