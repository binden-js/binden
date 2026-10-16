// Run by `retention.test.ts` with `--expose-gc`: 100 clients each pipeline a
// long-lived `/events` (without a deadline) and a `/small` that ends its
// reply at once, which waits for `/events` while its deadline passes (it is
// sealed), then go away. Every `/small` must be finalized (its cleanup run)
// and collected, and a shutdown must resolve. Prints what is left.
import { type AddressInfo, connect } from "node:net";
import { Binden, BindenResponse, type Context, shutdown } from "../../index.js";
import { once } from "node:events";
import { queryObjects } from "node:v8";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 25_000).unref();

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const clients = 100;
let cleaned = 0;
const app = new Binden({ timeout: 30 }).use(async (context: Context) => {
  const { response } = context;
  if (context.url.pathname === "/events") {
    context.setTimeout(0);
    response.setHeader("Content-Type", "text/event-stream");
    response.write("data: hi\n\n");
    await once(response, "close");
    return;
  }
  context.onCleanup(() => {
    cleaned += 1;
  });
  response.setHeader("Content-Type", "text/plain");
  response.end("x".repeat(64 * 1024));
});

const server = app.createServer();
server.listen(0, "localhost");
await once(server, "listening");
const { port } = server.address() as AddressInfo;
await Promise.all(
  Array.from({ length: clients }, async () => {
    const socket = connect(port, "localhost");
    socket.on("error", () => null);
    await once(socket, "connect");
    socket.write(
      "GET /events HTTP/1.1\r\nHost: a\r\n\r\nGET /small HTTP/1.1\r\nHost: a\r\n\r\n",
    );
    await sleep(120);
    socket.destroy();
  }),
);
await sleep(100);
const gc = Reflect.get(globalThis, "gc") as () => void;
for (let round = 0; round < 3; round += 1) {
  gc();
  await sleep(20);
}
const left = queryObjects(BindenResponse, { format: "count" });
const closed = await Promise.race([
  shutdown(server, { timeout: 100, cleanup_timeout: 200 }).then(
    () => "resolved",
    (error: unknown) => (error as Error).message,
  ),
  sleep(3000).then(() => "pending"),
]);
process.stdout.write(
  `cleanups=${cleaned} ${left < 10 ? "collected" : `kept ${left}`} shutdown ${closed}\n`,
);
