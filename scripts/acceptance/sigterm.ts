// SIGTERM, with `shutdown()`, while a kept-alive connection is idle, a stream of
// server-sent events is open and a slow upload is in progress: the idle connection
// is closed at once, no connection is accepted any more, the upload completes (its
// reply has `Connection: close`), the event stream goes on until the drain time
// has passed and is then cut (its signal is aborted: `shutdown`), and the process
// exits by itself once `shutdown()` has resolved.
import { Binden, type Context, Router, shutdown } from "binden";
import {
  deadline,
  exchange,
  read,
  reasonOf,
  serve,
  sleep,
  start,
} from "./helpers.js";
import { Agent } from "node:http";
import { BodyParser } from "@binden/body";
import { setTimeout as wait } from "node:timers/promises";

deadline(20_000);

/** The drain time of the shutdown */
const drain = 1500;
const KiB = 1024;

/** What has happened, in order */
const order: string[] = [];
const results: Record<string, unknown> = { order };

const uploading = Promise.withResolvers<null>();
const streaming = Promise.withResolvers<null>();
const cleaned = Promise.withResolvers<string | null>();

const events = async (context: Context): Promise<void> => {
  context.setTimeout(0);
  context.done = true;
  context.onCleanup(() => {
    cleaned.resolve(reasonOf(context.signal));
  });
  const { response, signal } = context;
  response.setHeader("Content-Type", "text/event-stream");
  try {
    // Unaware of the shutdown: it is cut once the drain time has passed
    for (let id = 1; ; id += 1) {
      response.write(`id: ${id}\n\n`);
      await response.flush();
      streaming.resolve(null);
      await wait(50, null, { signal });
    }
  } catch {
    // Aborted
  }
};

const app = new Binden({ timeout: 30_000 })
  .use("/ok", (context: Context) => context.text("ok"))
  .use("/events", events)
  .use(
    "/upload",
    new Router().post(
      () => {
        uploading.resolve(null);
      },
      new BodyParser({ limit: 1024 * KiB }),
      (context: Context) =>
        context.json({ size: (context.request.body as string).length }),
    ),
  );

const { server, port } = await serve(app);
// Wrapped: a promise resolved with the promise of `shutdown()` would wait for it
const terminated = new Promise<{ closing: Promise<void> }>((resolve) => {
  process.once("SIGTERM", () => {
    order.push("SIGTERM");
    resolve({ closing: shutdown(server, { timeout: drain }) });
  });
});

// A kept-alive connection, idle
const agent = new Agent({ keepAlive: true });
const ok = start(port, "/ok", { agent });
ok.client.end();
const idle = await ok.response;
const { socket } = idle;
await read(idle);
socket.once("close", () => {
  order.push("idle connection closed");
});

// A stream of events
const stream = start(port, "/events");
stream.client.end();
const sse = await stream.response;
let received = 0;
let afterSigterm = 0;
let signalled = false;
sse.on("data", () => {
  received += 1;
  if (signalled) {
    afterSigterm += 1;
  }
});
const cut = new Promise<void>((resolve) => {
  sse.once("close", () => {
    order.push("events cut");
    results.events = {
      complete: sse.complete,
      after_sigterm: afterSigterm > 0,
    };
    resolve();
  });
});
sse.on("error", () => {
  // The stream is cut on purpose
});
await streaming.promise;

// A slow upload: a quarter of its body, then SIGTERM
const size = 64 * KiB;
// On a kept-alive connection of its own: `Connection: close` comes from the shutdown
const uploads = new Agent({ keepAlive: true });
const upload = start(port, "/upload", {
  agent: uploads,
  method: "POST",
  headers: { "Content-Type": "text/plain", "Content-Length": size },
});
upload.client.write("a".repeat(size / 4));
await uploading.promise;

process.kill(process.pid, "SIGTERM");
const { closing } = await terminated;
signalled = true;

// No connection is accepted any more
results.refused = await exchange(port, "/ok").then(
  () => "accepted",
  (error: unknown) => (error as { code?: string }).code,
);

// The rest of the upload, slowly
for (let part = 1; part < 4; part += 1) {
  await sleep(100);
  upload.client.write("a".repeat(size / 4));
}
upload.client.end();
const uploaded = await read(await upload.response);
order.push("upload replied");
results.upload = {
  status: uploaded.status,
  connection: uploaded.headers.connection,
  body: JSON.parse(uploaded.body.toString()) as unknown,
};

await cut;
results.cleanup = await cleaned.promise;
await closing;
order.push("shutdown resolved");
results.listening = server.listening;
results.received = received > 1;
agent.destroy();
uploads.destroy();
process.stdout.write(`${JSON.stringify(results)}\n`);
