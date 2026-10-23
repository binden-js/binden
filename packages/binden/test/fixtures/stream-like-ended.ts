// Run by `stream-like.test.ts`: a source of `readable-stream` 4 destroys
// itself once it has ended (`autoDestroy`), and its destroy may fail later,
// without a listener of the application. It must not crash the process,
// whether it has ended before the send (an empty body) or while it is sent:
// its late error is logged at `debug`, and its guard is removed once it has
// closed.
import { Binden, releasedFailure } from "../../index.js";
import { EventEmitter, once } from "node:events";
import { type IncomingMessage, request } from "node:http";
import { capture, pollUntil } from "../helpers.js";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 10_000).unref();

const require = createRequire(import.meta.url);

/** A stream of `readable-stream` 4 */
interface IStream extends EventEmitter {
  pause(): this;
  resume(): this;
  destroy(error?: Error): void;
}

const { Readable } = require("readable-stream-v4") as {
  readonly Readable: new (options: {
    read(this: IStream & { push(chunk: null): boolean }): void;
    destroy(error: Error | null, callback: (error: Error | null) => void): void;
  }) => IStream;
};

/** A readable that ends at once, whose destroy fails 20 ms later */
function ending(pathname: string): IStream {
  return new Readable({
    read(): void {
      this.push(null);
    },
    destroy(_error, callback): void {
      setTimeout(callback, 20, new Error(`Failed after its end (${pathname})`));
    },
  });
}

/** The sources, by path */
const sources = new Map<string, IStream>();
/** What each send has settled with, by path */
const sent = new Map<string, string>();

const captured = capture();
const app = new Binden({
  logger: captured.logger,
  log_error_details: true,
}).use(async (context) => {
  const { pathname } = context.url;
  const source = ending(pathname);
  sources.set(pathname, source);
  if (pathname === "/ended") {
    // Ended before the send: its destroy is pending
    source.resume();
    await once(source, "end");
  }
  await context.send(source).then(
    () => {
      sent.set(pathname, "resolved");
    },
    (error: unknown) => {
      sent.set(pathname, String((error as { code?: unknown }).code));
      throw error;
    },
  );
});

const server = app.createServer().listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address() as AddressInfo;

const paths = ["/ended", "/active"];
const statuses: number[] = [];
for (const path of paths) {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    request({ agent: false, path, host: "127.0.0.1", port }, resolve)
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
    .filter(({ msg }) => msg === releasedFailure)
    .map(({ failure }) => String((failure as { message?: unknown }).message));
await pollUntil(() => reported().length >= paths.length);
// Once the guards of the sources, which have closed, are removed
await new Promise((resolve) => {
  setTimeout(resolve, 20);
});
server.close();
process.stdout.write(
  `${statuses.join(" ")}\n${paths.map((path) => sent.get(path)).join(" ")}\n${reported().sort().join(", ")}\n${paths
    .map((path) => sources.get(path)?.listenerCount("error"))
    .join(" ")}\n`,
);
