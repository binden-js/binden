// Run by `unreleased-readables.test.ts`, without a handler of the process: a
// Node.js `Readable` that refuses every listener of `error` (a listener of
// its `newListener` throws), with listeners of the application of its
// `pause` that fail it later (an `error` on the next turn), sent (fresh, or
// paused by the application), released to `HEAD` or for an informational
// status, or ignored once the response has ended. No listener of its
// `error` can be in place: binden must leave it untouched, never paused,
// since its error would crash the process. One line per path: `<path>
// <status> <outcome> pauses=<n> resumes=<n> flowing=<readableFlowing>
// destroyed=<destroyed> listeners=<data>/<end>/<error>/<close>`, then the
// count of the records of the sources left. Then one that refuses only the
// listener of its guard (`/listened`), which binden pauses while its send
// listens (a chunk larger than the buffer of the response), and which fails
// 100 ms later, once the deadline has cut the send: the listener of its send
// stays, and logs that error once (`<path> <status> <outcome> pauses=<n>
// destroyed=<destroyed> listeners=<...> late=<n>`).
import { Binden, type Context } from "../../index.js";
import { type IncomingMessage, type Server, request } from "node:http";
import { capture, ioTurn, pollUntil } from "../helpers.js";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { once } from "node:events";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 20_000).unref();

/** What each source has emitted to the listeners of the application */
interface IEvents {
  pauses: number;
  resumes: number;
}

/** The sources of the paths, with their events */
const sources = new Map<string, { source: Readable; events: IEvents }>();
/** How the sends have settled, by path */
const outcomes = new Map<string, string>();

/**
 * A `Readable` that refuses every listener of `error`, never ends, and fails
 * on the turn after each `pause` that it emits (`paused`: by the application
 * first, before the listeners of the application are added). `/listened`
 * refuses only the second one (of its guard), pushes 64 KiB once read, and
 * fails 100 ms after its pause.
 */
function refusing(path: string, paused: boolean): Readable {
  const listened = path === "/listened";
  let pushed = false;
  const source = new Readable({
    read(): void {
      // Never ends
      if (listened && !pushed) {
        pushed = true;
        this.push(Buffer.alloc(64 * 1024));
      }
    },
  });
  if (paused) {
    source.pause();
  }
  const events: IEvents = { pauses: 0, resumes: 0 };
  let errors = 0;
  source.on("newListener", (event: string) => {
    if (event === "error") {
      errors += 1;
      if (!listened || errors === 2) {
        throw new Error(`No listener of error (${path})`);
      }
    }
  });
  source.on("pause", () => {
    events.pauses += 1;
    setTimeout(
      () => {
        source.emit("error", new Error(`Failed after a pause (${path})`));
      },
      listened ? 100 : 0,
    );
  });
  source.on("resume", () => {
    events.resumes += 1;
  });
  sources.set(path, { source, events });
  return source;
}

/** How a send has settled: resolved, or the message of its error */
function outcomeOf(sent: Promise<void>): Promise<string> {
  return sent.then(
    () => "resolved",
    (error: unknown) => `rejected:${(error as Error).message}`,
  );
}

const captured = capture();
const middleware = async (context: Context): Promise<void> => {
  const { pathname } = context.url;
  const source = refusing(pathname, pathname === "/paused");
  if (pathname === "/ignored") {
    context.response.end("ended");
  } else if (pathname === "/informational") {
    context.response.status(103);
  }
  outcomes.set(pathname, await outcomeOf(context.send(source)));
  if (!context.response.writableEnded) {
    throw new Error("Replied");
  }
};
const options = { logger: captured.logger, log_error_details: true };
const servers: Server[] = [];
const ports: number[] = [];
for (const timeout of [0, 50]) {
  const app = new Binden({ ...options, timeout }).use(middleware);
  const server = app.createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  ports.push((server.address() as AddressInfo).port);
}

/** A request of a path (`HEAD` for `/head`), once its response has closed */
async function requested(path: string): Promise<number> {
  const port = path === "/listened" ? ports[1] : ports[0];
  const method = path === "/head" ? "HEAD" : "GET";
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    request({ agent: false, path, method, host: "127.0.0.1", port }, resolve)
      .on("error", reject)
      .end();
  });
  // Cut by the deadline (`/listened`): it closes without its end (with an
  // `error`, which `once()` would reject with)
  await new Promise((resolve) => {
    response
      .on("error", () => null)
      .on("close", resolve)
      .resume();
  });
  return response.statusCode ?? 0;
}

const paths = ["/send", "/paused", "/head", "/ignored", "/informational"];
const lines: string[] = [];
for (const path of paths) {
  const status = await requested(path);
  // A pause of binden would fail the source on the next turn
  await ioTurn();
  const { source, events } = sources.get(path) as {
    source: Readable;
    events: IEvents;
  };
  const listeners = ["data", "end", "error", "close"]
    .map((event) => source.listenerCount(event))
    .join("/");
  lines.push(
    `${path} ${status} ${outcomes.get(path)} pauses=${events.pauses} resumes=${events.resumes} flowing=${source.readableFlowing} destroyed=${source.destroyed} listeners=${listeners}`,
  );
}
const left = captured.records.filter(
  ({ msg }) => msg === "A stream could not be released",
).length;
lines.push(`left=${left}`);

const status = await requested("/listened");
/** The late errors of `/listened` that have been logged */
const late = (): number =>
  captured.records.filter(
    ({ msg, failure }) =>
      msg === "A released stream has failed" &&
      (failure as { message?: unknown } | undefined)?.message ===
        "Failed after a pause (/listened)",
  ).length;
// Its error (100 ms after its pause), then a while for any other report
await pollUntil(() => late() > 0, 5_000).catch(() => null);
await ioTurn();
const { source, events } = sources.get("/listened") as {
  source: Readable;
  events: IEvents;
};
const listeners = ["data", "end", "error", "close"]
  .map((event) => source.listenerCount(event))
  .join("/");
lines.push(
  `/listened ${status} ${outcomes.get("/listened")} pauses=${events.pauses} destroyed=${source.destroyed} listeners=${listeners} late=${late()}`,
);
for (const server of servers) {
  server.close();
}
process.stdout.write(`${lines.join("\n")}\n`);
process.exit(0);
