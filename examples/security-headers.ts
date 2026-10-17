// The security headers of every response (the error replies too), set by the first
// middleware: a Content Security Policy with a nonce for the inline scripts of a
// page and `frame-ancestors` against clickjacking, `nosniff`, a referrer policy,
// COOP, and HSTS for the requests that arrived over HTTPS (here at a
// TLS-terminating proxy on this host).
//
//   PORT=3000 node --import tsx examples/security-headers.ts
//   curl -i http://localhost:3000/
import { Binden, type Context, shutdown } from "binden";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

/** The state of a request: the nonce of its inline scripts */
interface IState {
  nonce: string;
}

const securityHeaders = (context: Context<IState>): void => {
  const { nonce } = context.state;
  context.response.set({
    "Content-Security-Policy": [
      "default-src 'self'",
      `script-src 'nonce-${nonce}' 'strict-dynamic'`,
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  // A browser ignores HSTS over plain HTTP: it is sent over HTTPS only
  if (context.request.secure) {
    context.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }
};

const page = (context: Context<IState>): Promise<void> =>
  context.html(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>binden</title></head>
  <body>
    <p id="greeting"></p>
    <script nonce="${context.state.nonce}">
      document.getElementById("greeting").textContent = "Hello, World!";
    </script>
  </body>
</html>
`);

export const app = new Binden<IState>({
  timeout: 30_000,
  // A new nonce for every request
  state: (): IState => ({ nonce: randomBytes(16).toString("base64") }),
  // The TLS-terminating proxy on this host sets `X-Forwarded-Proto`
  trust_proxy: {
    trust: (address: string): boolean =>
      address === "127.0.0.1" || address === "::1",
    headers: "x-forwarded",
  },
})
  .use(securityHeaders)
  .use("/", page)
  .use("/api/status", (context) => context.json({ status: "ok" }));

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
