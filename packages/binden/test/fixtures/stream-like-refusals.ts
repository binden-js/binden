// Run by `guard-refusals.test.ts`, without a handler of the process: a
// stream-like source (an `EventEmitter` with the methods, and the `Readable`
// of `readable-stream` 2, 3 and 4) whose own `on()` refuses the listener of
// `error` of its guard, or every one, for each case of `cases`. Nothing may
// crash the process, nothing of the send may
// be left on the source but its guard (or, when the guard cannot be
// installed, the listener of `error` of the send, which logs a late error),
// and the send settles as it would with a Node.js `Readable`. One line per
// source and case: `<source> <case> <status> <outcome> destroyed=<what it has
// been destroyed with> listeners=<data>/<end>/<error>/<close> late=<late
// errors logged>`, then the counts of the records of the sources left and
// of the code of the sources that has thrown once released.
import { Binden, type Context, type IStreamLike } from "../../index.js";
import { EventEmitter, once } from "node:events";
import { type IncomingMessage, request } from "node:http";
import type { AddressInfo } from "node:net";
import { capture } from "../helpers.js";
import { createRequire } from "node:module";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 25_000).unref();

const require = createRequire(import.meta.url);

/** A stream-like source, as the cases see it */
interface ISource extends EventEmitter {
  readonly destroyed?: boolean;
  push?(chunk: unknown): boolean;
  pause(): this;
  resume(): this;
  destroy?(error?: Error): this;
}

/**
 * A stream-like source that is not a stream: its `destroy()` emits its error
 * (if any) and its `close` on the next turn
 */
class Emitter extends EventEmitter {
  public destroyed = false;

  public pause(): this {
    return this;
  }

  public resume(): this {
    return this;
  }

  public destroy(error?: Error): this {
    this.destroyed = true;
    setImmediate(() => {
      if (error) {
        this.emit("error", error);
      }
      this.emit("close");
    });
    return this;
  }
}

/** The `Readable` of a version of `readable-stream` */
type IReadable = new (options: {
  autoDestroy?: boolean;
  read(): void;
}) => ISource;

/** The sources, by name */
const libraries: Readonly<Record<string, () => ISource>> = {
  emitter: () => new Emitter(),
  ...Object.fromEntries(
    ["2", "3", "4"].map((version) => [
      `v${version}`,
      (): ISource => {
        const { Readable } = require(`readable-stream-v${version}`) as {
          Readable: IReadable;
        };
        return new Readable({
          read(): void {
            // Pushed by the cases
          },
        });
      },
    ]),
  ),
};

/** Sends its data (`hello`), then its end, on the next turn */
function whole(source: ISource): void {
  setImmediate(() => {
    if (typeof source.push === "function") {
      source.push("hello");
      source.push(null);
    } else {
      source.emit("data", Buffer.from("hello"));
      source.emit("end");
    }
  });
}

/** A method of a source, called with the source */
type IMethod = (...args: unknown[]) => unknown;

/** Makes the `on()` of a source throw for the listeners of `error` from the n-th (1 for every one) */
function refusing(source: ISource, from: number): void {
  const on = Reflect.get(source, "on") as IMethod;
  let listeners = 0;
  Object.assign(source, {
    on(event: string, listener: () => void): unknown {
      if (event === "error") {
        listeners += 1;
        if (listeners >= from) {
          throw new Error(`No listener of error #${listeners}`);
        }
      }
      return Reflect.apply(on, source, [event, listener]);
    },
  });
}

/** Makes the `destroy()` of a source fail 20 ms later, once it is called */
function failing(source: ISource, key: string): void {
  Object.assign(source, {
    destroy(): ISource {
      Object.assign(source, { destroyed: true });
      setTimeout(() => {
        source.emit("error", new Error(`Late failure (${key})`));
      }, 20);
      return source;
    },
  });
}

/** A case: what it does to the source before it is sent, and which sources it applies to */
interface ICase {
  readonly sources: readonly string[];
  readonly method?: string;
  readonly deadline?: boolean;
  /** What it does before the send (`key`: of the source and the case) */
  prepare(source: ISource, key: string): void;
  /**
   * What it does once every send has settled (and its listeners have been
   * removed, or not)
   */
  later?(source: ISource, key: string): void;
}

const all = Object.keys(libraries);
/** A late error of the source, once it has been released */
const later = (source: ISource, key: string): void => {
  source.emit("error", new Error(`Late failure (${key})`));
};
const cases: Readonly<Record<string, ICase>> = {
  // Its own `on()` throws only for the listener of `error` of its guard (the
  // second): the send settles by its end, or by its error, and its own
  // listener of `error` reports a later error
  "guard-end": {
    sources: all,
    prepare: (source: ISource): void => {
      refusing(source, 2);
      whole(source);
    },
    later,
  },
  "guard-error": {
    sources: ["emitter"],
    prepare: (source: ISource): void => {
      refusing(source, 2);
      setImmediate(() => {
        source.emit("error", new Error("Its I/O has failed"));
      });
    },
    later,
  },
  // Cancelled at the deadline: destroyed without the reason, its destroy
  // fails later
  "guard-deadline": {
    sources: all,
    deadline: true,
    prepare: (source: ISource, key: string): void => {
      refusing(source, 2);
      failing(source, key);
    },
  },
  // Its own `on()` throws for every listener of `error` (released to `HEAD`),
  // and its destroy would fail later: it is never destroyed, only left
  "every-head": {
    sources: ["emitter"],
    method: "HEAD",
    prepare: (source: ISource, key: string): void => {
      refusing(source, 1);
      failing(source, key);
    },
  },
};

/** How a send has rejected: the code of its error, or else its message, or the value */
function rejection(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return String(error);
  }
  const { code, message } = error as { code?: unknown; message?: unknown };
  return typeof code === "string" ? code : String(message);
}

/** The message of an error, or the value */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What each source has been destroyed with, and how each send has settled, by key */
const destroys = new Map<string, unknown[]>();
const sources = new Map<string, ISource>();
const outcomes = new Map<string, string>();

const captured = capture();
const middleware = async (context: Context): Promise<void> => {
  const [, library = "", name = ""] = context.url.pathname.split("/");
  const key = `${library} ${name}`;
  const spec = cases[name];
  const source = libraries[library]();
  sources.set(key, source);
  spec.prepare(source, key);
  // Every destroy, by the methods that the send reads (once prepared)
  const destroy: unknown = Reflect.get(source, "destroy");
  const destroyed: unknown[] = [];
  destroys.set(key, destroyed);
  if (typeof destroy === "function") {
    Object.assign(source, {
      destroy(error?: unknown): unknown {
        destroyed.push(error);
        return Reflect.apply(destroy, source, [error]);
      },
    });
  }
  outcomes.set(
    key,
    await context.send(source as unknown as IStreamLike).then(
      () => "resolved",
      (error: unknown) => `rejected:${rejection(error)}`,
    ),
  );
  if (!context.response.headersSent) {
    throw new Error("Replied");
  }
};
const options = { logger: captured.logger, log_error_details: true };
const ports: number[] = [];
for (const timeout of [0, 50]) {
  const server = new Binden({ ...options, timeout })
    .use(middleware)
    .createServer()
    .listen(0, "127.0.0.1");
  await once(server, "listening");
  ports.push((server.address() as AddressInfo).port);
}

/** The status of a request, `0` once the connection is closed before its end */
function status(path: string, spec: ICase): Promise<number> {
  return new Promise((resolve) => {
    request({
      agent: false,
      path,
      method: spec.method ?? "GET",
      host: "127.0.0.1",
      port: spec.deadline === true ? ports[1] : ports[0],
    })
      .on("response", (response: IncomingMessage) => {
        response
          .resume()
          .on("end", () => {
            resolve(response.statusCode ?? 0);
          })
          .on("error", () => {
            resolve(0);
          });
      })
      .on("error", () => {
        resolve(0);
      })
      .end();
  });
}

const lines: [string, number][] = [];
for (const [name, spec] of Object.entries(cases)) {
  for (const library of spec.sources) {
    lines.push([
      `${library} ${name}`,
      await status(`/${library}/${name}`, spec),
    ]);
  }
}
// The late errors (20 ms later), and the turn after the close of each source
await new Promise((resolve) => {
  setTimeout(resolve, 50);
});
for (const [name, spec] of Object.entries(cases)) {
  for (const library of spec.sources) {
    const key = `${library} ${name}`;
    spec.later?.(sources.get(key) as ISource, key);
  }
}
await new Promise((resolve) => {
  setTimeout(resolve, 50);
});

/** The messages of the errors of a source logged once released */
const late = captured.records
  .filter(({ level }) => level === 20)
  .map(
    ({ failure }) => (failure as { message?: unknown } | undefined)?.message,
  );
const count = (message: string): number =>
  late.filter((logged) => logged === message).length;
process.stdout.write(
  `${lines
    .map(([key, code]) => {
      const source = sources.get(key) as ISource;
      const destroyed = (destroys.get(key) as unknown[]).map(messageOf);
      const listeners = ["data", "end", "error", "close"]
        .map((event) => source.listenerCount(event))
        .join("/");
      return `${key} ${code} ${outcomes.get(key)} destroyed=${destroyed.join("|")} listeners=${listeners} late=${count(`Late failure (${key})`)}`;
    })
    .join("\n")}\n` +
    `removals=${late.filter((logged) => typeof logged === "string" && logged.startsWith("No removal")).length} refusals=${late.filter((logged) => typeof logged === "string" && logged.startsWith("No listener")).length} left=${captured.records.filter(({ msg }) => msg === "A stream could not be released").length}\n`,
);
process.exit(0);
