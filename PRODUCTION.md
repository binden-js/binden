# Running binden in production

The defaults of binden suit development: a request has no deadline, a request body has no size
limit, no proxy is trusted, and any host is accepted. This guide sets up a server for production,
one concern at a time; the [checklist](#checklist) at the end sums it up. The
[examples](https://github.com/binden-js/binden/tree/main/examples) are runnable servers that follow
it.

- [Timeouts](#timeouts)
- [Graceful shutdown](#graceful-shutdown)
- [Reverse proxies](#reverse-proxies)
- [Request bodies](#request-bodies)
- [Logging](#logging)
- [Static files](#static-files)
- [Compression](#compression)
- [Server-sent events](#server-sent-events)
- [Security headers](#security-headers)
- [Checklist](#checklist)

## Timeouts

Two layers bound the time that a request takes:

| Setting                                         | Default | Bounds                                                    | Suggestion                                            |
| ----------------------------------------------- | ------- | --------------------------------------------------------- | ----------------------------------------------------- |
| `headersTimeout` (Node.js server)               | 60 s    | Receiving the headers of a request                        | 10–20 s                                               |
| `requestTimeout` (Node.js server)               | 300 s   | Receiving a whole request, its body included (else `408`) | Longer than the slowest upload that you accept        |
| `keepAliveTimeout` (Node.js server)             | 5 s     | Keeping an idle connection open                           | Longer than the idle timeout of the proxy (e.g. 65 s) |
| `timeout` (`Binden`)                            | none    | Handling a request, from its arrival (else `503`)         | 30 s, more for the routes that need it                |
| `error_handler_timeout` (`Binden`)              | 5 s     | A custom `error_handler` (else an empty `500`)            | The default                                           |
| `timeout` of [`shutdown()`](#graceful-shutdown) | 10 s    | Completing the requests in progress at shutdown           | Shorter than the grace period of the platform         |

- `headersTimeout` must not be longer than `requestTimeout` (Node.js throws a `RangeError`).
- Behind a proxy that keeps its connections to the server open (nginx with `keepalive`, a load
  balancer), `keepAliveTimeout` must be longer than the idle timeout of the proxy (60 s for nginx
  and an AWS Application Load Balancer, by default). Otherwise the server may close a connection
  while the proxy sends a request on it, and the client gets a `502 Bad Gateway`.
- The deadline of binden (`timeout`) starts when the request arrives, and covers every middleware,
  the reading of the body included. Once it has passed, `context.signal` is aborted (its reason is
  a `BindenAbortError` of reason `deadline`), the stack stops, and the client gets
  `503 Service Unavailable` (or the connection is closed, when the reply has started). A route
  restarts it with `context.setTimeout(ms)` (from now), or removes it with `context.setTimeout(0)`
  (e.g. for [server-sent events](#server-sent-events)).
- Pass `context.signal` to the work of a request (e.g. `fetch()`, a database query): it stops when
  the client goes away, the deadline passes or the server shuts down.
- The error handler gets the `503` of a deadline (`error.code === "deadline"`) with
  `context.signal` already aborted: its reply must not depend on work bound to the signal, which
  would fail at once (the client would get an empty `500`).

```typescript
import { Binden, type Context, Router } from "binden";
import { Multipart } from "@binden/multipart";

const MiB = 1024 * 1024;
const app = new Binden({ timeout: 30_000 });

// An upload has 2 minutes from the start of its route, its body included
const longer = (context: Context): void => {
  context.setTimeout(120_000);
};
const uploads = new Multipart({
  storage: {},
  limit: 10 * MiB,
  config: {
    limits: { fileSize: 5 * MiB, files: 10, fields: 100, parts: 1000 },
  },
});
app.use(
  "/uploads",
  new Router().post(longer, uploads, (context) => context.status(201).send()),
);

app.route("/users/:id", async (context) => {
  // Stops once the client has gone away or the deadline has passed
  const upstream = await fetch(
    `https://users.example.com/${encodeURIComponent(context.params.id)}`,
    { signal: context.signal },
  );
  await context.json(await upstream.json());
});

app
  .createServer({
    headersTimeout: 20_000,
    requestTimeout: 120_000,
    // Longer than the idle timeout of the proxy (60 s)
    keepAliveTimeout: 65_000,
  })
  .listen(8080);
```

## Graceful shutdown

Platforms stop a process with `SIGTERM`, then kill it with `SIGKILL` once their grace period has
passed (30 s on Kubernetes by default, 10 s for `docker stop`). `shutdown(server)` closes a server
created by `createServer()` or `createSecureServer()` (or registered by `callback()`):

1. at once, the server stops accepting connections, the idle connections are closed (and every
   other one as soon as it is idle), and a request that still arrives on an open connection gets
   `503 Service Unavailable` with `Connection: close`;
2. the requests in progress have `timeout` milliseconds (10 s by default) to complete;
3. then their `context.signal` is aborted (`shutdown`) and every connection is closed;
4. the promise resolves once the server has closed and the cleanups of the requests
   (`context.onCleanup()`) have run, or rejects when they take longer than `cleanup_timeout`
   milliseconds (1 s by default).

```typescript
import { Binden, shutdown } from "binden";
import { Logger } from "@binden/logger";

const logger = new Logger({ level: "info" });
const app = new Binden({ logger, timeout: 30_000 }).use(middleware);
const server = app.createServer({ keepAliveTimeout: 65_000 }).listen(8080);

async function stop(): Promise<void> {
  try {
    // Within the 30 s of Kubernetes: 20 s to drain, 2 s for the cleanups
    await shutdown(server, { timeout: 20_000, cleanup_timeout: 2000 });
  } catch (error) {
    logger.error("The shutdown has not completed", { error });
    process.exitCode = 1;
  } finally {
    await logger.flush();
  }
}

process.once("SIGTERM", () => {
  stop().catch(() => {
    process.exitCode = 1;
  });
});
```

- Let the process exit on its own once nothing else keeps it alive: close the other resources
  (database pools, timers) after `shutdown()`, rather than calling `process.exit()`, which may drop
  the last logs.
- Run `node` as the process that receives the signal (e.g. `CMD ["node", "server.js"]` in a
  Dockerfile): a shell (the shell form `CMD node server.js`) does not pass `SIGTERM` on.
- A load balancer may still send new connections for a few seconds after `SIGTERM` (e.g. while
  Kubernetes removes the endpoints of the pod). A `preStop` hook that sleeps for a few seconds
  delays the signal until then.
- `isClosing(server)` tells whether a server is shutting down, e.g. to end long-lived streams
  before the drain timeout (see [Server-sent events](#server-sent-events)).

## Reverse proxies

binden serves HTTP/1.1 (`createServer()`) and HTTPS (`createSecureServer()`), not HTTP/2
(`node:http2`, also through its compatibility API). Run it behind a reverse proxy or a load
balancer that terminates TLS and serves HTTP/2 (or HTTP/3) to the clients, and talks HTTP/1.1 to
the server (without a proxy, `createSecureServer()` serves HTTPS itself).

### Trusting the proxies

By default, the requests trust no proxy: `request.ip` is the address of the peer (the proxy),
`request.protocol` the one of the connection (`http:` behind a TLS-terminating proxy) and
`request.host` the `Host` header. A client can send any `Forwarded` or `X-Forwarded-*` header, so
trust the headers of the proxies only, by their addresses: a client that reaches the server
directly (e.g. through a network that is not as closed as expected) cannot choose its address,
protocol or host then.

```typescript
import { BlockList, isIPv6 } from "node:net";
import { Binden } from "binden";

// The addresses of the proxies
const proxies = new BlockList();
proxies.addSubnet("10.0.0.0", 8);
proxies.addAddress("127.0.0.1");
proxies.addSubnet("fd00::", 8, "ipv6");

const app = new Binden({
  trust_proxy: {
    trust: (address) =>
      proxies.check(address, isIPv6(address) ? "ipv6" : "ipv4"),
    // X-Forwarded-For, X-Forwarded-Proto and X-Forwarded-Host
    headers: "x-forwarded",
  },
  allowed_hosts: ["example.com", "www.example.com"],
  // nginx sets X-Request-Id (below)
  request_id: { trust_incoming: true },
});
```

Trust only the headers that the proxies overwrite (or append to): a proxy that passes on a header
of its client as it is lets the client choose its value. With several proxies (e.g. a CDN in front
of a load balancer), trust the addresses of all of them. The headers are:

- `"x-forwarded"` for nginx (as below) and an AWS Application Load Balancer, which append the
  address of their client to `X-Forwarded-For` and set `X-Forwarded-Proto` (and, for nginx,
  `X-Forwarded-Host`; the host is `Host` otherwise);
- `"forwarded"` (the default) for the proxies that send `Forwarded` (RFC 7239, e.g.
  `Forwarded: for=192.0.2.60;proto=https;host=example.com`).

The two families are never mixed. A number trusts the nearest hops instead of their addresses
(`trust: 1` for one proxy in front of the server), and `true` trusts every hop: use them only when
nothing else can reach the server. See [Proxies](https://github.com/binden-js/binden/tree/main/packages/binden#proxies)
for the details of the walk through the hops.

```nginx
upstream app {
  server 127.0.0.1:8080;
  keepalive 16;
}

server {
  listen 443 ssl;
  http2 on;
  server_name example.com www.example.com;
  ssl_certificate /etc/ssl/example.com.crt;
  ssl_certificate_key /etc/ssl/example.com.key;
  # The largest request body (1 MiB by default): see the limits of the parsers below
  client_max_body_size 10m;

  location / {
    proxy_pass http://app;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Request-Id $request_id;
  }
}
```

### Allowed hosts

`request.URL` (and the links that an application builds with it) has the host of the request,
which a client chooses: `allowed_hosts` lists the hosts that the effective host may be (`hostname`
on any port, or `hostname:port`), or is a function of the host that returns a boolean. Another
host gets `400 Bad Request` when the application reads `request.URL` or `request.host` (the
routing does). See [Allowed hosts](https://github.com/binden-js/binden/tree/main/packages/binden#allowed-hosts).

### Request ids

Every request has an id (`request.id`), which the logs of binden carry (`request_id` and `id`).
With `request_id: { trust_incoming: true }`, a request keeps the id that it carries
(`X-Request-Id` by default, of 1 to 128 letters, digits, `.`, `_`, `:` and `-`), so that the logs
of the proxy and of the application can be joined: set it only when the proxy sets (or overwrites)
that header, since a client can send any id. With the `request_id` option, the id is sent back in
the response (unless `echo: false`).

## Request bodies

Nothing limits the size of a request body by default: set the limits of every parser explicitly,
and align the limit of the proxy (`client_max_body_size` of nginx) with the largest of them.

### JSON, text and forms

`@binden/body` reads a body into memory. `limit` counts the bytes once decoded, at every stage of
the decoding (a small compressed body may decode to gigabytes), and `encoded_limit` the bytes as
received (a larger `Content-Length` is refused before the body is read). A body over a limit gets
`413 Content Too Large`, and a form with more than `parameter_limit` (1000) parameters too.

```typescript
import { BodyParser } from "@binden/body";

const MiB = 1024 * 1024;

// A route that needs larger bodies has a parser of its own, before the
// shared one: a body is parsed once
app.use(
  "/import",
  new BodyParser({ limit: 50 * MiB, encoded_limit: 10 * MiB }),
);
// JSON, text and forms of every other route (the others are skipped)
app.use(new BodyParser({ limit: MiB, encoded_limit: MiB }));
```

### Uploads

`@binden/multipart` keeps the files in memory by default: each request in progress may then take
as much memory as its body. In production, set every limit, and store the files on the disk (or
stream them to a storage service with `on_file`):

| Option                   | What it limits                               | Suggestion |
| ------------------------ | -------------------------------------------- | ---------- |
| `limit`                  | The whole body, in bytes, all parts included | 10 MiB     |
| `config.limits.fileSize` | A file, in bytes                             | 5 MiB      |
| `config.limits.files`    | The count of the files                       | 10         |
| `config.limits.fields`   | The count of the fields                      | 100        |
| `config.limits.parts`    | The count of the parts (fields and files)    | 1000       |

```typescript
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { type Context, Router } from "binden";
import { type IStoredForm, Multipart } from "@binden/multipart";

const MiB = 1024 * 1024;

const documents = new Multipart({
  limit: 10 * MiB,
  config: {
    limits: { fileSize: 5 * MiB, files: 10, fields: 100, parts: 1000 },
  },
  // A private directory for each request, under this one
  storage: { dir: "/var/tmp/uploads" },
  // What the client declares, not what the file is: check the content too
  file_filter: ({ field, mime_type }) =>
    field === "documents" && mime_type === "application/pdf",
});

const save = async (context: Context): Promise<void> => {
  const { files } = context.request.body as IStoredForm;
  const saved: string[] = [];
  for (const file of files.get("documents") ?? []) {
    // A name of the application: the name sent by the client is not a path
    const target = join("/srv/documents", `${randomUUID()}.pdf`);
    await file.persist(target);
    saved.push(target);
  }
  await context.status(201).json({ saved });
};

app.use("/documents", new Router().post(documents, save));
```

- The files are written in a private directory of the request (`0700`), each to a file of its own
  (`0600`, named by a random UUID). They are removed once the response is closed, also when the
  request is refused or aborted, unless `persist()` has moved them.
- `persist(target)` never replaces a file: a `target` that exists is an `EEXIST` error. It moves a
  file with a hard link when `dir` and `target` are on the same file system, and copies it
  otherwise.
- A copy writes into a new file that it creates itself, and a copy that fails removes only that
  file, while `target` is still it. Persist into a directory that only the application writes to:
  the check and the removal cannot be atomic against another process that renames files there.
- `file_filter` checks what a file declares (its field, its name, its media type), which the
  client chooses: check the content itself (e.g. its first bytes) before the application uses it.
- A request over a limit gets `413 Content Too Large`, and is not read further.

## Logging

```typescript
import { Binden, serializers } from "binden";
import { Logger } from "@binden/logger";

const logger = new Logger({
  level: "info",
  // Those of the default logger of binden (e.g. a `body` is redacted)
  serializers,
  // The fields of the application that may hold secrets
  redact: {
    paths: ["*.password", "*.token", "user.email"],
    censor: "[redacted]",
  },
});

const app = new Binden({
  logger,
  // One record for each request, at `info`, once its response is closed
  access_log: true,
  request_id: { trust_incoming: true },
});
```

- The framework logs its failures as snapshots (`failure`): the type of the error, a known `code`,
  its `status`, the `request_id` and where it happened. The message, the stack and the cause of an
  error are not logged: they may quote the input of a request (e.g. an error of `JSON.parse()`).
  Keep `log_error_details` (and the `error_details` of `@binden/logger`) `false` in production, or
  enable them for a while to investigate a problem, knowing what the logs may then hold.
- The default serializers log the method and the path of a request (without its query), and the
  status of a response: the headers (with the cookies and the credentials), the query strings and
  the bodies stay out of the logs. A path may still hold a secret (e.g. a token in
  `/reset/:token`): the access log logs the route template (`/reset/:token`) by default, not the
  path.
- `context.log` adds the `trace_id` of the request to every record of a middleware.
- The default logger writes nothing unless `BINDEN_LOG_LEVEL` sets a level: pass a logger with
  the `logger` option, or set the variable.
- Call `await logger.flush()` before the process exits (see
  [Graceful shutdown](#graceful-shutdown)).

## Static files

A reverse proxy or a CDN serves static files best. When the application serves them, take the path
from the request only with the `root` option of `sendFile()`:

```typescript
import { Binden } from "binden";

const root = new URL("./public/", import.meta.url);

const app = new Binden().route("/assets/*path", (context) =>
  context.sendFile(context.params.path, {
    root,
    dotfiles: "ignore",
    // The names of the files change with their content
    max_age: 31_536_000,
    immutable: true,
  }),
);
```

- With `root`, the path must be a relative path that stays inside the root, once every symbolic
  link is resolved: an absolute path, an empty, `.` or `..` segment, a missing file or a file that is
  not inside the root gets `404 Not Found`. A dotfile (e.g. `.env`, `.git/config`) gets `404`
  (`dotfiles: "ignore"`, the default) or `403` (`"deny"`).
- The guarantee has limits: the root directory and the directories above it must be trusted (not
  writable by someone who should not choose what is served), and a race in which an attacker who
  can write inside the root replaces a directory of the path by a symbolic link, between the check
  and the open, is not prevented.
- Without `root`, the path is trusted as it is: never pass a path from the request then.
- `immutable` (with `max_age`) suits the files whose names change with their content only.

## Compression

The defaults of `@binden/compression` suit production: the coding is negotiated with
`Accept-Encoding` (`br`, `gzip`, `deflate`), the responses below 1024 bytes and the types that do
not compress (e.g. compressed images, archives, event streams) are sent as they are, and `br` uses
the quality 4. When the proxy (or a CDN) compresses the responses, leave the compression to it:
compressing in both places only costs time.

Compression over TLS can leak a secret of a response that also reflects the input of the request
(e.g. a page with a CSRF token and the query of its URL: [BREACH](https://www.breachattack.com/)).
Do not compress such responses:

```typescript
import { type Context, Router } from "binden";
import compression, { skipCompression } from "@binden/compression";

const account = (context: Context): Promise<void> => {
  // A CSRF token, and the search of the user
  skipCompression(context.response);
  return context.html("<form>…</form>");
};

app.use(compression).use("/account", new Router().get(account));
```

## Server-sent events

A stream of events (`text/event-stream`) is long-lived, so it needs:

- no deadline: `context.setTimeout(0)`, and the stream ends once `context.signal` is aborted;
- an end before the drain timeout of the shutdown: the stream checks `isClosing(server)`, and is
  woken while it waits for its next event by a signal that is aborted on `SIGTERM` (it would wait
  otherwise until the drain timeout aborts `context.signal`);
- no buffering: nginx buffers the responses unless they have `X-Accel-Buffering: no` (or
  `proxy_buffering off`), and closes a stream that is silent for `proxy_read_timeout` (60 s),
  which an event (or a comment, `: ping`) sent now and then prevents;
- with compression, a `filter` that compresses it (events are not compressed by default), and
  `response.flush()` after each event, so that it is not held in the compressor.

```typescript
import { setTimeout as sleep } from "node:timers/promises";
import {
  Binden,
  type ContentType,
  type Context,
  isClosing,
  shutdown,
} from "binden";
import { Compression, isCompressible } from "@binden/compression";

const compression = new Compression({
  filter: (_context: Context, type: ContentType | null): boolean =>
    type?.type === "text/event-stream" || isCompressible(type),
});

// Aborted on `SIGTERM`: it wakes the streams that wait for their next event
const closing = new AbortController();

const events = async (context: Context): Promise<void> => {
  const { response } = context;
  // The end of the request, or of the server
  const signal = AbortSignal.any([context.signal, closing.signal]);
  context.setTimeout(0);
  context.done = true;
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("X-Accel-Buffering", "no");
  for (let id = 1; !signal.aborted && !isClosing(server); id += 1) {
    response.write(`id: ${id}\ndata: ${new Date().toISOString()}\n\n`);
    // The event reaches the client now, through the compressor
    await response.flush();
    await sleep(15_000, undefined, { signal }).catch(() => undefined);
  }
  response.end();
};

const app = new Binden({ timeout: 30_000 }).use(compression);
app.use("/events", events);
const server = app.createServer({ keepAliveTimeout: 65_000 }).listen(8080);

process.once("SIGTERM", () => {
  closing.abort();
  shutdown(server).catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
});
```

## Security headers

binden sets no security headers, and has no package for them: set them in the first middleware,
so that they apply to every response, the error replies included (an error reply removes only the
headers of the body that it replaces). The
[examples](https://github.com/binden-js/binden/tree/main/examples) have a runnable server with
them.

```typescript
import { Binden, type Context } from "binden";

const policy = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

const securityHeaders = (context: Context): void => {
  context
    .setHeader("Content-Security-Policy", policy)
    .setHeader("X-Content-Type-Options", "nosniff")
    .setHeader("Referrer-Policy", "no-referrer")
    .setHeader("Cross-Origin-Opener-Policy", "same-origin");
  // Over HTTPS only (behind a proxy, with `trust_proxy`)
  if (context.request.secure) {
    context.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }
};

// See Reverse proxies for `trust_proxy`
const app = new Binden({
  trust_proxy: { trust: 1, headers: "x-forwarded" },
}).use(securityHeaders);
```

- **CSP.** Start with `Content-Security-Policy-Report-Only` to find what the policy would block,
  then enforce it. An inline script needs a nonce (a new random value for every response, in the
  policy and in the `nonce` attribute of the script) rather than `'unsafe-inline'`. An API that
  sends only JSON can send `default-src 'none'; frame-ancestors 'none'`.
- **HSTS.** Browsers ignore `Strict-Transport-Security` over plain HTTP. Start with a short
  `max-age` (e.g. `300`), raise it once every subdomain is served over HTTPS, and add `preload`
  only to submit the domain to the preload lists. The proxy can set it instead.
- **Cookies.** Name the session cookies with the `__Host-` prefix (`Secure`, the path `/`, no
  domain), keep `http_only` (the default) and `same_site` (`Lax` by default, `Strict` where
  possible).

```typescript
import { Cookie } from "binden";

context.response.cookies.add(
  new Cookie({
    key: "__Host-session",
    value: "<session id>",
    same_site: "Strict",
    max_age: 3600,
  }),
);
```

## Checklist

- **Node.js**: `>=24.14.1`; `headersTimeout`, `requestTimeout` and `keepAliveTimeout` set, the
  latter longer than the idle timeout of the proxy.
- **Deadlines**: `timeout` set (e.g. 30 s); `context.setTimeout()` for the slow routes and
  `context.setTimeout(0)` for the streams; `context.signal` passed to the work of the requests.
- **Shutdown**: `shutdown(server)` on `SIGTERM`, within the grace period of the platform; `node`
  receives the signal; the logs are flushed.
- **Proxy**: TLS and HTTP/2 at the proxy; `trust_proxy` by the addresses of the proxies, with the
  headers that they set (`"x-forwarded"` or `"forwarded"`); `allowed_hosts`;
  `request_id.trust_incoming` only when the proxy sets the id.
- **Bodies**: `limit` and `encoded_limit` for `@binden/body`; `limit` and `config.limits` for
  `@binden/multipart`, with the disk or stream storage; the limit of the proxy aligned.
- **Logs**: a logger at `info`; `access_log: true`; `log_error_details: false`; the secrets of the
  application redacted.
- **Files**: `sendFile()` with `root` for any path from a request, from a trusted root.
- **Compression**: the defaults; `skipCompression()` for the responses that mix secrets and input;
  server-sent events compressed only with a `filter` and `flush()`.
- **Headers**: `Content-Security-Policy`, `Strict-Transport-Security` (over HTTPS),
  `X-Content-Type-Options`, `Referrer-Policy`; `__Host-` cookies.
