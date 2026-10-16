// Run by `process.test.ts`: a native pipe or `pipeline()` into the response
// whose write or end throws (a head that Node.js refuses, a chunk that is not
// bytes) must neither crash the process nor be left to a deadline (there is
// none): the middleware that has piped it never settles, and the request gets
// one `500` before the headers are sent, its connection closed afterwards.
// `pipeline()` rejects with the original error.
import { type AddressInfo, connect } from "node:net";
import { Binden, type Context } from "../../index.js";
import { Readable, pipeline } from "node:stream";
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
const never = (): Promise<void> =>
  new Promise(() => {
    // Never settles
  });
/** The codes of the errors that `pipeline()` has called back with, by route */
const rejected: string[] = [];
function track(route: string): (error: unknown) => void {
  return (error) => {
    rejected.push(`${route}:${(error as { code?: string } | null)?.code}`);
  };
}

const routes: Partial<Record<string, (context: Context) => unknown>> = {
  "/pipe": ({ response }) => {
    response.statusMessage = invalid;
    Readable.from(["body"]).pipe(response);
  },
  "/pipeline": ({ response }) => {
    response.statusMessage = invalid;
    pipeline(Readable.from(["body"]), response, track("pipeline"));
  },
  "/trailer-pipe": ({ response }) => {
    response.setHeader("Trailer", "X-T");
    response.setHeader("Content-Length", "4");
    Readable.from(["body"]).pipe(response);
  },
  // Its end (`end()` of the pipe) commits the head
  "/empty-pipe": ({ response }) => {
    response.statusMessage = invalid;
    Readable.from([]).pipe(response);
  },
  "/empty-pipeline": ({ response }) => {
    response.statusMessage = invalid;
    pipeline(Readable.from([]), response, track("empty-pipeline"));
  },
  // A chunk that is not bytes, once the headers are sent
  "/committed": ({ response }) => {
    response.flushHeaders();
    Readable.from([42]).pipe(response);
  },
  "/committed-pipeline": ({ response }) => {
    response.flushHeaders();
    pipeline(Readable.from([42]), response, track("committed-pipeline"));
  },
};

const app = new Binden().use(async (context: Context) => {
  routes[context.url.pathname]?.(context);
  await never();
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
  socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`);
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
process.stdout.write(`${results.join(" ")}\n${rejected.sort().join(" ")}\n`);
