// Run by `process.test.ts`: a string in an encoding whose length Node.js only
// estimates (`hex`, `base64` and `base64url`, in any case) is written as the
// bytes that `Buffer.from()` decodes, and framed by them: an odd number of hex
// digits (Node.js 24 aborts the process when it writes one to a socket, e.g.
// as it flushes a corked socket or a response queued behind another), an
// invalid string (Node.js would declare more bytes than it writes), and a
// string that decodes to nothing. Each response is parsed strictly, and the
// next response of the connection must be read as such. Prints the number of
// exchanges that are as expected, and every other one.
import { type AddressInfo, connect } from "node:net";
import { type IncomingMessage, createServer } from "node:http";
import { BindenResponse } from "../../index.js";
import { once } from "node:events";

for (const event of ["unhandledRejection", "uncaughtException"]) {
  process.on(event, (error: unknown) => {
    process.stderr.write(`${event} ${String(error)}\n`);
    process.exit(1);
  });
}
setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 20_000).unref();

/** A reply, and the body that the client must read */
type ICase = [reply: (response: BindenResponse) => unknown, body: string];

const cases: Record<string, ICase> = {
  "end(odd hex)": [(r): unknown => r.end("68692", "hex"), "hi"],
  "write(odd hex) + end()": [
    (r): void => {
      r.write("68692", "hex");
      r.end();
    },
    "hi",
  ],
  // Empty: `Content-Length: 0`
  "end(invalid hex)": [(r): unknown => r.end("zz", "hex"), ""],
  // An empty chunk is not framed as a chunk of one byte
  "write(invalid hex) + end(hex)": [
    (r): void => {
      r.write("zz", "hex");
      r.end("6869", "hex");
    },
    "hi",
  ],
  "end(invalid base64)": [(r): unknown => r.end("aGk!!!", "base64"), "hi"],
  "end(base64url)": [(r): unknown => r.end("aGk", "base64url"), "hi"],
  "end(invalid base64url)": [
    (r): unknown => r.end("aGk!!!", "base64url"),
    "hi",
  ],
  "upper-case encodings": [
    (r): void => {
      r.write("zz", "HEX" as BufferEncoding);
      r.write("aGk!!!", "BASE64" as BufferEncoding);
      r.end("aGk!!!", "Base64Url" as BufferEncoding);
    },
    "hihi",
  ],
  // Never replaced: checked against the bytes written
  "a strict Content-Length, several writes": [
    (r): void => {
      r.strictContentLength = true;
      r.setHeader("Content-Length", 4);
      r.write("6869", "hex");
      r.write("zz", "hex");
      r.end("68692", "hex");
    },
    "hihi",
  ],
  // Written together (`writev()` of the socket)
  "corked writes": [
    (r): void => {
      r.cork();
      r.write("68692", "hex");
      r.write("aGk!!!", "base64");
      r.write("616", "hex");
      r.uncork();
      r.end();
    },
    "hihia",
  ],
};

/**
 * A response at the start of `data`, framed strictly (by its
 * `Content-Length`, or by chunks), and the data after it; `null` when it is
 * not one
 */
function parse(data: Buffer): { body: string; rest: Buffer } | null {
  const end = data.indexOf("\r\n\r\n");
  if (end === -1) {
    return null;
  }
  const head = data.subarray(0, end).toString("latin1").split("\r\n");
  const fields = new Map(
    head.slice(1).map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
    }),
  );
  let rest = data.subarray(end + 4);
  const length = fields.get("content-length");
  if (typeof length !== "undefined") {
    const size = Number(length);
    return rest.length < size
      ? null
      : {
          body: rest.subarray(0, size).toString("latin1"),
          rest: rest.subarray(size),
        };
  } else if (fields.get("transfer-encoding") !== "chunked") {
    return null;
  }
  let body = "";
  for (;;) {
    const line = rest.indexOf("\r\n");
    const size = Number.parseInt(rest.subarray(0, line).toString(), 16);
    const chunk = rest.subarray(line + 2, line + 2 + size);
    if (
      line === -1 ||
      !Number.isSafeInteger(size) ||
      chunk.length !== size ||
      rest.subarray(line + 2 + size, line + 4 + size).toString() !== "\r\n"
    ) {
      return null;
    }
    body += chunk.toString("latin1");
    rest = rest.subarray(line + 4 + size);
    if (size === 0) {
      return { body, rest };
    }
  }
}

const server = createServer(
  { ServerResponse: BindenResponse },
  (request: IncomingMessage, response: BindenResponse) => {
    const [, name = "", mode = ""] = (request.url ?? "/").split("/");
    if (name === "first") {
      // The response after it is queued until then
      setTimeout(() => {
        response.end("first");
      }, 20);
      return;
    } else if (name === "next") {
      response.end("next");
      return;
    } else if (mode === "hints") {
      response.writeEarlyHints({ link: "</a.css>; rel=preload" });
    }
    const [reply] = cases[decodeURIComponent(name)];
    try {
      reply(response);
    } catch (error: unknown) {
      // A failure of the case (e.g. a length that Node.js finds wrong)
      process.stdout.write(`${name}: ${String(error)}\n`);
      response.destroy();
    }
  },
);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address() as AddressInfo;

/**
 * The responses of one connection, until the server closes it (or half a second
 * has passed, e.g. once a response has declared more bytes than it has sent)
 */
async function exchange(requests: string): Promise<Buffer> {
  const socket = connect(port, "127.0.0.1");
  await once(socket, "connect");
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  socket.write(requests);
  await Promise.race([
    once(socket, "close"),
    new Promise((resolve) => {
      setTimeout(resolve, 500);
    }),
  ]);
  socket.destroy();
  return Buffer.concat(chunks);
}

const get = (path: string, last = false): string =>
  `GET ${path} HTTP/1.1\r\nHost: a\r\n${last ? "Connection: close\r\n" : ""}\r\n`;
const failures: string[] = [];
let passed = 0;
// Alone, queued behind another response, and after early hints, queued
for (const mode of ["alone", "queued", "hints"]) {
  for (const [name, [, expected]] of Object.entries(cases)) {
    const path = `/${encodeURIComponent(name)}/${mode}`;
    const data = await exchange(
      (mode === "alone" ? "" : get("/first")) + get(path) + get("/next", true),
    );
    // The response before it, and its early hints
    const first = mode === "alone" ? null : parse(data);
    let rest = first?.rest ?? data;
    const hints = "HTTP/1.1 103 Early Hints\r\n";
    if (
      mode === "hints" &&
      rest.subarray(0, hints.length).toString() === hints
    ) {
      rest = rest.subarray(rest.indexOf("\r\n\r\n") + 4);
    }
    const reply = parse(rest);
    const next = reply === null ? null : parse(reply.rest);
    if (
      (mode === "alone" || first?.body === "first") &&
      rest.subarray(0, 9).toString() === "HTTP/1.1 " &&
      reply?.body === expected &&
      next?.body === "next" &&
      next.rest.length === 0
    ) {
      passed += 1;
    } else {
      failures.push(
        `${name} (${mode}): ${JSON.stringify(data.toString("latin1"))}`,
      );
    }
  }
}
process.stdout.write(`${[passed, ...failures].join("\n")}\n`);
server.close();
