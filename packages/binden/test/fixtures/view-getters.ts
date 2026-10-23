// Run by `view-getters.test.ts`, without a handler of the process: an
// object-mode `Readable` whose chunk is a view with getters of its own, which
// binden never reads (it reads the getters of the engine, and writes a
// `Buffer` of its own). `detaching`: a `Uint8Array` after a valid chunk, whose
// own `byteLength` getter detaches its buffer (Node.js would write the detached
// view as it uncorks the connection on the next tick, out of any call, and
// crash the process); `lying`: a first chunk of a subclass whose `buffer`,
// `byteOffset` and `byteLength` getters lie (a detached `ArrayBuffer`, 99 and
// 99). The send must resolve with the bytes of the views, none of those
// getters read, and the pipelined request must be answered. Prints the
// outcome.
import { type AddressInfo, connect } from "node:net";
import { Binden, type Context } from "../../index.js";
import { HOST } from "../helpers.js";
import { Readable } from "node:stream";
import { once } from "node:events";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 25_000).unref();

const [mode = "detaching"] = process.argv.slice(2);

/** How many times a getter of the application has been read */
let reads = 0;

/** A subclass whose own getters lie about where its bytes are (`lying`) */
class Lying extends Uint8Array {}
Object.defineProperties(Lying.prototype, {
  buffer: {
    get(): ArrayBuffer {
      reads += 1;
      const gone = new ArrayBuffer(8);
      gone.transfer();
      return gone;
    },
  },
  byteOffset: {
    get(): number {
      reads += 1;
      return 99;
    },
  },
  byteLength: {
    get(): number {
      reads += 1;
      return 99;
    },
  },
});

/** The chunks of the source, by the mode */
function chunks(): Uint8Array[] {
  if (mode === "lying") {
    return [new Lying([0x6f, 0x6b])];
  }
  const bytes = new Uint8Array([0x61]);
  Object.defineProperty(bytes, "byteLength", {
    get(): number {
      reads += 1;
      bytes.buffer.transfer();
      return 0;
    },
  });
  return [Buffer.from("start"), bytes];
}

let outcome = "pending";
const app = new Binden().use(async (context: Context) => {
  if (context.url.pathname === "/second") {
    await context.send("second");
    return;
  }
  try {
    await context.send(Readable.from(chunks(), { objectMode: true }));
    outcome = "resolved";
  } catch (error: unknown) {
    outcome = `${(error as Error).constructor.name}: ${(error as Error).message}`;
    throw error;
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
  // E.g. a reset of a cut response
});
await once(socket, "connect");
socket.write(
  `GET / HTTP/1.1\r\nHost: ${HOST}\r\n\r\nGET /second HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`,
);
await once(socket, "close");
server.close();
/** The body of a chunked response, whatever its chunks (Node.js 26 may write two in one) */
function dechunk(text: string): string {
  let body = "";
  let rest = text;
  for (;;) {
    const { groups: { line = "", digits = "" } = {} } =
      /^(?<line>(?<digits>[\da-f]+)\r\n)/u.exec(rest) ?? {};
    const size = Number.parseInt(digits, 16);
    if (!(size > 0)) {
      return body;
    }
    body += rest.slice(line.length, line.length + size);
    rest = rest.slice(line.length + size + 2);
  }
}

const { groups: { first = "", second = "" } = {} } =
  /^HTTP\/1\.1 200 OK\r\n[^]*?\r\n\r\n(?<first>[^]*?)HTTP\/1\.1 200 OK\r\n[^]*?\r\n\r\n(?<second>[^]*)$/u.exec(
    received,
  ) ?? {};
process.stdout.write(
  `${JSON.stringify({ send: outcome, reads, body: dechunk(first), second })}\n`,
);
