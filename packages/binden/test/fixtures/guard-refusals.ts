// Run by `guard-refusals.test.ts`, without a handler of the process: a
// `Readable` whose listener of `newListener` throws for the listener of
// `error` of its guard (the second one: `guard`), or for every one (`every`),
// whose destroy fails 20 ms later. A source whose guard cannot be installed
// keeps the listener of `error` of its send, and is destroyed without the
// error that decides the send (a body longer than its `Content-Length`,
// sent whole, cancelled at the deadline, or destroyed by the application
// later): its late error is logged once. One that refuses every listener of
// `error` is never destroyed (failed by its own `on()`, or released to
// `HEAD`): it is left paused. Nothing may crash the process. One line per
// path: `<path> <status> <outcome> destroyed=<destroyed> paused=<paused>
// errored=<its error> errors=<listeners of error>`, then the late errors
// logged, and the counts of the records of the guards refused and of the
// sources left.
import { Binden, type Context } from "../../index.js";
import { type IncomingMessage, request } from "node:http";
import { capture, pollUntil } from "../helpers.js";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { once } from "node:events";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 20_000).unref();

/** A source of a path, which refuses the listeners of its `error` */
interface IRefusing {
  readonly refuses: "every" | "guard";
  /** What it pushes once read (`null`: nothing, it never ends) */
  readonly body: string | null;
  readonly autoDestroy?: boolean;
}

const specs: Readonly<Record<string, IRefusing>> = {
  "/every": { refuses: "every", body: null },
  "/guard": { refuses: "guard", body: "too long" },
  "/ended": { refuses: "guard", body: "ok" },
  "/later": { refuses: "guard", body: "ok", autoDestroy: false },
  "/deadline": { refuses: "guard", body: null },
  "/head": { refuses: "every", body: "ok" },
};

/**
 * A `Readable` that refuses the listeners of its `error` of a spec, whose
 * destroy fails 20 ms later (with the path)
 */
function refusing(
  path: string,
  { refuses, body, autoDestroy = true }: IRefusing,
): Readable {
  let listeners = 0;
  const source = new Readable({
    autoDestroy,
    read(): void {
      if (body !== null) {
        this.push(body);
        this.push(null);
      }
    },
    destroy(_error, callback): void {
      setTimeout(callback, 20, new Error(`Late failure (${path})`));
    },
  });
  source.on("newListener", (event: string) => {
    if (event === "error") {
      listeners += 1;
      if (refuses === "every" || listeners === 2) {
        throw new Error(`No listener of error #${listeners}`);
      }
    }
  });
  return source;
}

/** How a send has rejected: the code of its error, or else its message */
function rejection(error: unknown): string {
  const { code, message } = error as { code?: unknown; message?: unknown };
  return typeof code === "string" ? code : String(message);
}

/** The sources, and how their sends have settled, by path */
const sources = new Map<string, Readable>();
const outcomes = new Map<string, string>();

const captured = capture();
const middleware = async (context: Context): Promise<void> => {
  const { pathname } = context.url;
  const source = refusing(pathname, specs[pathname]);
  sources.set(pathname, source);
  if (pathname === "/guard") {
    context.response.setHeader("Content-Length", 2);
  }
  const outcome = await context.send(source).then(
    () => "resolved",
    (error: unknown) => `rejected:${rejection(error)}`,
  );
  outcomes.set(pathname, outcome);
  if (pathname === "/later") {
    // By the application, once the send has settled: its destroy fails
    setTimeout(() => {
      source.destroy();
    }, 5);
  }
  if (!context.response.writableEnded) {
    throw new Error("Replied");
  }
};
const options = { logger: captured.logger, log_error_details: true };
const apps = [
  new Binden({ ...options, timeout: 0 }).use(middleware),
  new Binden({ ...options, timeout: 50 }).use(middleware),
];
const ports: number[] = [];
for (const app of apps) {
  const server = app.createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  ports.push((server.address() as AddressInfo).port);
}

const lines: string[] = [];
for (const path of Object.keys(specs)) {
  const port = path === "/deadline" ? ports[1] : ports[0];
  const method = path === "/head" ? "HEAD" : "GET";
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    request({ agent: false, path, method, host: "127.0.0.1", port }, resolve)
      .on("error", reject)
      .end();
  });
  response.resume();
  await once(response, "end");
  lines.push(`${path} ${response.statusCode ?? 0}`);
}

/** The messages of the late errors that have been logged (whatever the message of their record) */
const late = (): string[] =>
  captured.records
    .filter(({ level }) => level === 20)
    .map(
      ({ failure }) => (failure as { message?: unknown } | undefined)?.message,
    )
    .filter(
      (message): message is string =>
        typeof message === "string" && message.startsWith("Late failure"),
    );
// Every late error (`/guard`, `/ended`, `/later` and `/deadline`), then a
// while for any other one
await pollUntil(() => late().length >= 4, 5_000).catch(() => null);
await new Promise((resolve) => {
  setTimeout(resolve, 50);
});
const count = (message: string): number =>
  captured.records.filter(({ msg }) => msg === message).length;
process.stdout.write(
  `${lines
    .map((line) => {
      const [path = ""] = line.split(" ");
      const source = sources.get(path) as Readable;
      const errored = source.errored?.message ?? null;
      return `${line} ${outcomes.get(path)} destroyed=${source.destroyed} errored=${errored} paused=${source.isPaused()} errors=${source.listenerCount("error")}`;
    })
    .join("\n")}\n` +
    `${late().sort().join(", ")}\n` +
    `refused=${count("The release of a stream has failed")} left=${count("A stream could not be released")}\n`,
);
process.exit(0);
