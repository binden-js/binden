// Run by `deferred-reports.test.ts`, without a handler of the process: a
// late error is reported on a later turn (see `reportOnce()`), where a report
// that throws (e.g. a logger of the application whose own `debug()` throws)
// has nobody to throw to. It is ignored, and never crashes the process,
// whatever reports it: a guard, the listener that a settled send keeps, the
// send itself (`reportLate()`), or the framework (a released stream-like
// source of `HEAD`, whose destroy fails later). Prints what each report has
// been given, and the status of the `HEAD`.
import { type AddressInfo, connect } from "node:net";
import { Binden, type Context, releasedFailure } from "../../index.js";
import { EventEmitter, once } from "node:events";
import {
  emitterMethods,
  forwarder,
  guard,
  reportLate,
} from "../../src/stream-like.js";
import type { ILogger } from "@binden/logger";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 20_000).unref();

const reported: string[] = [];

/** A report of a late error that throws, once it has recorded the error */
function report(error: unknown): never {
  reported.push((error as Error).message);
  throw new Error("The report has failed");
}

const guarded = new EventEmitter();
guard(guarded, emitterMethods, report);
guarded.emit("error", new Error("guard"));
const kept = new EventEmitter();
const listener = forwarder(() => null);
kept.on("error", listener.listener);
listener.detach(kept, report);
kept.emit("error", new Error("forwarder"));
reportLate(new EventEmitter(), new Error("reportLate"), report);

/** Logs nothing */
function silent(): void {
  // Not logged
}

/** A logger whose `debug()` throws for a late error, as `report` does */
const logger: ILogger = {
  fatal: silent,
  error: silent,
  warn: silent,
  info: silent,
  debug: (message: string, extra?: Record<string, unknown>): void => {
    if (message === releasedFailure) {
      const failure = extra?.failure as { message?: unknown } | undefined;
      reported.push(String(failure?.message));
      throw new Error("The logger has failed");
    }
  },
  trace: silent,
  child: (): ILogger => logger,
};

const app = new Binden({ logger, log_error_details: true }).use(
  async (context: Context) => {
    const source = Object.assign(new EventEmitter(), {
      pause(): void {
        // Never read
      },
      resume(): void {
        // Never read
      },
      destroy(): void {
        // Fails later, once released
        setTimeout(() => {
          source.emit("error", new Error("framework"));
        }, 5);
      },
    });
    await context.send(source);
  },
);
const server = app.createServer().listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address() as AddressInfo;
const socket = connect(port, "127.0.0.1");
let received = "";
socket.setEncoding("latin1").on("data", (chunk: string) => {
  received += chunk;
});
socket.write("HEAD / HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n");
await once(socket, "close");
for (let wait = 0; wait < 400 && reported.length < 4; wait += 1) {
  await new Promise((resolve) => {
    setTimeout(resolve, 5);
  });
}
// Its later turns
for (let turn = 0; turn < 2; turn += 1) {
  await new Promise(setImmediate);
}
server.close();
const status = /^HTTP\/1\.1 (?<code>\d{3})/u.exec(received)?.groups?.code;
process.stdout.write(`${status ?? "none"} ${reported.join(",")}\n`);
