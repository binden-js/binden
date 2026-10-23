// Run by `process.test.ts`: the late rejections of `verify`, `parse` and a
// `type` function must not crash the process (`unhandledRejection`), and the
// parser must not keep a request without a reply
import { Binden, BindenError } from "binden";
import { type IncomingMessage, request } from "node:http";
import type { AddressInfo } from "node:net";
import { BodyParser } from "../../index.js";
import { once } from "node:events";

process.on("unhandledRejection", () => {
  process.stderr.write("unhandledRejection\n");
  process.exitCode = 1;
});
setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 10_000).unref();

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Rejects once the deadline has passed */
const late = async (): Promise<never> => {
  await sleep(80);
  throw new Error("A late failure");
};

const app = new Binden({ timeout: 30 })
  .use("/verify", new BodyParser({ verify: late }))
  .use(
    "/verify-binden",
    new BodyParser({
      verify: async (): Promise<never> => {
        await sleep(80);
        throw new BindenError(401);
      },
    }),
  )
  .use("/parse", new BodyParser({ parse: late }))
  .use(
    "/type",
    new BodyParser({
      type: (): "json" =>
        Promise.reject(new Error("A failure")) as unknown as "json",
    }),
  );

const server = app.createServer().listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address() as AddressInfo;

const statuses: number[] = [];
for (const path of ["/verify", "/verify-binden", "/parse", "/type"]) {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    request(
      {
        agent: false,
        path,
        host: "127.0.0.1",
        port,
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      resolve,
    )
      .on("error", reject)
      .end("[]");
  });
  response.resume();
  await once(response, "end");
  statuses.push(response.statusCode ?? 0);
}

// The late failures come after the replies
await sleep(150);
server.close();
process.stdout.write(`${statuses.join(" ")}\n`);
