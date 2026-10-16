// Run by `stream-like.test.ts`: the late error of a stream-like source without
// a listener of the application must not crash the process, also when it has
// no `destroy()` (its pause fails on the next tick, once cancelled at the
// deadline or released with a 204), and when the application has destroyed
// it (before the send: `readable-stream` 2 and 4, whose destroy fails 20 ms
// later, and a `PassThrough` of `readable-stream` 2 whose error follows on the
// next tick; or once sent, emitting its `end` at once and failing 20 ms
// later): it is logged at `debug`.
import { EventEmitter, once } from "node:events";
import { type IncomingMessage, request } from "node:http";
import type { AddressInfo } from "node:net";
import { Binden } from "../../index.js";
import { capture } from "../helpers.js";
import { createRequire } from "node:module";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 10_000).unref();

const require = createRequire(import.meta.url);

/** A stream of `readable-stream` */
interface IStream extends EventEmitter {
  pause(): this;
  resume(): this;
  destroy(error?: Error): void;
}

/** The streams of a version of `readable-stream` */
interface ILibrary {
  readonly PassThrough: new () => IStream;
  readonly Readable: new (options: {
    read(): void;
    destroy(
      this: IStream,
      error: Error | null,
      callback: (error: Error | null) => void,
    ): void;
  }) => IStream;
}

const [v2, v4] = ["2", "4"].map(
  (version) => require(`readable-stream-v${version}`) as ILibrary,
) as [ILibrary, ILibrary];

/** A readable whose destroy fails 20 ms later (once it has emitted its `end`) */
function failing(library: ILibrary, ended: boolean): IStream {
  return new library.Readable({
    read(): void {
      // Nothing to read
    },
    destroy(error, callback): void {
      if (ended) {
        this.emit("end");
      }
      setTimeout(callback, 20, error);
    },
  });
}

/** A source without `destroy()`, whose pause fails on the next tick */
function pausing(): EventEmitter {
  const source = Object.assign(new EventEmitter(), {
    resume: (): null => null,
    pause: (): null => {
      process.nextTick(() => {
        source.emit("error", new Error("Failed after its pause"));
      });
      return null;
    },
  });
  return source;
}

/** The sources, by path */
const sources = new Map<string, EventEmitter>();
/** What each send has settled with, by path */
const sent = new Map<string, string>();

/** The source of a path (destroyed at once, or later, by the application) */
function sourceOf(pathname: string): EventEmitter {
  if (pathname === "/cancelled" || pathname === "/released") {
    return pausing();
  } else if (pathname === "/v2" || pathname === "/v4") {
    const source = failing(pathname === "/v2" ? v2 : v4, false);
    source.destroy(new Error(`Failed before the send (${pathname})`));
    return source;
  } else if (pathname === "/same-turn") {
    const source = new v2.PassThrough();
    source.destroy(new Error("Failed in the same turn"));
    return source;
  }
  const source = failing(v2, true);
  setTimeout(() => {
    source.destroy(new Error("Failed after its end"));
  }, 2);
  return source;
}

const captured = capture();
const app = new Binden({
  logger: captured.logger,
  log_error_details: true,
  timeout: 50,
}).use(async (context) => {
  const { pathname } = context.url;
  if (pathname === "/released") {
    context.status(204);
  }
  const source = sourceOf(pathname);
  sources.set(pathname, source);
  await context.send(source as IStream).then(
    () => {
      sent.set(pathname, "resolved");
    },
    (error: unknown) => {
      sent.set(
        pathname,
        String(
          (error as { code?: unknown; reason?: unknown }).reason ??
            (error as { code?: unknown }).code,
        ),
      );
      throw error;
    },
  );
});

const server = app.createServer().listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address() as AddressInfo;

const paths = ["/cancelled", "/released", "/same-turn", "/v2", "/v4", "/ended"];
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
while (reported().length < paths.length) {
  await new Promise((resolve) => {
    setTimeout(resolve, 10);
  });
}
// Once the guards of the sources that close are removed
await new Promise((resolve) => {
  setTimeout(resolve, 20);
});
server.close();
process.stdout.write(
  `${statuses.join(" ")}\n${paths.map((path) => sent.get(path)).join(" ")}\n${reported().sort().join(", ")}\n${paths
    .map((path) => sources.get(path)?.listenerCount("error"))
    .join(" ")}\n`,
);
