// Run by `kept-guards.test.ts`, without a handler of the process: a
// stream-like source whose state cannot tell that it has closed (of
// `readable-stream` 2 or 3, a transform of `through2` 4, or an emitter of its
// own) keeps its guard once it has closed, so that an error that it emits
// later (a write of the application once binden has destroyed it, a destroy
// with an error, or an error of its own) is logged once, and never crashes
// the process. Prints, by case, its status, whether such errors have come,
// whether each has been logged once, and the listeners of `error` and
// `close` left on the source (of its guard).
import { type AddressInfo, connect } from "node:net";
import { Binden, type Context, releasedFailure } from "../../index.js";
import { EventEmitter, once } from "node:events";
import { capture, pollUntil } from "../helpers.js";
import { createRequire } from "node:module";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 20_000).unref();

const require = createRequire(import.meta.url);

/** A stream of `readable-stream` */
interface IStream extends EventEmitter {
  write(chunk: string): boolean;
  destroy(error?: Error): void;
  pause(): this;
  resume(): this;
}

/** The streams of a version of `readable-stream` */
interface ILibrary {
  readonly PassThrough: new () => IStream;
  readonly Transform: new (options: {
    transform(
      chunk: Buffer,
      encoding: string,
      callback: (error: null, chunk: Buffer) => void,
    ): void;
  }) => IStream;
  readonly Readable: new (options: { read(): void }) => IStream;
}

const [v2, v3] = ["2", "3"].map(
  (version) => require(`readable-stream-v${version}`) as ILibrary,
) as [ILibrary, ILibrary];

/** Whether an error is one that a source emits once it has closed */
type ILater = (error: unknown) => boolean;

/** A case: its source, the errors that it emits later, and its request */
interface ICase {
  readonly source: EventEmitter;
  /** Whether an error is one that the source emits once it has closed */
  readonly later: ILater;
  /** The errors that the source has emitted (counted without a listener) */
  readonly errors: unknown[];
  /** The timer of the application that writes to it, if any */
  timer?: NodeJS.Timeout;
  /** The id of its request */
  id?: string;
}

const cases = new Map<string, ICase>();

/** Counts the errors that a source emits, without listening to them */
function counted(source: EventEmitter, later: ILater): ICase {
  const errors: unknown[] = [];
  const emit = source.emit.bind(source);
  Object.assign(source, {
    emit(event: string, ...args: unknown[]): boolean {
      if (event === "error") {
        errors.push(args[0]);
      }
      return emit(event, ...args);
    },
  });
  return { source, later, errors };
}

/** The code of an error */
function codeOf(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

/** The message of an error */
function messageOf(error: unknown): unknown {
  return (error as { message?: unknown } | null)?.message;
}

/**
 * A feed of events written on a timer of the application, which never
 * listens to its errors: its first event before it is sent (which commits
 * the headers once it is read)
 */
function feed(stream: IStream, later: ILater): ICase {
  const fed = counted(stream, later);
  let event = 0;
  stream.write("data: 0\n\n");
  fed.timer = setInterval(() => {
    event += 1;
    stream.write(`data: ${event}\n\n`);
  }, 10);
  return fed;
}

/** The case of each path */
const sources: Record<string, () => ICase> = {
  // A transform of `through2` 4 (of `readable-stream` 3), as an SSE feed
  "/through2-deadline": () =>
    feed(
      new v3.Transform({
        transform(chunk, _encoding, callback): void {
          callback(null, chunk);
        },
      }),
      (error) => codeOf(error) === "ERR_STREAM_DESTROYED",
    ),
  "/through2-gone": () =>
    feed(
      new v3.Transform({
        transform(chunk, _encoding, callback): void {
          callback(null, chunk);
        },
      }),
      (error) => codeOf(error) === "ERR_STREAM_DESTROYED",
    ),
  "/v2-gone": () =>
    feed(
      new v2.PassThrough(),
      (error) => messageOf(error) === "write after end",
    ),
  "/v3-gone": () =>
    feed(
      new v3.PassThrough(),
      (error) => codeOf(error) === "ERR_STREAM_DESTROYED",
    ),
  // An emitter of its own that emits `close`, then an error (at once, or
  // 20 ms later)
  ...Object.fromEntries(
    [0, 20].map((ms) => [
      `/custom-${ms}`,
      (): ICase => {
        const source = Object.assign(new EventEmitter(), {
          pause: (): null => null,
          resume: (): null => null,
        });
        setTimeout(() => {
          source.emit("close");
          setTimeout(() => {
            source.emit("error", new Error("Closed"));
          }, ms);
        }, 10);
        return counted(source, (error) => messageOf(error) === "Closed");
      },
    ]),
  ),
  // A `Readable` of `readable-stream` 3 whose `newListener` refuses a
  // listener of the send, destroyed with an error later
  ...Object.fromEntries(
    ["end", "data"].map((event) => [
      `/refused-${event}`,
      (): ICase => {
        const source = new v3.Readable({
          read(): void {
            // Nothing to read
          },
        });
        source.on("newListener", (name: string) => {
          if (name === event) {
            throw new Error(`No listener of ${event}`);
          }
        });
        setTimeout(() => {
          source.destroy(new Error("I/O failure"));
        }, 50);
        return counted(source, (error) => messageOf(error) === "I/O failure");
      },
    ]),
  ),
};

const captured = capture();

/** An application whose middleware sends the source of the path */
function application(timeout: number): Binden {
  return new Binden({
    logger: captured.logger,
    log_error_details: true,
    timeout,
  }).use(async (context: Context) => {
    const { pathname } = context.url;
    const create = sources[pathname];
    if (typeof create === "undefined") {
      throw new Error(`No case ${pathname}`);
    }
    const created = create();
    created.id = context.id;
    cases.set(pathname, created);
    context.response.setHeader("Content-Type", "text/event-stream");
    // @ts-expect-error -- every source is a stream-like one
    await context.send(created.source);
  });
}

/** The status of a request on a new connection, which goes away once its first chunk has come, or once closed */
async function status(port: number, path: string): Promise<string> {
  const socket = connect(port, "127.0.0.1");
  let received = "";
  socket.setEncoding("latin1").on("error", () => null);
  socket.on("data", (chunk: string) => {
    received += chunk;
    if (path.endsWith("-gone") && /\r\n\r\n.*data: /su.test(received)) {
      socket.destroy();
    }
  });
  socket.write(`GET ${path} HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n`);
  await once(socket, "close");
  return /^HTTP\/1\.1 (?<code>\d{3})/u.exec(received)?.groups?.code ?? "none";
}

const lines: string[] = [];
for (const [timeout, paths] of [
  [100, ["/through2-deadline"]],
  [
    0,
    [
      "/through2-gone",
      "/v2-gone",
      "/v3-gone",
      "/custom-0",
      "/custom-20",
      "/refused-end",
      "/refused-data",
    ],
  ],
] as const) {
  const server = application(timeout).createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  for (const path of paths) {
    const code = await status(port, path);
    const sent = cases.get(path) as ICase;
    // Two later errors of each feed, one of the others
    const expected = sent.timer ? 2 : 1;
    await pollUntil(
      () => sent.errors.filter(sent.later).length >= expected,
      5000,
    ).catch(() => null);
    clearInterval(sent.timer);
    // Each logged within the turn of its error
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    const later = sent.errors.filter(sent.later).length;
    const logged = captured.records.filter(
      ({ msg, trace_id, failure }) =>
        msg === releasedFailure &&
        trace_id === sent.id &&
        sent.later({
          code: (failure as { code?: unknown }).code,
          message: (failure as { message?: unknown }).message,
        }),
    ).length;
    lines.push(
      `${path} ${code} later=${later >= expected} ${logged === later ? "each logged once" : `logged ${logged} of ${later}`} guard=${sent.source.listenerCount("error")}/${sent.source.listenerCount("close")}`,
    );
  }
  server.closeAllConnections();
  server.close();
}
process.stdout.write(`${lines.join("\n")}\n`);
