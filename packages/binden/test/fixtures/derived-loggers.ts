// Run by `process.test.ts`, without process handlers: a logger derived from
// one of binden (`Object.create(context.log)`, which overrides one method, or
// a proxy of one) logs the failure of a request through the logger of binden,
// and its overridden method is used (by the refusal of `callback()`); one
// whose `getPrototypeOf` trap answers the prototype of binden's loggers while
// its methods throw is ignored; and a context of a middleware whose `log`
// throws once its deadline has passed has its connection closed. The process
// never crashes.
import { type AddressInfo, Socket } from "node:net";
import {
  Binden,
  BindenRequest,
  BindenResponse,
  Context,
  type IMiddleware,
} from "../../index.js";
import {
  IncomingMessage,
  ServerResponse,
  createServer,
  request,
} from "node:http";
import type { ILogger } from "@binden/logger";
import { once } from "node:events";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 10_000).unref();

const messages: string[] = [];
function recorder(): ILogger {
  const record = (message: string): void => {
    messages.push(message);
  };
  return {
    fatal: record,
    error: record,
    warn: record,
    info: record,
    debug: record,
    trace: record,
    child: recorder,
  };
}

/** A logger of binden (`context.log`), whose logger is a recorder */
function bindenLogger(): ILogger {
  const socket = new Socket();
  const message = new BindenRequest(socket);
  return new Context({
    request: message,
    response: new BindenResponse(message),
    logger: recorder(),
  }).log;
}

const overridden: string[] = [];
const derived = Object.assign(Object.create(bindenLogger()) as ILogger, {
  error(message: string): void {
    overridden.push(message);
  },
});
const thrower = (): never => {
  throw new RangeError("A failing logger");
};
const prototype = Object.getPrototypeOf(bindenLogger()) as object;
const lying = new Proxy(
  {
    fatal: thrower,
    error: thrower,
    warn: thrower,
    info: thrower,
    debug: thrower,
    trace: thrower,
    child: thrower,
  },
  { getPrototypeOf: (): object => prototype },
);
const loggers: Record<string, ILogger> = {
  derived,
  proxy: new Proxy(bindenLogger(), {}),
  lying,
};

/**
 * A context whose `log` throws once its deadline has passed: the reply of the
 * deadline fails, and the last resort of the request closes its connection
 */
class Unlogged extends Context {
  public override get log(): ILogger {
    if (this.signal.aborted) {
      throw new RangeError("No logger");
    }
    return super.log;
  }
}
const unlogged: IMiddleware = ({ request: message, response }) =>
  new Unlogged({ request: message, response });

/** Hangs for a context whose `log` throws (until its deadline has passed) */
async function error_handler(context: Context): Promise<void> {
  if (context instanceof Unlogged) {
    await new Promise((resolve) => {
      setTimeout(resolve, 1000).unref();
    });
  }
}

async function status(port: number, path: string): Promise<string> {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    request({ agent: false, path, host: "127.0.0.1", port }, resolve)
      .on("error", reject)
      .end();
  }).catch(() => null);
  if (response === null) {
    return "closed";
  }
  response.resume();
  await once(response, "end");
  return String(response.statusCode);
}

const results: string[] = [];
for (const [name, logger] of Object.entries(loggers)) {
  const app = new Binden({ logger, timeout: 50, error_handler });
  // Its context is the one of the error handler
  app.use("/unlogged", unlogged);
  app.use(() => {
    throw new Error("A failure");
  });
  const server = app.createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  messages.length = 0;
  const statuses = [
    await status(port, "/fails"),
    await status(port, "/unlogged"),
  ];
  const logged = messages.includes("The request has failed");
  // Refused, and logged by the logger of the application itself
  const foreign = new IncomingMessage(new Socket());
  app.callback(createServer())(foreign, new ServerResponse(foreign));
  results.push(
    `${name} ${statuses.join(" ")} ${logged} ${overridden.splice(0).length}`,
  );
  server.close();
}
process.stdout.write(`${results.join("\n")}\n`);
