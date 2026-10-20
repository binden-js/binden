// Run by `stream-like-release-failures.test.ts`, without a handler of the
// process: code of a stream-like source that throws an object whose `stack`
// getter throws (which Node.js reads once a stream is destroyed with it),
// once its listeners are added (`/setup`) or in its `pause()` once the
// response is full (`/pause`), must reject the send, release its listeners,
// and leave its guard, so that a later error of the source is logged and
// does not crash the process. Prints, by path, the status, how the send has
// settled, and the late errors logged.
import { type AddressInfo, connect } from "node:net";
import { Binden, type Context, releasedFailure } from "../../index.js";
import { EventEmitter, once } from "node:events";
import { capture, pollUntil } from "../helpers.js";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 20_000).unref();

/** An error whose `stack` getter throws */
function unstackable(): Error {
  const error = new Error("Unstackable");
  Object.defineProperty(error, "stack", {
    get(): never {
      throw new Error("Its stack cannot be read");
    },
  });
  return error;
}

/** A stream-like source of its own whose code throws an unstackable error */
class Source extends EventEmitter {
  /** Where its code throws: `/setup` or `/pause` */
  readonly #where: string;

  public constructor(where: string) {
    super();
    this.#where = where;
  }

  public override on(
    event: string,
    listener: (...args: unknown[]) => void,
  ): this {
    if (this.#where === "/setup" && event === "end") {
      throw unstackable();
    }
    return super.on(event, listener);
  }

  public pause(): this {
    if (this.#where === "/pause") {
      throw unstackable();
    }
    return this;
  }

  public resume(): this {
    return this;
  }

  public destroy(): this {
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
  const { pathname } = context.url;
  const source = new Source(pathname);
  sources.set(pathname, source);
  // Until the response is full, and then the readable of the send
  let chunks = 0;
  const timer = setInterval(() => {
    chunks += 1;
    if (pathname !== "/pause" || chunks > 2000) {
      clearInterval(timer);
    } else {
      source.emit("data", Buffer.alloc(65_536, 0x61));
    }
  }, 1);
  const outcome = await context.send(source).then(
    () => "resolved",
    (error: unknown) => `rejected:${(error as Error).message}`,
  );
  clearInterval(timer);
  outcomes.set(pathname, outcome);
  throw new Error(outcome);
});

const server = app.createServer().listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address() as AddressInfo;

const lines: string[] = [];
for (const path of ["/setup", "/pause"]) {
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
  lines.push(
    `${path} ${status ?? "none"} ${outcomes.get(path)} late=${late.join(",")}`,
  );
}
server.close();
process.stdout.write(`${lines.join("\n")}\n`);
