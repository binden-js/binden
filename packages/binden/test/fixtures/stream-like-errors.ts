// Run by `stream-like.test.ts`: the errors that a stream-like source (without
// a listener of the application) emits once it has closed, or once a
// cancellation has destroyed it, must not crash the process
import { EventEmitter, once } from "node:events";
import { type IncomingMessage, request } from "node:http";
import type { AddressInfo } from "node:net";
import { Binden } from "../../index.js";
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
    destroy(error: Error | null, callback: (error: Error | null) => void): void;
  }) => IStream;
}

const [v2, v3, v4] = ["2", "3", "4"].map(
  (version) => require(`readable-stream-v${version}`) as ILibrary,
) as [ILibrary, ILibrary, ILibrary];

/** The sources, by path */
const sources = new Map<string, EventEmitter>();

const app = new Binden({ timeout: 50 }).use(async (context) => {
  const { pathname } = context.url;
  if (pathname === "/closed") {
    // A `PassThrough` of `readable-stream` 2 emits its `end` and `close`,
    // then the `error` of its destroy
    const source = new v2.PassThrough();
    sources.set(pathname, source);
    setTimeout(() => {
      source.destroy(new Error("Destroyed"));
    }, 10);
    await context.send(source);
  } else if (pathname === "/custom") {
    // A source of its own that emits `close`, then an error
    const source = Object.assign(new EventEmitter(), {
      pause: (): null => null,
      resume: (): null => null,
    });
    sources.set(pathname, source);
    setTimeout(() => {
      source.emit("close");
      process.nextTick(() => source.emit("error", new Error("Closed")));
    }, 10);
    await context.send(source);
  } else if (pathname === "/deadline") {
    // Destroyed with the reason of the deadline, which it emits
    const source = new v3.PassThrough();
    sources.set(pathname, source);
    await context.send(source);
  } else {
    // Its destroy completes later: then it emits the reason
    const source = new v4.Readable({
      read(): void {
        // Nothing to read
      },
      destroy(error, callback): void {
        setTimeout(callback, 30, error);
      },
    });
    sources.set(pathname, source);
    await context.send(source);
  }
});

const server = app.createServer().listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address() as AddressInfo;

const statuses: number[] = [];
for (const path of ["/closed", "/custom", "/deadline", "/late"]) {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    request({ agent: false, path, host: "127.0.0.1", port }, resolve)
      .on("error", reject)
      .end();
  });
  response.resume();
  await once(response, "end");
  statuses.push(response.statusCode ?? 0);
}

// Once every source has emitted its error
await new Promise((resolve) => {
  setTimeout(resolve, 100);
});
server.close();
process.stdout.write(
  `${statuses.join(" ")}\n${[...sources.values()]
    .map((source) => source.listenerCount("error"))
    .join(" ")}\n`,
);
