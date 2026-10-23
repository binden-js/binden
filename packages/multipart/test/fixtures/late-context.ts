// Run by `process.test.ts`, without handlers of the process: what a context
// that only looks like one throws once the parse has started (its response),
// and a `file_filter` that throws a value whose check throws, must be the
// rejection of the parse, which settles: never a pending parse, an uncaught
// exception or an `unhandledRejection`
import { Binden, type Context } from "binden";
import { type IncomingMessage, request } from "node:http";
import type { AddressInfo } from "node:net";
import { Multipart } from "../../index.js";
import { once } from "node:events";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 10_000).unref();

/** A proxy of the context whose response has a `setHeader()` that throws */
function ducked(context: Context): Context {
  const response = new Proxy(context.response, {
    get(object, key): unknown {
      if (key === "setHeader") {
        return (): never => {
          throw new Error("setHeader of the context");
        };
      }
      const value: unknown = Reflect.get(object, key, object);
      return typeof value === "function"
        ? (value as () => unknown).bind(object)
        : value;
    },
  });
  return new Proxy(context, {
    get(object, key): unknown {
      return key === "response"
        ? response
        : (Reflect.get(object, key, object) as unknown);
    },
  });
}

const { proxy, revoke } = Proxy.revocable({}, {});
revoke();
const thrown = proxy as Error;
const parsers: Record<string, [Multipart, (context: Context) => Context]> = {
  "/response": [new Multipart({ config: { limits: { fileSize: 2 } } }), ducked],
  "/file-filter": [
    new Multipart({
      file_filter: (): never => {
        throw thrown;
      },
    }),
    (context): Context => context,
  ],
};

const settled: string[] = [];
const app = new Binden().use(async (context: Context) => {
  const [parser, duck] = parsers[String(context.request.url)] as [
    Multipart,
    (context: Context) => Context,
  ];
  try {
    await parser.run(duck(context));
    settled.push("resolved");
  } catch (error: unknown) {
    settled.push((error as Error).message);
  }
  await context.send("done");
});

const server = app.createServer().listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address() as AddressInfo;

const boundary = "binden-boundary";
const body = [
  `--${boundary}`,
  'Content-Disposition: form-data; name="f"; filename="f.txt"',
  "Content-Type: text/plain",
  "",
  "abcdefgh",
  `--${boundary}--`,
  "",
].join("\r\n");

const statuses: number[] = [];
for (const path of Object.keys(parsers)) {
  const sent = request({
    agent: false,
    host: "127.0.0.1",
    port,
    path,
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
  });
  sent.on("error", () => {
    // The connection may close before the body is sent
  });
  const response = new Promise<IncomingMessage>((resolve) => {
    sent.once("response", resolve);
  });
  sent.end(body);
  const received = await response;
  received.resume();
  await once(received, "end");
  statuses.push(received.statusCode ?? 0);
}

server.close();
process.stdout.write(`${statuses.join(" ")} | ${settled.join(" | ")}\n`);
