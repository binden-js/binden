// JSON bodies with explicit limits: nothing limits a body by default, and a small
// compressed body may decode to gigabytes.
//
//   PORT=3000 node --import tsx examples/body.ts
//   curl -H "Content-Type: application/json" -d '{"name":"tea"}' http://localhost:3000/items
import { Binden, BindenError, type Context, Router, shutdown } from "binden";
import type { AddressInfo } from "node:net";
import { BodyParser } from "@binden/body";

// 1 MiB as received (`Content-Length`, or counted while it is read) and once
// decoded (`Content-Encoding: gzip`, `br`, `deflate`): a larger body gets `413`
const json = new BodyParser({
  limit: 1024 * 1024,
  encoded_limit: 1024 * 1024,
  type: ["application/json"],
});

interface IItem {
  name: string;
  quantity?: number | undefined;
}

function isItem(value: unknown): value is IItem {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { name, quantity } = value as Partial<IItem>;
  return (
    typeof name === "string" &&
    (typeof quantity === "undefined" || Number.isSafeInteger(quantity))
  );
}

const create = (context: Context): Promise<void> => {
  // The parser skips the other media types (without reading their body): the
  // route requires its own
  if (context.request.content_type?.type !== "application/json") {
    throw new BindenError(415, {
      expose: true,
      message: "Send application/json",
    });
  }
  const { body } = context.request;
  if (!isItem(body)) {
    throw new BindenError(422, { expose: true, message: "Invalid item" });
  }
  return context
    .status(201)
    .json({ name: body.name, quantity: body.quantity ?? 1 });
};

export const app = new Binden({ timeout: 30_000 }).use(
  "/items",
  new Router().post(json, create),
);

export const server = app.createServer({
  headersTimeout: 20_000,
  requestTimeout: 120_000,
  keepAliveTimeout: 65_000,
});

server.listen(Number(process.env.PORT ?? 3000), () => {
  const { port } = server.address() as AddressInfo;
  process.stdout.write(`Listening on http://localhost:${port}\n`);
});

process.once("SIGTERM", () => {
  shutdown(server, { timeout: 20_000, cleanup_timeout: 2000 }).catch(
    (error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    },
  );
});
