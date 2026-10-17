// Compressed responses, and a compressed stream of server-sent events: an event
// would wait in the compressor, so the stream is compressed only by an explicit
// `filter`, with a `flush()` after each complete event. The stream ends when the
// server shuts down (its clients reconnect to another instance).
//
//   PORT=3000 node --import tsx examples/sse.ts
//   curl --compressed http://localhost:3000/report
//   curl -N --compressed http://localhost:3000/events
import { Binden, type ContentType, type Context, shutdown } from "binden";
import { Compression, isCompressible } from "@binden/compression";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

/** Aborted once the server is shutting down: the streams end */
const closing = new AbortController();

// The defaults: `br`, `gzip` or `deflate` as the client accepts, for the
// compressible types and the responses of 1024 bytes or more
const compression = new Compression();

// The same, and the event streams
const sse = new Compression({
  filter: (_context: Context, type: ContentType | null): boolean =>
    type?.type === "text/event-stream" || isCompressible(type),
});

const report = (context: Context): Promise<void> =>
  context.json(
    Array.from({ length: 200 }, (_, index) => ({
      id: index + 1,
      status: index % 3 === 0 ? "pending" : "done",
    })),
  );

const events = async (context: Context): Promise<void> => {
  // A stream has no deadline (`timeout` of the application)
  context.setTimeout(0);
  context.done = true;
  const { response } = context;
  const signal = AbortSignal.any([context.signal, closing.signal]);
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  // nginx would buffer the stream
  response.setHeader("X-Accel-Buffering", "no");
  try {
    for (let id = 1; !signal.aborted; id += 1) {
      const data = JSON.stringify({ time: new Date().toISOString() });
      response.write(`id: ${id}\nevent: tick\ndata: ${data}\n\n`);
      // The event reaches the client now
      await response.flush();
      await sleep(1000, null, { signal });
    }
  } catch {
    // The client has gone away, or the server is shutting down
  }
  response.end();
};

export const app = new Binden({ timeout: 30_000 })
  .use("/report", compression, report)
  .use("/events", sse, events);

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
  closing.abort();
  shutdown(server, { timeout: 20_000, cleanup_timeout: 2000 }).catch(
    (error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    },
  );
});
