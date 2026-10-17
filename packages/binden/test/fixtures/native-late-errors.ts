// Run by `settled-sends.test.ts`: the destroy of a Node.js `Readable` may fail
// later, without a listener of the application, once its send no longer
// listens to it. It must not crash the process: when the application has
// destroyed it before the send (which rejects), and when it destroys itself
// once it has ended (`autoDestroy`), before the send or while it is sent. Its
// late error is logged at `debug`, and its guard is removed once it has
// closed.
import { type IncomingMessage, request } from "node:http";
import { capture, pollUntil } from "../helpers.js";
import type { AddressInfo } from "node:net";
import { Binden } from "../../index.js";
import { Readable } from "node:stream";
import { once } from "node:events";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 10_000).unref();

/** A readable that ends once read, whose destroy fails 20 ms later */
function failing(pathname: string): Readable {
  return new Readable({
    read(): void {
      this.push(null);
    },
    destroy(_error, callback): void {
      setTimeout(callback, 20, new Error(`Failed later (${pathname})`));
    },
  });
}

/** The sources, by path */
const sources = new Map<string, Readable>();
/** What each send has settled with, by path */
const sent = new Map<string, string>();

const captured = capture();
const app = new Binden({
  logger: captured.logger,
  log_error_details: true,
}).use(async (context) => {
  const { pathname } = context.url;
  const source = failing(pathname);
  sources.set(pathname, source);
  if (pathname === "/destroyed") {
    source.destroy();
  } else if (pathname === "/ended") {
    // Its destroy is pending
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

const paths = ["/destroyed", "/ended", "/active"];
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
    .filter(
      ({ msg }) => msg === "A stream-like source has failed once released",
    )
    .map(({ failure }) => String((failure as { message?: unknown }).message));
await pollUntil(() => reported().length >= paths.length);
// Once the guards of the sources, which have closed, are removed
await new Promise((resolve) => {
  setTimeout(resolve, 20);
});
server.close();
process.stdout.write(
  `${statuses.join(" ")}\n${paths.map((path) => sent.get(path)).join(" ")}\n${reported().sort().join(", ")}\n${paths
    .map((path) =>
      ["data", "end", "error", "close"]
        .map((event) => sources.get(path)?.listenerCount(event))
        .join(""),
    )
    .join(" ")}\n`,
);
