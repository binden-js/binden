// Run by `process.test.ts`, without process handlers: binden writes its own
// records by the private paths of its loggers, and what getting the logger
// or the fields of a record throws drops that record only. A middleware
// replaces the methods (and `child()`) of `context.log` with ones that throw,
// or defines a `log` getter on the context that throws; a middleware returns
// a context of a subclass whose `log` (or `id`) throws; the application's
// logger gives a child whose methods throw; and `child()` (with the methods)
// is replaced after the construction of the application, on a logger of
// binden and on the application's own logger. Each time, every pipelined
// reply arrives (the access log, a failure, a deadline), and the records
// reach the logger unless getting it throws.
import { type AddressInfo, Socket, connect } from "node:net";
import {
  Binden,
  BindenRequest,
  BindenResponse,
  Context,
  type IMiddleware,
} from "../../index.js";
import type { ILogger } from "@binden/logger";
import { once } from "node:events";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 10_000).unref();

const methods = ["fatal", "error", "warn", "info", "debug", "trace"] as const;
const messages: string[] = [];
const thrower = (): never => {
  throw new RangeError("A failing logger");
};

/** A logger that records the messages (and throws once it has, with `fails`) */
function recorder(fails = false): ILogger {
  const record = (message: string): void => {
    messages.push(message);
    if (fails) {
      thrower();
    }
  };
  const logger: ILogger = {
    fatal: record,
    error: record,
    warn: record,
    info: record,
    debug: record,
    trace: record,
    child: () => logger,
  };
  return logger;
}

/** Replaces the methods and `child()` of a logger with ones that throw */
function replace(logger: ILogger): void {
  for (const method of [...methods, "child" as const]) {
    Object.assign(logger, { [method]: thrower });
  }
}

/** A context whose `log` throws */
class Unlogged extends Context {
  // eslint-disable-next-line class-methods-use-this -- a getter that fails
  public override get log(): ILogger {
    return thrower();
  }
}

/** A context whose `id` throws (and so does its `log`, which reads it) */
class Unnamed extends Context {
  // eslint-disable-next-line class-methods-use-this -- a getter that fails
  public override get id(): string {
    return thrower();
  }
}

/** A logger of binden (`context.log`), whose logger is a recorder */
function bindenLogger(): ILogger {
  const message = new BindenRequest(new Socket());
  return new Context({
    request: message,
    response: new BindenResponse(message),
    logger: recorder(),
  }).log;
}

/** A mode that changes nothing in the middleware */
const none = (): void => {
  // Nothing
};

const modes: Record<string, [ILogger, IMiddleware, (logger: ILogger) => void]> =
  {
    replaced: [
      recorder(),
      (context): void => {
        replace(context.log);
      },
      (): void => {
        // Nothing after the construction
      },
    ],
    getter: [
      recorder(),
      (context): void => {
        Object.defineProperty(context, "log", { get: thrower });
      },
      (): void => {
        // Nothing after the construction
      },
    ],
    subclass: [
      recorder(),
      ({ request, response }): Context => new Unlogged({ request, response }),
      (): void => {
        // Nothing after the construction
      },
    ],
    id: [
      recorder(),
      ({ request, response }): Context => new Unnamed({ request, response }),
      (): void => {
        // Nothing after the construction
      },
    ],
    "throwing-child": [
      { ...recorder(), child: (): ILogger => recorder(true) },
      none,
      (): void => {
        // Nothing after the construction
      },
    ],
    "replaced-binden": [bindenLogger(), none, replace],
    "replaced-application": [
      recorder(),
      none,
      (logger): void => {
        logger.child = thrower;
      },
    ],
  };

const requests = ["/ok", "/fails", "/hangs", "/next"]
  .map((path) => `GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`)
  .join("");

const results: string[] = [];
for (const [name, [logger, mode, after]] of Object.entries(modes)) {
  const app = new Binden({ logger, access_log: true, timeout: 50 });
  after(logger);
  app.use(mode);
  app.use(async (context) => {
    const { pathname } = context.url;
    if (pathname === "/fails") {
      throw new Error("A failure");
    } else if (pathname === "/hangs") {
      await new Promise(() => {
        // Never settles: the deadline replies
      });
    }
    await context.send("ok");
  });
  const server = app.createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  messages.length = 0;
  const socket = connect(port, "127.0.0.1");
  let data = "";
  const replied = new Promise<void>((resolve) => {
    socket.setEncoding("latin1").on("data", (chunk: string) => {
      data += chunk;
      if ((data.match(/HTTP\/1\.1 \d+/gu) ?? []).length === 4) {
        resolve();
      }
    });
  });
  socket.write(requests);
  await replied;
  socket.destroy();
  server.close();
  await once(server, "close");
  const statuses = (data.match(/HTTP\/1\.1 \d+/gu) ?? []).map((line) =>
    line.slice(9),
  );
  const completed = messages.filter(
    (message) => message === "The request has completed",
  ).length;
  const failed = messages.includes("The request has failed");
  results.push(`${name} ${statuses.join(" ")} ${completed} ${failed}`);
}
process.stdout.write(`${results.join("\n")}\n`);
