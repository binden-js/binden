// Run by `source-failures.test.ts`: code of a `Readable` that throws while
// `send()` reads it, in every path of the send (its own `on()`, a listener of
// its `newListener`, its own `resume()` when it is fresh, flowing or paused,
// and at a drain, paused before the send or by the backpressure of the send),
// whatever it throws (an `Error`, `null`, `undefined`, a string, a number).
// Nothing may crash the process (an uncaught exception, or an unhandled
// rejection once the response has closed), and nothing of the send may be
// left: it rejects with what has been thrown, as it is, `.started` is false
// before the headers are committed (the error is replied, and the connection
// kept), the connection is closed once they are, the source is destroyed, and
// no listener is left on it. One line per case: `<path>/<value> <outcome>
// started=<started> <statuses of an open connection>(<connection>)
// destroyed=<destroyed> listeners=<count>`.
import { type AddressInfo, connect } from "node:net";
import { Binden, type Context } from "../../index.js";
import { Readable } from "node:stream";
import { capture } from "../helpers.js";
import { once } from "node:events";

for (const event of ["unhandledRejection", "uncaughtException"]) {
  process.on(event, (error: unknown) => {
    process.stderr.write(`${event} ${String(error)}\n`);
    process.exit(1);
  });
}
setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 30_000).unref();

/** What the code of a source throws, by name (a new `Error` for each source) */
const values: Readonly<Record<string, () => unknown>> = {
  error: () => new Error("Thrown"),
  null: () => null,
  // eslint-disable-next-line no-undefined -- a thrown `undefined`
  undefined: () => undefined,
  string: () => "Thrown",
  number: () => 42,
};

/** A body larger than the high water mark of a socket: its write always needs a drain */
const large = 1 << 20;

/**
 * A `Readable` whose own `resume()` throws `value` from its call `from` (the
 * first is 1), and that pushes `chunk` once read (nothing by default)
 */
function resuming(value: unknown, from: number, chunk?: Buffer): Readable {
  let calls = 0;
  let pushed = false;
  return new (class extends Readable {
    public override resume(): this {
      calls += 1;
      if (calls >= from) {
        throw value;
      }
      return super.resume();
    }
  })({
    read(): void {
      if (typeof chunk !== "undefined" && !pushed) {
        pushed = true;
        this.push(chunk);
      }
    },
  });
}

/** The sources of each path, which throw `value`, and what the work does before it sends one */
const paths: Readonly<
  Record<string, (value: unknown, context: Context) => Readable>
> = {
  // `on("data")` of Node.js resumes it
  fresh: (value) => resuming(value, 1),
  flowing: (value) => {
    const source = resuming(value, 2);
    source.resume();
    return source;
  },
  // Resumed by the send
  paused: (value) => {
    const source = resuming(value, 1);
    source.pause();
    return source;
  },
  // Its own `on()`, for the second listener of the send
  on: (value) =>
    new (class extends Readable {
      public override on(...args: Parameters<Readable["on"]>): this {
        const [event] = args;
        if (event === "end") {
          throw value;
        }
        return super.on(...args);
      }
    })({
      read(): void {
        // Never read
      },
    }),
  // For the last listener of the send (not again, e.g. for its guard)
  newListener: (value) => {
    const source = new Readable({
      read(): void {
        // Never read
      },
    });
    let thrown = false;
    source.on("newListener", (event: string) => {
      if (event === "close" && !thrown) {
        thrown = true;
        throw value;
      }
    });
    return source;
  },
  // Resumed by the send at the drain of the response, which the work has
  // filled first (its headers are committed)
  drain: (value, { response }) => {
    response.write(Buffer.alloc(large, 0x61));
    if (!response.writableNeedDrain) {
      // Never on any platform: the chunk is larger than the high water mark
      throw new Error("The response does not need a drain");
    }
    const source = resuming(value, 1);
    source.pause();
    return source;
  },
  // Resumed by `on("data")` of Node.js, then paused by the backpressure of
  // the send, and resumed by the send at the drain
  backpressure: (value) => resuming(value, 2, Buffer.alloc(large, 0x61)),
};

/** How a send has rejected: with what has been thrown, as it is, or else with what */
function rejection(error: unknown, thrown: unknown): string {
  return Object.is(error, thrown) ? "rejected" : `rejected(${String(error)})`;
}

interface IOutcome {
  readonly outcome: string;
  readonly started: boolean;
  readonly source: Readable;
  readonly closed: Promise<unknown>;
}

const outcomes = new Map<string, IOutcome>();
const app = new Binden({ logger: capture().logger }).use(
  async (context: Context) => {
    const name = context.url.pathname.slice(1);
    if (name === "next") {
      await context.text("next");
      return;
    }
    const [path = "", kind = ""] = name.split("/");
    const value = values[kind]();
    const closed = once(context.response, "close");
    const source = paths[path](value, context);
    const outcome = await context.send(source).then(
      () => "resolved",
      (error: unknown) => rejection(error, value),
    );
    outcomes.set(name, {
      outcome,
      started: context.response.started,
      source,
      closed,
    });
    // Replied (500) before the headers are committed, the connection closed
    // once they are
    throw new Error("Replied");
  },
);
const server = app.createServer().listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address() as AddressInfo;

/**
 * Requests the case, then `/next` on the same connection: the status lines
 * received, once the connection has closed or `/next` has its reply (never
 * judged by silence)
 */
async function exchange(name: string): Promise<string> {
  const socket = connect(port, "127.0.0.1");
  await once(socket, "connect");
  let data = "";
  const { promise, resolve } = Promise.withResolvers<string>();
  socket
    .setEncoding("latin1")
    .on("data", (chunk: string) => {
      data += chunk;
      if (data.endsWith("\r\n\r\nnext")) {
        resolve("open");
      }
    })
    .on("error", () => {
      // Closed below
    })
    .on("close", () => {
      resolve("closed");
    });
  socket.write(
    `GET /${name} HTTP/1.1\r\nHost: localhost\r\n\r\nGET /next HTTP/1.1\r\nHost: localhost\r\n\r\n`,
  );
  const state = await promise;
  socket.destroy();
  // What a closed connection has delivered before depends on the version of
  // Node.js (e.g. 24.14.1 may reset it)
  const statuses = state === "open" ? data.match(/HTTP\/1\.1 \d{3}/gu) : null;
  return `${(statuses ?? []).map((line) => line.slice(9)).join("+")}(${state})`;
}

/** Resolves once the source has closed, and its guard is removed (on the turn after) */
async function released(source: Readable): Promise<void> {
  if (!source.closed) {
    await once(source, "close");
  }
  await new Promise(setImmediate);
  await new Promise(setImmediate);
}

const lines: string[] = [];
for (const path of Object.keys(paths)) {
  for (const kind of Object.keys(values)) {
    const name = `${path}/${kind}`;
    const reply = await exchange(name);
    const { outcome, started, source, closed } = outcomes.get(name) as IOutcome;
    // Its response has closed (a `done` left without a handler would reject
    // then), and its source too
    await closed;
    await released(source);
    const listeners = ["data", "end", "error", "close"].reduce(
      (count, event) => count + source.listenerCount(event),
      0,
    );
    lines.push(
      `${name} ${outcome} started=${String(started)} ${reply} destroyed=${String(source.destroyed)} listeners=${String(listeners)}`,
    );
  }
}
server.close();
await once(server, "close");
process.stdout.write(`${lines.join("\n")}\n`);
