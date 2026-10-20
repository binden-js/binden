// Run by `stream-like-release-failures.test.ts` and `stream-like-safe-stacks.test.ts`,
// without a handler of the process: code of a stream-like source that throws
// a value whose `stack` Node.js cannot read safely (which it reads once a
// stream is destroyed with it, and again once that stream has called back):
// a `stack` getter that throws, once its listeners are added (`/setup`) or in
// its `pause()` once the response is full (`/pause`), or a getter that
// returns a string on its first read and throws on the second, emitted
// (`/emit-once`) or thrown by its `pause()` (`/pause-once`), or an error that
// it emits (`/pst-emit`), or a chunk that is not bytes (`/pst-chunk`), while
// a `prepareStackTrace` of the application throws, must reject the send (with
// that value: `original`), release its listeners, throw nothing into its
// events (`threw=`), and leave its guard, so that a later error of the source
// is logged and does not crash the process. Prints, by path (the arguments,
// `/setup` and `/pause` by default), the status, how the send has settled,
// what its events have thrown, and the late errors logged.
import { type AddressInfo, connect } from "node:net";
import { Binden, type Context, releasedFailure } from "../../index.js";
import { EventEmitter, once } from "node:events";
import { capture, pollUntil } from "../helpers.js";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 20_000).unref();

/** An error whose `stack` getter throws, from its first read or its second */
function unstackable(first = true): Error {
  const error = new Error("Unstackable");
  let reads = 0;
  Object.defineProperty(error, "stack", {
    get(): string {
      reads += 1;
      if (first || reads > 1) {
        throw new Error("Its stack cannot be read");
      }
      return "Error: Unstackable";
    },
  });
  return error;
}

/** Whether the `prepareStackTrace` of the application throws */
let failing = false;
const formatter: unknown = Reflect.get(Error, "prepareStackTrace");
Reflect.set(
  Error,
  "prepareStackTrace",
  (error: Error, frames: readonly unknown[]): unknown => {
    if (failing) {
      throw new Error("The stack cannot be formatted");
    }
    return typeof formatter === "function"
      ? Reflect.apply(formatter, Error, [error, frames])
      : [`${error.name}: ${error.message}`, ...frames.map(String)].join(
          "\n    at ",
        );
  },
);

/** A stream-like source of its own whose code throws, or that fails, by its path */
class Source extends EventEmitter {
  /** Where its code throws (see the paths above) */
  readonly #where: string;
  /** What it throws, or emits */
  public readonly thrown: unknown;
  /** What its events have thrown into the code that emits them */
  public readonly threw: unknown[] = [];

  public constructor(where: string) {
    super();
    this.#where = where;
    this.thrown = where.startsWith("/pst")
      ? new Error("Failed")
      : unstackable(!where.endsWith("-once"));
  }

  public override on(
    event: string,
    listener: (...args: unknown[]) => void,
  ): this {
    if (this.#where === "/setup" && event === "end") {
      throw this.thrown;
    }
    return super.on(event, listener);
  }

  public pause(): this {
    if (this.#where.startsWith("/pause")) {
      throw this.thrown;
    }
    return this;
  }

  public resume(): this {
    return this;
  }

  public destroy(): this {
    return this;
  }

  /** Emits an event, recording what it throws (`failing`: while a `prepareStackTrace` throws) */
  public fire(event: string, value: unknown, failed = false): void {
    failing = failed;
    try {
      this.emit(event, value);
    } catch (error: unknown) {
      this.threw.push(error);
    } finally {
      failing = false;
    }
  }
}

const sources = new Map<string, Source>();
const outcomes = new Map<string, string>();
const captured = capture();
const app = new Binden({
  logger: captured.logger,
  log_error_details: true,
}).use(async (context: Context) => {
  const { pathname } = context.url;
  const source = new Source(pathname);
  sources.set(pathname, source);
  // Until the response is full, and then the readable of the send
  let chunks = 0;
  const timer = setInterval(() => {
    chunks += 1;
    if (pathname === "/emit-once") {
      clearInterval(timer);
      source.fire("error", source.thrown);
    } else if (pathname === "/pst-emit") {
      clearInterval(timer);
      source.fire("error", source.thrown, true);
    } else if (pathname === "/pst-chunk") {
      clearInterval(timer);
      source.fire("data", null, true);
    } else if (!pathname.startsWith("/pause") || chunks > 2000) {
      clearInterval(timer);
    } else {
      source.fire("data", Buffer.alloc(65_536, 0x61));
    }
  }, 1);
  const outcome = await context.send(source).then(
    () => "resolved",
    (error: unknown) =>
      `rejected:${error === source.thrown ? "original" : (error as Error).message}`,
  );
  clearInterval(timer);
  outcomes.set(pathname, outcome);
  throw new Error(outcome);
});

const server = app.createServer().listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address() as AddressInfo;

const lines: string[] = [];
const paths = process.argv.slice(2);
for (const path of paths.length === 0 ? ["/setup", "/pause"] : paths) {
  const socket = connect(port, "127.0.0.1");
  let received = "";
  socket.setEncoding("latin1").on("data", (chunk: string) => {
    received += chunk;
  });
  socket.on("error", () => null);
  socket.write(`GET ${path} HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n`);
  // The client reads nothing until the send has settled: the response fills
  socket.pause();
  await pollUntil(() => outcomes.has(path));
  socket.resume();
  await once(socket, "close");
  const source = sources.get(path) as Source;
  const before = captured.records.length;
  source.emit("error", new Error("Later"));
  // Reported on a later turn
  await new Promise(setImmediate);
  const late = captured.records
    .slice(before)
    .filter(({ msg }) => msg === releasedFailure)
    .map(({ failure }) => (failure as { message?: unknown }).message);
  const status = /^HTTP\/1\.1 (?<code>\d{3})/u.exec(received)?.groups?.code;
  const threw = source.threw.map((error) => (error as Error).message);
  lines.push(
    `${path} ${status ?? "none"} ${outcomes.get(path)} threw=${threw.join(",")} late=${late.join(",")}`,
  );
}
server.close();
process.stdout.write(`${lines.join("\n")}\n`);
