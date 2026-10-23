// Run by `process.test.ts`, without a handler of the process: the `filter`
// of the compression, which runs inside the write of binden that decides the
// representation (after binden has counted the bytes of a view), detaches the
// `ArrayBuffer` that binden's `Buffer` shares, unless `keep`. Modes:
// `<send|chunks> <threshold|406> <detach|keep> [ending|end]`: a view given to
// `send()`, or an object-mode `Readable` of views; `0` compresses, `100000`
// sends the body as it is, `406` is a request that accepts no representation
// (the write replaces the response with an empty `406`, and so ends it);
// `ending` installs a writer of the application that ends the response
// inside each write, once the compression has taken it (e.g. the compressor
// has accepted its bytes), and `end` one that gives the chunk of each write
// to `end()` instead. The pipelined request is answered only by a
// connection that is still in sync. Prints the outcome of the send and the
// status lines that the client gets.
import { type AddressInfo, connect } from "node:net";
import { Binden, type Context } from "binden";
import { Compression } from "../../index.js";
import { Logger } from "@binden/logger";
import { Readable } from "node:stream";
import { once } from "node:events";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 25_000).unref();

const [mode = "send", decision = "0", detach = "detach", ending = ""] =
  process.argv.slice(2);

/** The errors whose stack V8 has formatted */
const formatted = new WeakSet<object>();
Error.prepareStackTrace = (error: Error): string => {
  formatted.add(error);
  return `${error.name}: ${error.message}`;
};

/** The memory of the body of the first request, which the `filter` detaches */
let victim: ArrayBuffer | null = null;
let outcome = "pending";
const app = new Binden({ logger: new Logger({ level: "silent" }) })
  .use(
    new Compression({
      threshold: decision === "100000" ? 100_000 : 0,
      filter: (context: Context): boolean => {
        if (
          detach === "detach" &&
          context.url.pathname === "/" &&
          victim?.detached === false
        ) {
          victim.transfer();
        }
        return true;
      },
    }),
  )
  .use(async (context: Context) => {
    if (context.url.pathname === "/next") {
      await context.send("next");
      return;
    }
    const { response } = context;
    response.setHeader("Content-Type", "text/plain");
    if (ending === "ending") {
      const write = response.write.bind(response) as (
        ...args: unknown[]
      ) => boolean;
      response.write = (...args: unknown[]): boolean => {
        const accepted = write(...args);
        response.end();
        return accepted;
      };
    } else if (ending === "end") {
      response.write = (chunk: unknown, ...args: unknown[]): boolean => {
        response.end(chunk);
        const callback = args.find((arg) => typeof arg === "function");
        if (typeof callback === "function") {
          process.nextTick(callback, null);
        }
        return true;
      };
    }
    victim = new ArrayBuffer(4096);
    new Uint8Array(victim).fill(0x61);
    const data =
      mode === "send"
        ? new Uint8Array(victim)
        : Readable.from([new Uint8Array(victim), new Uint8Array(8)], {
            objectMode: true,
          });
    try {
      await response.send(data);
      outcome = "resolved";
    } catch (error: unknown) {
      // Before anything reads its stack
      const kept = formatted.has(error as Error) ? "formatted" : "unformatted";
      outcome = `${(error as Error).message} (${kept})`;
    }
  });
const server = app.createServer().listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address() as AddressInfo;
const socket = connect(port, "127.0.0.1");
let received = "";
socket.setEncoding("latin1").on("data", (chunk: string) => {
  received += chunk;
});
socket.on("error", () => {
  // E.g. a reset of the cut response
});
await once(socket, "connect");
const accepted = decision === "406" ? "identity;q=0" : "gzip";
socket.write(
  `GET / HTTP/1.1\r\nHost: localhost\r\nAccept-Encoding: ${accepted}\r\n\r\nGET /next HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
);
await once(socket, "close");
server.close();
const replies = received.match(/HTTP\/1\.1 \d{3}|next$/gu) ?? [];
process.stdout.write(`${outcome} | ${replies.join(" ")}\n`);
