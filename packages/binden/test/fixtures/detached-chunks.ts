// Run by `detached-views.test.ts`, without a handler of the process: an
// object-mode `Readable` whose chunk is a view of a detached `ArrayBuffer`
// (`first`: its first chunk, a `Uint8Array`; `view`: its first chunk, a
// `DataView`; `later`: a `Uint8Array` after a valid chunk) must not crash the
// process (Node.js throws once it writes it, out of any call). The send
// rejects with a `TypeError` of binden: before the headers are committed for a
// first chunk, which the middleware replies to (`500`), and the pipelined
// request is answered; otherwise the response is cut. Prints the outcome.
import { type AddressInfo, connect } from "node:net";
import { Binden, type Context } from "../../index.js";
import { HOST } from "../helpers.js";
import { Readable } from "node:stream";
import { once } from "node:events";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 25_000).unref();

const [mode = "first"] = process.argv.slice(2);

/** A view of a detached `ArrayBuffer` (transferred) */
function detached(): ArrayBufferView {
  const bytes = new Uint8Array(4);
  const view = mode === "view" ? new DataView(bytes.buffer) : bytes;
  bytes.buffer.transfer();
  return view;
}

let outcome: Record<string, unknown> = { send: "pending" };
const app = new Binden().use(async (context: Context) => {
  if (context.url.pathname === "/second") {
    await context.send("second");
    return;
  }
  const source = Readable.from(
    mode === "later" ? [Buffer.from("ok"), detached()] : [detached()],
    { objectMode: true },
  );
  try {
    await context.send(source);
    outcome = { send: "resolved" };
  } catch (error: unknown) {
    const { headersSent } = context.response;
    outcome = {
      send: `${(error as Error).constructor.name}: ${(error as Error).message}`,
      headersSent,
      destroyed: source.destroyed,
    };
    if (!headersSent) {
      await context.response.status(500).send("replied");
    }
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
  `GET / HTTP/1.1\r\nHost: ${HOST}\r\n\r\nGET /second HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`,
);
await once(socket, "close");
server.close();
process.stdout.write(
  `${JSON.stringify({
    ...outcome,
    replies: received.match(/HTTP\/1\.1 \d{3}|second/gu),
  })}\n`,
);
