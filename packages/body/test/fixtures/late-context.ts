// Run by `process.test.ts`, without handlers of the process: what a context
// that only looks like one throws once the parse has started (its response,
// its signal) must be the rejection of the parse, never an uncaught exception
// that crashes the process, and the parse must settle
import { Binden, type Context } from "binden";
import { type IncomingMessage, request } from "node:http";
import type { AddressInfo } from "node:net";
import { BodyParser } from "../../index.js";
import { once } from "node:events";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 10_000).unref();

/** A proxy of `target` whose `name` is a method that throws */
function throwing<T extends object>(target: T, name: string): T {
  return new Proxy(target, {
    get(object, key): unknown {
      if (key === name) {
        return (): never => {
          throw new Error(`${name} of the context`);
        };
      }
      const value: unknown = Reflect.get(object, key, object);
      return typeof value === "function"
        ? (value as () => unknown).bind(object)
        : value;
    },
  });
}

const settled: string[] = [];
const parser = new BodyParser({ limit: 4 });
const app = new Binden().use(async (context: Context) => {
  // The response, or the signal
  const [key, target, name] =
    context.request.url === "/response"
      ? ["response", context.response, "setHeader"]
      : ["signal", new AbortController().signal, "removeEventListener"];
  const replaced = throwing(target, name);
  const ducked = new Proxy(context, {
    get(object, property): unknown {
      return property === key
        ? replaced
        : (Reflect.get(object, property, object) as unknown);
    },
  });
  try {
    await parser.run(ducked);
    settled.push("resolved");
  } catch (error: unknown) {
    settled.push((error as Error).message);
  }
  await context.send("done");
});

const server = app.createServer().listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address() as AddressInfo;

const statuses: number[] = [];
// Over the limit once it is read (chunked), then a body within it
for (const [path, chunks] of [
  ["/response", ["ab", "cdefgh"]],
  ["/signal", ["ab"]],
] as const) {
  const sent = request({
    agent: false,
    host: "127.0.0.1",
    port,
    path,
    method: "POST",
    headers: { "Content-Type": "text/plain" },
  });
  sent.on("error", () => {
    // The connection may close before the body is sent
  });
  const response = new Promise<IncomingMessage>((resolve) => {
    sent.once("response", resolve);
  });
  for (const chunk of chunks) {
    sent.write(chunk);
  }
  sent.end();
  const received = await response;
  received.resume();
  await once(received, "end");
  statuses.push(received.statusCode ?? 0);
}

server.close();
process.stdout.write(`${statuses.join(" ")} | ${settled.join(" | ")}\n`);
