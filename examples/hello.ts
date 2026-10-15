// The smallest production-shaped application: a deadline for every request, the
// timeouts of the Node.js server, and a graceful shutdown on SIGTERM.
//
//   PORT=3000 node --import tsx examples/hello.ts
//   curl http://localhost:3000/
import { Binden, type Context, shutdown } from "binden";
import type { AddressInfo } from "node:net";

export const app = new Binden({ timeout: 30_000 }).use(
  "/",
  (context: Context): Promise<void> => context.text("Hello, World!"),
);

export const server = app.createServer({
  // The headers of a request must arrive within 20 s, the whole request (its body
  // included) within 120 s
  headersTimeout: 20_000,
  requestTimeout: 120_000,
  // Longer than the idle timeout of a proxy in front (e.g. 60 s for an AWS ALB)
  keepAliveTimeout: 65_000,
});

server.listen(Number(process.env.PORT ?? 3000), () => {
  const { port } = server.address() as AddressInfo;
  process.stdout.write(`Listening on http://localhost:${port}\n`);
});

// The requests in progress have 20 s to complete, then their cleanups 2 s
process.once("SIGTERM", () => {
  shutdown(server, { timeout: 20_000, cleanup_timeout: 2000 }).catch(
    (error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    },
  );
});
