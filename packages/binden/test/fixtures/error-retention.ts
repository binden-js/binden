// Run by `error-retention.test.ts` with `--expose-gc`: an error that binden
// creates and hands over (the reason of an aborted signal, the error that a
// send rejects with or destroys its source with, or the one that fails a
// work) must not keep the response once the application, or a source,
// keeps it. Kinds: `native` (a `PassThrough`, which keeps the error it is
// destroyed with as its `errored`) and `like` (a stream-like source, which
// keeps it as minipass does). Modes: `deadline` (cancelled at the deadline),
// `gone` (the client goes away), `mismatch` (a body shorter than its
// `Content-Length`, which ends: nothing destroys it with the error, whose
// stack Node.js would format) and `refused` (a pipe of a `Proxy`, which fails
// its work). Prints whether the responses are collected, and the names (and
// codes) of the errors that the sources and the application keep.
import { type AddressInfo, connect } from "node:net";
import { Binden, BindenResponse, type Context } from "../../index.js";
import { EventEmitter, once } from "node:events";
import { HOST, capture } from "../helpers.js";
import { PassThrough } from "node:stream";
import { queryObjects } from "node:v8";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 25_000).unref();

const [kind = "like", mode = "deadline"] = process.argv.slice(2);
const requests = 60;

/** A stream-like source that keeps the error it is destroyed with */
class Keeping extends EventEmitter {
  public destroyed = false;
  public kept: unknown = null;

  public pause(): this {
    return this;
  }

  public resume(): this {
    return this;
  }

  public destroy(error?: Error): this {
    this.destroyed = true;
    this.kept = error ?? null;
    return this;
  }
}

/** What the sources and the application keep */
const sources: (Keeping | PassThrough)[] = [];
const errors: unknown[] = [];
/** The error that a source keeps (see `Keeping`) */
function keptBy(source: Keeping | PassThrough): unknown {
  return source instanceof Keeping ? source.kept : source.errored;
}

// Silent: a logger that formatted the errors would format their stacks
const { logger } = capture("silent");
const app = new Binden({
  logger,
  timeout: mode === "deadline" ? 30 : 0,
  error_handler: (context: Context, error: unknown): Promise<void> => {
    errors.push(error);
    return context.response.status(500).send();
  },
}).use(async (context: Context) => {
  const source = kind === "native" ? new PassThrough() : new Keeping();
  sources.push(source);
  const write = (chunk: string, end = false): void => {
    if (source instanceof Keeping) {
      source.emit("data", Buffer.from(chunk));
      if (end) {
        source.emit("end");
      }
    } else if (end) {
      source.end(chunk);
    } else {
      source.write(chunk);
    }
  };
  if (mode === "refused") {
    // Its work fails with the refusal (see the error handler)
    new Proxy(new PassThrough(), {}).pipe(context.response);
    return;
  } else if (mode === "mismatch") {
    context.response.setHeader("Content-Length", 3);
    setImmediate(write, "x", true);
  } else {
    // Its first chunk commits the headers
    setImmediate(write, "x");
  }
  await context.send(source).catch((error: unknown) => {
    errors.push(error);
  });
});

const server = app.createServer();
server.listen(0, HOST);
await once(server, "listening");
const { port } = server.address() as AddressInfo;
/** One request on a connection of its own, which `gone` closes at its first byte */
const request = (): Promise<void> =>
  new Promise((resolve) => {
    const socket = connect(port, HOST);
    socket.on("error", () => {
      // E.g. a reset once the response is cut
    });
    socket.on("data", () => {
      if (mode === "gone") {
        socket.destroy();
      }
    });
    socket.once("close", () => {
      resolve();
    });
    socket.write(
      `GET / HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`,
    );
  });
for (let sent = 0; sent < requests; sent += 10) {
  await Promise.all(Array.from({ length: 10 }, request));
}
server.closeAllConnections();
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
const names = new Set(
  [...sources.map(keptBy), ...errors]
    .filter((error) => error instanceof Error)
    .map((error) => {
      const code: unknown = Reflect.get(error, "code");
      return typeof code === "string" ? `${error.name} ${code}` : error.name;
    }),
);
process.stdout.write(
  `${left < requests / 10 ? "collected" : `kept ${left}`} ${[...names].sort().join(", ")}\n`,
);
