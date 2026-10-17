// Run by `pipes.test.ts`: a native pipe or `pipeline()` into a compressed
// response whose head Node.js refuses (its first chunk commits the head) must
// neither crash the process nor be left to a deadline (there is none): the
// middleware that has piped it never settles, and the request gets one `500`.
// `pipeline()` rejects with the original error.
import { type AddressInfo, connect } from "node:net";
import { Binden, type Context } from "binden";
import { Readable, pipeline } from "node:stream";
import { Compression } from "../../index.js";
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
}, 10_000).unref();

const invalid = "bad\n";
const rejected: string[] = [];
const routes: Partial<Record<string, (context: Context) => void>> = {
  "/pipe": ({ response }) => {
    Readable.from(["body"]).pipe(response);
  },
  "/pipeline": ({ response }) => {
    pipeline(Readable.from(["body"]), response, (error) => {
      rejected.push(`pipeline:${(error as { code?: string } | null)?.code}`);
    });
  },
};

const app = new Binden()
  .use(new Compression({ threshold: 0 }))
  .use(async (context: Context) => {
    context.response.type("text/plain");
    context.response.statusMessage = invalid;
    routes[context.url.pathname]?.(context);
    await new Promise(() => {
      // Never settles
    });
  });
const server = app.createServer().listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address() as AddressInfo;

/** The status lines received on a connection, and whether it was closed */
async function exchange(path: string): Promise<string> {
  const socket = connect(port, "127.0.0.1");
  await once(socket, "connect");
  let data = "";
  socket.setEncoding("latin1").on("data", (chunk: string) => {
    data += chunk;
  });
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: localhost\r\nAccept-Encoding: gzip\r\n\r\n`,
  );
  const closed = once(socket, "close").then(() => "closed");
  const state = await Promise.race([
    closed,
    new Promise((resolve) => {
      setTimeout(resolve, 300, "open");
    }),
  ]);
  socket.destroy();
  const statuses = data.match(/HTTP\/1\.1 \d{3}/gu) ?? [];
  return `${statuses.map((line) => line.slice(9)).join("+")}(${String(state)})`;
}

const results: string[] = [];
for (const path of Object.keys(routes)) {
  results.push(await exchange(path));
}
server.close();
process.stdout.write(`${results.join(" ")}\n${rejected.join(" ")}\n`);
