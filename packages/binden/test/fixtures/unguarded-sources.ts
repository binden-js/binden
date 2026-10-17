// Run by `unguarded-sources.test.ts`, without a handler of the process: a
// stream-like source that refuses every listener of `error` (a listener of
// its `newListener` throws), whose `pause()` and `destroy()` would emit an
// error asynchronously, must be left untouched, whether it is sent (`GET`)
// or released (to `HEAD`, with 204, or refused for 103): neither paused nor
// destroyed, or the process would crash. Prints, by request, its status and
// how its send has settled, then the calls of the code of the sources, and
// the records that tell that a source could not be released.
import { Binden, type Context } from "../../index.js";
import { EventEmitter, once } from "node:events";
import { type IncomingMessage, request } from "node:http";
import type { AddressInfo } from "node:net";
import { capture } from "../helpers.js";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 10_000).unref();

/** The calls of the code of every source */
const calls: string[] = [];

/** A source whose `pause()` and `destroy()` fail asynchronously, which refuses every listener of `error` */
function unguardable(): EventEmitter {
  const source = new EventEmitter();
  source.on("newListener", (event: string) => {
    if (event === "error") {
      throw new Error("No listener of error");
    }
  });
  const failing =
    (name: string): (() => void) =>
    (): void => {
      calls.push(name);
      setImmediate(() => {
        source.emit("error", new Error(`Its ${name} has failed`));
      });
    };
  return Object.assign(source, {
    pause: failing("pause"),
    resume: (): null => null,
    destroy: failing("destroy"),
  });
}

const outcomes: string[] = [];
const captured = capture();
const app = new Binden({ logger: captured.logger }).use(
  async (context: Context) => {
    const status = Number(context.url.pathname.slice(1)) || 200;
    const outcome = await context
      .status(status)
      // @ts-expect-error -- a stream-like source
      .send(unguardable())
      .then(
        () => "resolved",
        (error: unknown) => `rejected:${(error as Error).message}`,
      );
    outcomes.push(outcome);
    if (outcome !== "resolved") {
      context.status(500);
      await context.send(outcome);
    }
  },
);

const server = app.createServer().listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address() as AddressInfo;

const lines: string[] = [];
for (const [method, path] of [
  ["GET", "/"],
  ["HEAD", "/"],
  ["GET", "/204"],
  ["GET", "/103"],
]) {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    request({ agent: false, method, path, host: "127.0.0.1", port }, resolve)
      .on("error", reject)
      .end();
  });
  response.resume();
  await once(response, "end");
  lines.push(`${method} ${path} ${response.statusCode} ${outcomes.at(-1)}`);
}
// The asynchronous failures that a pause or a destroy would have caused
await new Promise((resolve) => {
  setTimeout(resolve, 20);
});
server.close();
const left = captured.records.filter(
  ({ msg }) => msg === "A stream could not be released",
).length;
process.stdout.write(
  `${lines.join("\n")}\ncalls=${calls.join(",") || "none"} left=${left}\n`,
);
