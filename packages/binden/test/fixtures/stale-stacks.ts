// Run by `stale-stacks.test.ts`, without a handler of the process: a
// stream-like source whose value (an error that it emits, `emit`, or that its
// `pause()` throws once the response is full, `pause`, or its `resume()`,
// `resume`) reads safely when binden checks it, but whose `stack` code of the
// application redefines as a getter that throws before Node.js reads it again:
// a getter of its `name`, which V8 reads while it formats the stack (`name`),
// a `prepareStackTrace` of the application (`pst`), a getter of the state of
// a writable that Node.js reads on a `Readable` as it destroys it, before it
// reads the stack (`proto`), or the `destroy()` of the source, given that value
// (`redefine`). The send must reject with that value at once, destroy the
// source once, throw nothing into its events (`threw=`), and leave its guard,
// so that a later error of the source is logged. Prints, for the kind (the
// first argument) and each way (the other ones), the status, how the send has
// settled, what the source has been destroyed with (the value, `V`, its
// carrier, `carrier`, or nothing, `none`), what its events have thrown, and
// the late errors logged.
import { type AddressInfo, connect } from "node:net";
import { Binden, type Context, releasedFailure } from "../../index.js";
import { EventEmitter, once } from "node:events";
import { capture, pollUntil } from "../helpers.js";
import { Readable } from "node:stream";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 20_000).unref();

const [kind = "name", ...ways] = process.argv.slice(2);

/** Redefines the `stack` of an error as a getter that throws */
function unstack(error: Error): void {
  Object.defineProperty(error, "stack", {
    configurable: true,
    get(): never {
      throw new Error("Its stack has been redefined");
    },
  });
}

/** The errors whose stack a `prepareStackTrace` of the application redefines (`pst`) */
const marked = new WeakSet<Error>();
if (kind === "pst") {
  Reflect.set(
    Error,
    "prepareStackTrace",
    (error: Error, frames: readonly unknown[]): string => {
      if (marked.has(error)) {
        unstack(error);
      }
      return [`${error.name}: ${error.message}`, ...frames.map(String)].join(
        "\n    at ",
      );
    },
  );
}

/** The value of a source, by the kind */
function valueOf(): Error {
  const value = new Error("V");
  if (kind === "name") {
    Object.defineProperty(value, "name", {
      configurable: true,
      get(): string {
        unstack(value);
        return "Error";
      },
    });
  } else if (kind === "pst") {
    marked.add(value);
  }
  return value;
}

/**
 * Before the value is brought (`proto`): the next read of the state of a
 * writable on a `Readable` (Node.js reads it as it destroys one, before it
 * reads the stack) redefines its `stack`, once
 */
function arm(value: Error): void {
  if (kind === "proto") {
    Object.defineProperty(Readable.prototype, "_writableState", {
      configurable: true,
      get(): void {
        Reflect.deleteProperty(Readable.prototype, "_writableState");
        unstack(value);
      },
      // A duplex created meanwhile (none is) has its own
      set(this: object, state: unknown): void {
        Object.defineProperty(this, "_writableState", {
          configurable: true,
          enumerable: true,
          value: state,
          writable: true,
        });
      },
    });
  }
}

/** A stream-like source of its own that brings its value in its way */
class Source extends EventEmitter {
  readonly #way: string;
  public readonly value = valueOf();
  /** What it has been destroyed with */
  public readonly destroys: string[] = [];
  /** What its events have thrown into the code that emits them */
  public readonly threw: unknown[] = [];
  #thrown = false;

  public constructor(way: string) {
    super();
    this.#way = way;
  }

  public pause(): this {
    return this.#bring("pause");
  }

  public resume(): this {
    return this.#bring("resume");
  }

  public destroy(error?: Error): this {
    const { value } = this;
    this.destroys.push(
      error === value
        ? "V"
        : error?.cause === value
          ? "carrier"
          : (error?.message ?? "none"),
    );
    if (kind === "redefine" && typeof error !== "undefined") {
      unstack(error);
    }
    return this;
  }

  /** Emits an event, recording what it throws */
  public fire(event: string, value: unknown): void {
    if (value === this.value) {
      arm(this.value);
    }
    try {
      this.emit(event, value);
    } catch (error: unknown) {
      this.threw.push(error);
    }
  }

  /** Throws its value once, from the method of its way */
  #bring(method: string): this {
    if (this.#way === method && !this.#thrown) {
      this.#thrown = true;
      arm(this.value);
      throw this.value;
    }
    return this;
  }
}

const sources = new Map<string, Source>();
const outcomes = new Map<string, string>();
const captured = capture();
const app = new Binden({
  logger: captured.logger,
  log_error_details: true,
}).use(async (context: Context) => {
  const way = context.url.pathname.slice(1);
  const source = new Source(way);
  sources.set(way, source);
  // Until the response is full, and the readable of the send
  let chunks = 0;
  const timer = setInterval(() => {
    chunks += 1;
    if (way === "emit") {
      clearInterval(timer);
      source.fire("error", source.value);
    } else if (way !== "pause" || chunks > 2000) {
      clearInterval(timer);
    } else {
      source.fire("data", Buffer.alloc(65_536, 0x61));
    }
  }, 1);
  const outcome = await context.send(source).then(
    () => "resolved",
    (error: unknown) =>
      `rejected:${error === source.value ? "V" : (error as Error).message}`,
  );
  clearInterval(timer);
  outcomes.set(way, outcome);
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
  if (way === "pause") {
    // The client reads nothing until the send has settled: the response fills
    socket.pause();
  }
  await pollUntil(() => outcomes.has(way));
  socket.resume();
  await closed;
  const source = sources.get(way) as Source;
  const before = captured.records.length;
  source.fire("error", new Error("Later"));
  // Reported on a later turn
  await new Promise(setImmediate);
  const late = captured.records
    .slice(before)
    .filter(({ msg }) => msg === releasedFailure)
    .map(({ failure }) => (failure as { message?: unknown }).message);
  const status = /^HTTP\/1\.1 (?<code>\d{3})/u.exec(received)?.groups?.code;
  const threw = source.threw.map((error) => (error as Error).message);
  lines.push(
    `${kind}:${way} ${status ?? "none"} ${outcomes.get(way)} destroys=${source.destroys.join(",")} threw=${threw.join(",")} late=${late.join(",")}`,
  );
}
server.close();
process.stdout.write(`${lines.join("\n")}\n`);
