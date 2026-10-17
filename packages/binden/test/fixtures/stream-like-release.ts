// Run by `stream-like.test.ts`: the late error of the destroy of a stream-like
// source that is not sent (to `HEAD`, with a 204 or a 304 status, or refused
// for an informational status) or no longer (cancelled at the deadline),
// without a listener of the application, must not crash the process: it is
// logged at `debug`, also 2 s later, and after the `close` of the source
// (within the turn). A source of an ignored send is not touched at all.
import { Binden, type IStreamLike } from "../../index.js";
import { EventEmitter, once } from "node:events";
import { type IncomingMessage, request } from "node:http";
import { capture, pollUntil } from "../helpers.js";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 15_000).unref();

const require = createRequire(import.meta.url);

/** A stream-like source */
type ISource = EventEmitter & IStreamLike;

/** A readable of `readable-stream` 4 */
type IReadable = new (options: {
  read(): void;
  destroy(error: Error | null, callback: (error: Error) => void): void;
}) => ISource;

const { Readable } = require("readable-stream-v4") as { Readable: IReadable };

/** A source whose destroy fails, at once or `ms` later */
function failing(ms: number): ISource {
  return new Readable({
    read(): void {
      // Nothing to read
    },
    destroy(_error, callback): void {
      const error = new Error(`Failed to close after ${ms} ms`);
      if (ms === 0) {
        callback(error);
      } else {
        setTimeout(callback, ms, error);
      }
    },
  });
}

/** A source of its own, whose destroy emits `close`, then an error */
function closing(): ISource {
  const source = Object.assign(new EventEmitter(), {
    pause: (): null => null,
    resume: (): null => null,
    destroy: (): void => {
      source.emit("close");
      process.nextTick(() => {
        source.emit("error", new Error("Failed once closed"));
      });
    },
  });
  return source;
}

const sources: ISource[] = [];
const captured = capture();
const app = new Binden({
  logger: captured.logger,
  log_error_details: true,
  timeout: 50,
}).use(async (context) => {
  const { pathname } = context.url;
  const source =
    pathname === "/closing"
      ? closing()
      : failing(pathname === "/later" || pathname === "/deadline" ? 2000 : 0);
  sources.push(source);
  if (pathname === "/ended") {
    context.response.end();
    // Ignored: nothing of it is read, and it is not destroyed
    await context.response.send(source);
    return;
  } else if (
    pathname !== "/" &&
    pathname !== "/later" &&
    pathname !== "/closing"
  ) {
    context.status(Number(pathname.slice(1)) || 200);
  }
  await context.send(source);
});

const server = app.createServer().listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address() as AddressInfo;

const statuses: number[] = [];
for (const [method, path] of [
  ["HEAD", "/"],
  ["GET", "/204"],
  ["GET", "/304"],
  ["GET", "/103"],
  ["GET", "/ended"],
  ["HEAD", "/closing"],
  ["HEAD", "/later"],
  ["GET", "/deadline"],
]) {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    request({ agent: false, method, path, host: "127.0.0.1", port }, resolve)
      .on("error", reject)
      .end();
  });
  response.resume();
  await once(response, "end");
  statuses.push(response.statusCode ?? 0);
}

/** The late errors that have been logged */
const reported = (): string[] =>
  captured.records
    .filter(
      ({ msg }) => msg === "A stream-like source has failed once released",
    )
    .map(({ failure }) => String((failure as { message?: unknown }).message));
// The destroys that fail 2 s later
await pollUntil(() => reported().length >= 7);
// Once their guards are removed: on the turn after their `close`
await new Promise((resolve) => {
  setTimeout(resolve, 20);
});
server.close();
process.stdout.write(
  `${statuses.join(" ")}\n${reported().join(", ")}\n${sources
    .map((source) => source.listenerCount("error"))
    .join(" ")}\n`,
);
