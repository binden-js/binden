// Run by `kept-destroy-errors.test.ts` with `--expose-gc`: a stream-like
// source that keeps the error that it is destroyed with (as minipass 7 keeps
// the error that it has emitted), which the application keeps, must not keep
// the request nor the response of a send that binden releases: the error
// that binden destroys it with has its stack formatted, which then holds
// none of the objects of its frames. Modes: `gone` (the client goes away
// once it has the head), `deadline` (once the head is sent), and `writer`
// (another writer ends the response). Prints how many of the requests and
// of the responses are still alive once collected, how many sends have
// settled, and how many sources keep an error.
import { type AddressInfo, connect } from "node:net";
import { Binden, type Context } from "../../index.js";
import { EventEmitter, once } from "node:events";
import { capture } from "../helpers.js";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 25_000).unref();

/** A stream-like source that keeps the error that it is destroyed with, and emits it */
class Keeping extends EventEmitter {
  public kept: unknown = null;

  public destroyed = false;

  public pause(): this {
    return this;
  }

  public resume(): this {
    return this;
  }

  public destroy(error?: unknown): this {
    this.destroyed = true;
    this.kept = error ?? null;
    if (typeof error !== "undefined") {
      this.emit("error", error);
    }
    return this;
  }
}

const [how = "gone"] = process.argv.slice(2);
const requests = 30;
const sources: Keeping[] = [];
const references: WeakRef<object>[] = [];
let settled = 0;
// The report of the guards logs through it
const { logger } = capture();
const app = new Binden({ logger, timeout: how === "deadline" ? 30 : 0 }).use(
  async (context: Context) => {
    const source = new Keeping();
    sources.push(source);
    references.push(
      new WeakRef(context.request),
      new WeakRef(context.response),
    );
    // The head is sent with its first chunk
    setImmediate(() => {
      source.emit("data", Buffer.from("x"));
    });
    if (how === "writer") {
      setTimeout(() => {
        context.response.end();
      }, 5);
    }
    await context.send(source).catch(() => null);
    settled += 1;
  },
);

const server = app.createServer();
server.listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address() as AddressInfo;
await Promise.all(
  Array.from(
    { length: requests },
    () =>
      new Promise<void>((resolve) => {
        const socket = connect(port, "127.0.0.1");
        socket.on("error", () => null);
        socket.on("data", () => {
          if (how === "gone") {
            socket.destroy();
          }
        });
        socket.once("close", () => {
          resolve();
        });
        socket.write("GET / HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n");
      }),
  ),
);
/** Whether every send has settled (they settle once their responses close) */
const allSettled = (): boolean => settled === requests;
for (let turn = 0; turn < 200 && !allSettled(); turn += 1) {
  await new Promise((resolve) => {
    setTimeout(resolve, 10);
  });
}
server.close();
await once(server, "close");
const gc = Reflect.get(globalThis, "gc") as () => void;
for (let round = 0; round < 6; round += 1) {
  await new Promise((resolve) => {
    setTimeout(resolve, 5);
  });
  gc();
}
const alive = references.filter((reference) => reference.deref()).length;
const kept = sources.filter(({ kept: error }) => error instanceof Error).length;
process.stdout.write(
  `${JSON.stringify({ alive, settled, kept, sources: sources.length })}\n`,
);
