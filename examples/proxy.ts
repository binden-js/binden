// Behind reverse proxies: their addresses are trusted (a `BlockList`), wherever
// they are in the chain, so that `request.ip`, `.protocol` and `.host` are those
// of the client. `PROXY_HEADERS` names the headers that the proxies send:
// `x-forwarded` (nginx, AWS ALB: `X-Forwarded-For`, `-Proto`, `-Host`, the default)
// or `forwarded` (RFC 7239). The families are never mixed.
//
//   PROXY_HEADERS=x-forwarded PORT=3000 node --import tsx examples/proxy.ts
//   curl -H "X-Forwarded-For: 203.0.113.7" -H "X-Forwarded-Proto: https" \
//     -H "X-Forwarded-Host: example.com" http://localhost:3000/whoami
import { type AddressInfo, BlockList, isIPv6 } from "node:net";
import { Binden, type Context, shutdown } from "binden";

const headers =
  process.env.PROXY_HEADERS === "forwarded" ? "forwarded" : "x-forwarded";

// The proxies: this host, and the private networks of the load balancers
const proxies = new BlockList();
proxies.addAddress("127.0.0.1");
proxies.addAddress("::1", "ipv6");
proxies.addSubnet("10.0.0.0", 8);
proxies.addSubnet("172.16.0.0", 12);
proxies.addSubnet("192.168.0.0", 16);
proxies.addSubnet("fd00::", 8, "ipv6");

const whoami = (context: Context): Promise<void> => {
  const { request } = context;
  return context.json({
    ip: request.ip,
    ips: request.ips,
    protocol: request.protocol,
    host: request.host,
    url: request.URL.href,
    id: request.id,
  });
};

export const app = new Binden({
  timeout: 30_000,
  trust_proxy: {
    // Called synchronously for each hop, from the server outwards
    trust: (address: string): boolean =>
      proxies.check(address, isIPv6(address) ? "ipv6" : "ipv4"),
    headers,
  },
  // The host that a trusted proxy has received (or `Host`) must be one of these
  allowed_hosts: ["example.com", "localhost"],
  // The proxies set `X-Request-Id`: a client cannot choose it
  request_id: { trust_incoming: true },
}).use("/whoami", whoami);

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
