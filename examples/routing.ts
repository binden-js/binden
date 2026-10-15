// Routes with parameters, stacks mounted under a prefix, and routers by method.
//
//   PORT=3000 node --import tsx examples/routing.ts
//   curl http://localhost:3000/api/v1/users/42
//   curl http://localhost:3000/files/docs/guide.md
//   curl -i -X DELETE http://localhost:3000/api/v1/users
import { Binden, type Context, Router, Stack, shutdown } from "binden";
import type { AddressInfo } from "node:net";

const users = new Map([
  ["1", { id: "1", name: "Ada" }],
  ["2", { id: "2", name: "Grace" }],
]);

// `/api/:version/users` and `/api/:version/users/:id`. A guarded router passes on the
// methods that it does not have: `405` (or `204` to `OPTIONS`) with `Allow` if nothing
// else handles them.
const usersStack = new Stack()
  .use(
    "/",
    new Router({ guarded: true })
      .get((context: Context) => context.json([...users.values()]))
      .post((context: Context) => context.status(201).json({ created: true })),
  )
  .route(
    "/:id",
    new Router({ guarded: true }).get((context) => {
      const user = users.get(context.params.id);
      if (typeof user === "undefined") {
        return context.throw(404, { expose: true, message: "No such user" });
      }
      return context.json({
        user,
        // The parameters of the mounts too (`version`), and the matched prefix
        params: context.params,
        mount_path: context.mount_path,
      });
    }),
  );

const api = new Stack().mount("/users", usersStack);

export const app = new Binden({ timeout: 30_000 })
  .mount("/api/:version", api)
  // `*path` is the rest of the path (zero or more segments), decoded once
  .route("/files/*path", (context) =>
    context.json({ path: context.params.path }),
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
