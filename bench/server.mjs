// The server of the benchmark (see README.md): a binden application on an
// ephemeral port of the loopback interface, run in a child process so that
// the client does not take its CPU. It tells its port to the parent process.
import { Binden, Router, shutdown } from "binden";
import { BodyParser } from "@binden/body";
import { Compression } from "@binden/compression";

/** A text of 16 KiB, which compresses well */
const large = "binden: a simple HTTP framework\n".repeat(512);

const app = new Binden()
  .route(
    "/hello",
    new Router().get((context) => context.text("Hello, World!")),
  )
  .route(
    "/json",
    new Router().get((context) =>
      context.json({ hello: "world", list: [1, 2, 3], nested: { ok: true } }),
    ),
  )
  .route(
    "/users/:user/posts/:post",
    new Router().get((context) => context.json(context.params)),
  )
  .route(
    "/echo",
    new BodyParser({ limit: 1024 * 1024, encoded_limit: 1024 * 1024 }),
    new Router().post((context) => context.json(context.request.body)),
  )
  .route(
    "/large",
    new Compression(),
    new Router().get((context) => context.text(large)),
  );

const server = app.createServer({ keepAliveTimeout: 60_000 });

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  process.send({ port });
});

process.on("disconnect", () => {
  shutdown(server, { timeout: 1000 }).catch(() => {
    process.exitCode = 1;
  });
});
