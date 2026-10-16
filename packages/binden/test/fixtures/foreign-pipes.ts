// Run by `process.test.ts`: request A pipes its source into its own response,
// whose head Node.js refuses (`pipeline()`, an empty source), and also a plain
// pipe into the response of a concurrent request B. The end of its
// `pipeline()` that throws fails A, by the handler of its own exchange, which
// the pipe into B does not replace: no crash, and each request gets its own
// reply (`500` for A, `200` for B), with the promise and the callback forms
// of `pipeline()`, and without the pipe into B.
import { type AddressInfo, connect } from "node:net";
import { Binden, type BindenResponse, type Context } from "../../index.js";
import { PassThrough, pipeline } from "node:stream";
import { once } from "node:events";
import { pipeline as pipelineAsync } from "node:stream/promises";

for (const event of ["unhandledRejection", "uncaughtException"]) {
  process.on(event, (error: unknown) => {
    process.stderr.write(`${event} ${String(error)}\n`);
    process.exit(1);
  });
}
setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 10_000).unref();

const never = (): Promise<void> =>
  new Promise(() => {
    // Never settles
  });
/** The codes of the errors of the pipelines of A, by case */
const rejected: string[] = [];
/** The request B that waits (its response, and what lets it reply) */
interface IWaiting {
  readonly response: BindenResponse;
  reply(): void;
}
const waiting: IWaiting[] = [];

const app = new Binden().use(async (context: Context) => {
  const { pathname, searchParams } = context.url;
  if (pathname === "/b") {
    const { promise, resolve } = Promise.withResolvers<null>();
    waiting.push({
      response: context.response,
      reply: (): void => {
        resolve(null);
      },
    });
    await promise;
    await context.send("B");
    return;
  }
  const other = waiting.shift() as IWaiting;
  const form = searchParams.get("form") as string;
  const track = (error: unknown): void => {
    rejected.push(`${form}:${(error as { code?: string }).code}`);
  };
  const { response } = context;
  response.statusMessage = "bad\n";
  const source = new PassThrough();
  if (form === "promise") {
    pipelineAsync(source, response).catch(track);
  } else {
    pipeline(source, response, track);
  }
  if (searchParams.has("foreign")) {
    new PassThrough().pipe(other.response);
  }
  source.end();
  setTimeout(() => {
    other.reply();
  }, 20);
  await never();
});
const server = app.createServer().listen(0);
await once(server, "listening");
const { port } = server.address() as AddressInfo;

/** Sends a request on a new connection; resolves with what it has received */
function request(path: string): { received: Promise<string> } {
  const socket = connect(port, "localhost");
  let data = "";
  socket.setEncoding("latin1").on("data", (chunk: string) => {
    data += chunk;
  });
  const received = (async (): Promise<string> => {
    await once(socket, "connect");
    socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`);
    const closed = once(socket, "close").then(() => "closed");
    const state = await Promise.race([
      closed,
      new Promise((resolve) => {
        setTimeout(resolve, 300, "open");
      }),
    ]);
    socket.destroy();
    const statuses = data.match(/HTTP\/1\.1 \d{3}/gu) ?? [];
    const body = data.slice(data.indexOf("\r\n\r\n") + 4);
    return `${statuses.map((line) => line.slice(9)).join("+")}(${String(state)}):${body}`;
  })();
  return { received };
}

const results: string[] = [];
for (const form of ["promise", "callback"]) {
  for (const foreign of [true, false]) {
    const b = request("/b");
    while (waiting.length === 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
    }
    const a = request(`/a?form=${form}${foreign ? "&foreign" : ""}`);
    results.push(
      `${form}${foreign ? "+foreign" : ""} A=${await a.received} B=${await b.received}`,
    );
  }
}
server.close();
process.stdout.write(`${results.join("\n")}\n${rejected.sort().join(" ")}\n`);
