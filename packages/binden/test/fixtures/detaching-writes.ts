// Run by `detached-views.test.ts`, without a handler of the process: the
// `toString()` of a cookie of the application, which runs inside the write of
// binden that commits the head (after binden has counted the bytes of a view),
// detaches the `ArrayBuffer` that binden's `Buffer` shares (`send`: the view
// given to `send()`; `cl`: the first chunk of a `Readable` of a
// `Content-Length` of 20 bytes; `chunked`: the same without a length), or
// (`shrink`) shrinks the resizable `ArrayBuffer` of a view given to `send()`,
// whose bytes are then out of the bounds of binden's `Buffer`, or (`ending`)
// a view given to `send()` whose `write()` (of a writer of the application)
// gives the bytes to binden, then ends the response inside that write, or
// (`end`, and `end-chunks` for a `Readable` of views) gives them to binden
// by `end()` instead, or (`unreported`, and `unreported-chunks`) replaces the
// response with an empty `406` (whose head detaches the bytes), drops them,
// and calls back the write, without telling binden. The send must reject
// with the `TypeError` of binden, formatted before the application gets it,
// and the connection must be closed before its head is flushed: the
// pipelined request is never answered (its response would be read as the
// body), and the process does not crash. But (`replaced`, a view given to
// `send()`, and `replaced-chunks`, a `Readable` of views) a writer that
// replaces the response in the same way, and reports each write that it
// discards (`kDiscardWrite`), drops them: they are no part of the response,
// the send resolves, and the pipelined request is answered. Prints the
// outcome.
import { type AddressInfo, connect } from "node:net";
import { Binden, type Context, kDiscardWrite } from "../../index.js";
import { HOST } from "../helpers.js";
import type { ILogger } from "@binden/logger";
import { Readable } from "node:stream";
import { once } from "node:events";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 25_000).unref();

const [mode = "send"] = process.argv.slice(2);

/** The errors whose stack V8 has formatted */
const formatted = new WeakSet<object>();
Error.prepareStackTrace = (error: Error): string => {
  formatted.add(error);
  return `${error.name}: ${error.message}`;
};

const silent: ILogger = {
  fatal: () => null,
  error: () => null,
  warn: () => null,
  info: () => null,
  debug: () => null,
  trace: () => null,
  child: () => silent,
};

let outcome: Record<string, unknown> = { send: "pending" };
const app = new Binden({ logger: silent }).use(async (context: Context) => {
  if (context.url.pathname === "/next") {
    await context.send("next");
    return;
  }
  const buffer = new ArrayBuffer(16, { maxByteLength: 32 });
  new Uint8Array(buffer).fill(0x61);
  context.response.cookies.add({
    toString(): string {
      if (mode === "shrink") {
        buffer.resize(8);
      } else if (!buffer.detached) {
        buffer.transfer();
      }
      return "a=b";
    },
  } as never);
  if (mode === "cl") {
    context.response.setHeader("Content-Length", 20);
  } else if (mode === "ending") {
    const { response } = context;
    const write = response.write.bind(response) as (
      ...args: unknown[]
    ) => boolean;
    response.write = (...args: unknown[]): boolean => {
      const accepted = write(...args);
      response.end();
      return accepted;
    };
  } else if (mode.startsWith("end")) {
    const { response } = context;
    response.write = (chunk: unknown, ...args: unknown[]): boolean => {
      response.end(chunk);
      const callback = args.find((arg) => typeof arg === "function");
      if (typeof callback === "function") {
        process.nextTick(callback, null);
      }
      return true;
    };
  } else if (mode.startsWith("replaced") || mode.startsWith("unreported")) {
    const { response } = context;
    response.write = (...args: unknown[]): boolean => {
      if (!response.writableEnded) {
        response.statusCode = 406;
        response.setHeader("Content-Length", 0).end();
      }
      if (mode.startsWith("replaced")) {
        response[kDiscardWrite]();
      }
      const callback = args.find((arg) => typeof arg === "function");
      if (typeof callback === "function") {
        process.nextTick(callback, null);
      }
      return true;
    };
  }
  const data = [
    "send",
    "shrink",
    "ending",
    "end",
    "replaced",
    "unreported",
  ].includes(mode)
    ? new Uint8Array(buffer)
    : Readable.from([new Uint8Array(buffer), Buffer.from("tail")], {
        objectMode: true,
      });
  try {
    await context.response.send(data);
    outcome = { send: "resolved" };
  } catch (error: unknown) {
    outcome = {
      // Before anything reads its stack
      formatted: formatted.has(error as Error),
      send: `${(error as Error).constructor.name}: ${(error as Error).message}`,
      headersSent: context.response.headersSent,
      destroyed: context.response.destroyed,
    };
  }
});
const server = app.createServer().listen(0, HOST);
await once(server, "listening");
const { port } = server.address() as AddressInfo;
const socket = connect(port, HOST);
let received = "";
socket.setEncoding("latin1").on("data", (chunk: string) => {
  received += chunk;
});
socket.on("error", () => {
  // E.g. a reset of the cut response
});
await once(socket, "connect");
socket.write(
  `GET / HTTP/1.1\r\nHost: ${HOST}\r\n\r\nGET /next HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`,
);
await once(socket, "close");
server.close();
process.stdout.write(`${JSON.stringify({ ...outcome, received })}\n`);
