// Run by `encodings.test.ts`: a `hex` string of an odd length (or with
// invalid digits) written through a compression, as it is (queued behind a
// pipelined response, in chunks, by its length) and compressed. Node.js 24
// aborts the process on an odd length that reaches the socket as a string
// (`StringBytes::StorageSize`), and every version frames an invalid string
// by more bytes than it writes: each response must be framed by its bytes,
// so that the pipelined responses that follow it are read as they are sent.
import { type AddressInfo, connect } from "node:net";
import { Binden, type Context } from "binden";
import { Compression } from "../../index.js";
import { Logger } from "@binden/logger";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import zlib from "node:zlib";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 10_000).unref();

const app = new Binden({ logger: new Logger({ level: "silent" }) }).use(
  new Compression({ format: "gzip", threshold: 0 }),
  async (context: Context) => {
    const { response } = context;
    context.done = true;
    response.type("text/plain");
    const { pathname } = context.url;
    if (pathname === "/slow") {
      // The responses after it are queued until it has ended
      await sleep(50);
      response.end("slow");
    } else if (pathname === "/end" || pathname === "/gzip") {
      response.end("68692", "hex");
    } else if (pathname === "/write") {
      response.write("68692", "hex");
      response.end("68692", "hex");
    } else if (pathname === "/invalid") {
      response.end("6869zz", "hex");
    } else {
      response.end("small");
    }
  },
);
const server = app.createServer().listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address() as AddressInfo;

const requests = [
  ["/slow", "identity"],
  ["/end", "identity"],
  ["/write", "identity"],
  ["/invalid", "identity"],
  ["/gzip", "gzip"],
  ["/small", "identity"],
] as const;
const socket = connect(port, "127.0.0.1");
const chunks: Buffer[] = [];
socket.on("data", (chunk: Buffer) => chunks.push(chunk));
socket.write(
  requests
    .map(
      ([path, accept], index) =>
        `GET ${path} HTTP/1.1\r\nHost: localhost\r\nAccept-Encoding: ${accept}\r\n${index === requests.length - 1 ? "Connection: close\r\n" : ""}\r\n`,
    )
    .join(""),
);
await once(socket, "close");
server.close();

// Each response by its framing: its `Content-Length`, or its chunks
let rest = Buffer.concat(chunks);
const lines: string[] = [];
while (rest.length > 0) {
  const end = rest.indexOf("\r\n\r\n");
  if (end === -1) {
    lines.push(`Not a response: ${JSON.stringify(rest.toString("latin1"))}`);
    break;
  }
  const head = rest.subarray(0, end).toString("latin1").toLowerCase();
  rest = rest.subarray(end + 4);
  const status = head.slice(9, 12);
  const coding = /\r\ncontent-encoding: (?<coding>\S+)/u.exec(head)?.groups
    ?.coding;
  const length = /\r\ncontent-length: (?<length>\d+)/u.exec(head)?.groups
    ?.length;
  const parts: Buffer[] = [];
  if (typeof length === "undefined") {
    for (;;) {
      const index = rest.indexOf("\r\n");
      const size = Number.parseInt(rest.subarray(0, index).toString(), 16);
      if (index === -1 || Number.isNaN(size)) {
        // Not a chunk: what follows is not read
        rest = Buffer.alloc(0);
        break;
      }
      rest = rest.subarray(index + 2);
      if (size === 0) {
        rest = rest.subarray(2);
        break;
      }
      parts.push(rest.subarray(0, size));
      rest = rest.subarray(size + 2);
    }
  } else {
    parts.push(rest.subarray(0, Number(length)));
    rest = rest.subarray(Number(length));
  }
  const body = Buffer.concat(parts);
  const decoded = coding === "gzip" ? zlib.gunzipSync(body) : body;
  lines.push(
    `${status} ${typeof coding === "string" ? `${coding} ` : ""}${decoded.toString()}`,
  );
}
process.stdout.write(`${lines.join("\n")}\n`);
