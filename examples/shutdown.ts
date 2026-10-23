// A graceful shutdown on SIGTERM (e.g. `docker stop`, or Kubernetes before it kills a
// pod): the server stops accepting connections, the requests in progress complete
// (within the drain time), the idle connections are closed, and the process exits once
// nothing is left.
//
//   PORT=3000 node --import tsx examples/shutdown.ts
//   curl -N http://localhost:3000/export & sleep 0.2; kill -TERM <pid>
import { Binden, type Context, shutdown } from "binden";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";

/** A long response: 10 lines, one every 100 ms */
async function* lines(signal: AbortSignal): AsyncGenerator<string> {
  for (let line = 1; line <= 10; line += 1) {
    yield `line ${line}\n`;
    await sleep(100, null, { signal });
  }
}

// Once the server is closing, a request that still arrives on an open connection
// gets `503 Service Unavailable` with `Connection: close`, without running the stack
export const app = new Binden({ timeout: 30_000 }).use(
  "/export",
  (context: Context) =>
    context
      .setHeader("Content-Type", "text/plain; charset=utf-8")
      .send(Readable.from(lines(context.signal))),
);

export const server = app.createServer({
  headersTimeout: 20_000,
  requestTimeout: 120_000,
  keepAliveTimeout: 65_000,
});

server.listen(Number(process.env.PORT ?? 3000), () => {
  const { port } = server.address() as AddressInfo;
  process.stdout.write(`Listening on http://localhost:${port}\n`);
});

process.once("SIGTERM", () => {
  // The requests in progress have 20 s (shorter than the grace period of the
  // platform); then they are aborted (`context.signal`) and their connections closed.
  // The cleanups have 2 s more.
  const closing = shutdown(server, { timeout: 20_000, cleanup_timeout: 2000 });
  // The server no longer accepts connections
  process.stdout.write("Shutting down\n");
  closing.then(
    () => {
      process.stdout.write("Closed\n");
    },
    (error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    },
  );
});
