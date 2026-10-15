# Binden [![CI Status](https://github.com/binden-js/binden/actions/workflows/ci.yml/badge.svg)](https://github.com/binden-js/binden/actions/workflows/ci.yml) [![version](https://img.shields.io/npm/v/binden?style=plastic)](https://www.npmjs.com/package/binden) [![Coverage Status](https://coveralls.io/repos/github/binden-js/binden/badge.svg?branch=main)](https://coveralls.io/github/binden-js/binden?branch=main) [![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://github.com/prettier/prettier) [![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](https://github.com/binden-js/binden/blob/main/CODE_OF_CONDUCT.md) [![semantic-release](https://img.shields.io/badge/semantic--release-conventional--commits-e10079.svg?logo=semantic-release)](https://github.com/semantic-release/semantic-release) [![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg)](https://conventionalcommits.org) ![node version](https://img.shields.io/node/v/binden) ![npm downloads](https://img.shields.io/npm/dt/binden) [![License](https://img.shields.io/npm/l/binden)](https://github.com/binden-js/binden/blob/main/packages/binden/LICENSE)

A simple server framework (written in [TypeScript](https://www.typescriptlang.org/)).

## Installation

```bash
npm install binden
```

## Usage

### Binden

An application is a `Binden`: the root [stack](#stack-and-routing), whose options apply to every request (they are validated by the constructor: an invalid option throws a `TypeError` or a `RangeError`).

| Option                                                                   | Default                                  | Description                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `access_log`                                                             | `false`                                  | Logs every request once its response is closed: `true`, or `{ level, path }` (see [Access log](#access-log))                                                                                                                    |
| `auto_head`                                                              | `true`                                   | A router without `HEAD` middlewares handles `HEAD` with its `GET` middlewares (see [Router](#router))                                                                                                                           |
| `error_handler`                                                          | none                                     | Replaces the default reply to an error (see [Errors](#errors))                                                                                                                                                                  |
| `error_handler_timeout`                                                  | `5000`                                   | The milliseconds that the `error_handler` has to settle (an integer from 1 to 2³¹−1)                                                                                                                                            |
| `etag`                                                                   | `false`                                  | A strong `ETag` for the `200` responses to `GET` and `HEAD`, and `304 Not Modified` when `If-None-Match` matches it (see the dynamic `ETag` of [BindenResponse](#bindenresponse))                                               |
| `timeout`                                                                | `0` (none)                               | The deadline of every request in milliseconds (an integer from 0 to 2³¹−1, see [Lifecycle](#lifecycle))                                                                                                                         |
| `logger`                                                                 | silent unless `BINDEN_LOG_LEVEL` is set  | See [Logging](#logging)                                                                                                                                                                                                         |
| `log_error_details`                                                      | `false`                                  | Whether the errors that the framework logs include their message, stack, cause and any `code` (they may quote the input of a request, see [Logging](#logging))                                                                  |
| `routing`                                                                | `{ case_sensitive: true, strict: true }` | The matching of the patterns of `route()` and `mount()`: `case_sensitive: false` compares their literal segments without their case, and `strict: false` ignores one trailing `/` (see [Stack and routing](#stack-and-routing)) |
| `state`                                                                  | `() => ({})`                             | Creates `context.state` for every request, synchronously (required by the types when the state has required fields; a promise fails the request)                                                                                |
| `trust_proxy`, `allowed_hosts`, `request_id`, `encoded_slashes`, `query` | see [Request options](#request-options)  | The options of the requests                                                                                                                                                                                                     |

- `.createServer()` - create a server (HTTP)

```typescript
import { Binden } from "binden";

const app = new Binden()
  .use(new RegExp("path"), middleware)
  .use("/path2", router);
const server = app.createServer();
```

- `.createSecureServer()` - create a server (HTTPS)

```typescript
import { Binden } from "binden";

const app = new Binden().use("/path", middleware).use("/path2", router);
const secureServer = app.createSecureServer({ key, cert });
```

- `.serverOptions()` and `.callback(server)` - the request and response classes of the application, and the request listener of a server created with them (e.g. a server of another library). `.callback(server)` registers the server for [`shutdown()`](#shutdown) at once; a request of a server created without these classes is logged (`error`), and its connection closed. HTTP/2 is not supported: use a reverse proxy in front.

```typescript
import { createServer } from "node:http";
import { Binden } from "binden";

const app = new Binden().use(middleware);
const server = createServer({
  ...app.serverOptions(),
  keepAliveTimeout: 65_000,
});
server.on("request", app.callback(server));
```

The state of a request is typed by the application, and so is every middleware added to it:

```typescript
import { Binden } from "binden";

interface IState {
  user: string | null;
}

const app = new Binden<IState>({ state: () => ({ user: null }) });
app.use((context) => {
  context.state.user = context.request.header("x-user") as string | null;
});
```

Middlewares typed for the default state (such as the `Middleware` classes of other packages) can be used with any state. A function middleware typed for the default state (`(context: Context) => …`) needs a state declared as a `type` (an `interface` has no index signature).

### Stack and routing

A `Stack` holds middlewares and routers by path. It has no options: the options of the application apply to every stack mounted in it (a `Binden` is a stack too, but it cannot be mounted).

- `.use()` - add middlewares and routers for every path, for an exact path (a string, compared as received) or for the paths that a RegExp matches (a RegExp keeps its flags, except `g` and `y`, which would make `test()` stateful)

```typescript
import { Binden, type Context } from "binden";

const app = new Binden().use(middleware1).use(router2);
app.use("/path", middleware2, router2);
app.use(new RegExp("path"), router3, middleware1);
const middleware3 = (context: Context): Promise<void> =>
  context.json({ message: "Hello World!" });
app.use("/path2", middleware3);
```

- `.route()` - add middlewares and routers for the paths that a pattern matches, with its parameters in `context.params` (typed from the pattern):
  - `:name` matches one non-empty segment, and `*name` (the last segment only) the rest of the path (zero or more segments);
  - a name is `[A-Za-z_][A-Za-z0-9_]*`, and `\:` and `\*` are a literal `:` and `*`;
  - the path is split into its segments first, then every parameter (and every segment of `*name`) is decoded once: a parameter that is not valid percent-encoded UTF-8 is `400 Bad Request`, and so is one with an encoded `/` or `\` (`%2F`, `%5C`) unless the `encoded_slashes` option is `true` (see [Encoded slashes](#encoded-slashes)). Literal segments are compared once decoded (write them decoded);
  - a pattern without a leading `/`, with an empty or duplicate name, a `*name` that is not last, or a `:` or `*` inside a segment (unless escaped) throws a `TypeError`.

```typescript
import { Binden } from "binden";

const app = new Binden()
  .route("/users/:id", (context) => context.json({ id: context.params.id }))
  .route("/files/*path", (context) => context.text(context.params.path));
```

- `.mount()` - add middlewares, routers and other stacks for the paths under a prefix (the pattern of `route()`, without `*name`), on a segment boundary (`/api` matches `/api` and `/api/x`, not `/apix`). The mounted items see the rest of the path (`/` when there is none); the parameters of the prefix are added to `context.params`, and `context.mount_path` is the matched prefix (both are restored once the mounted items are done). A stack can be mounted in several places, but not in itself (directly or through other stacks: a `TypeError`).

```typescript
import { Binden, Router, Stack } from "binden";

const users = new Stack()
  .use(
    "/",
    new Router().get((context) => context.json([])),
  )
  .route("/:id", (context) =>
    context.json({ id: context.params.id, path: context.mount_path }),
  );
const app = new Binden().mount("/api/users", users);
```

- `.off()` - remove middlewares and routers added by `.use()` (returns the removed items)

```typescript
import { Binden } from "binden";

const app = new Binden().use("/path", middleware1).use(middleware2);
// `.off()` returns the removed items
const removed = app.off("/path", middleware1);
```

- `.stack` - a copy of the layers of the stack: their items, and their path (a string, a RegExp, `null` for every path, `{ route }` or `{ mount }`)

### Logging

Every context logs through `context.log`: a child (with the `trace_id` of the context) of the logger of the application. Its calls never fail: a logger that throws (or whose `child()` throws) is ignored, and a promise it returns is observed (a `child()` that returns one, or anything but a logger, gives the logger itself), so that logging never breaks the handling of a request (also in the other packages, which log through it).

The framework logs only snapshots that it builds itself, under the `failure` key: the type of the error (the nearest of `BindenError`, `BindenAbortError` and the built-in error classes, never a name that the error defines), its `code` when it is a system error code (such as `ECONNRESET`), one of a few stream and HTTP codes (such as `ERR_STREAM_PREMATURE_CLOSE`) or a code of the framework (`deadline`, `aborted`), its `status`, the `request_id` and the `location` in the framework (`middleware`, `error_handler`, `send`, `cleanup` or `shutdown`). The message, the stack, the cause and any other `code` of an error may quote the input of a request (e.g. an error of `JSON.parse()`): they are added only with the `log_error_details: true` option.

```json
{
  "level": 50,
  "trace_id": "3f6c…",
  "failure": {
    "type": "TypeError",
    "status": 500,
    "location": "middleware",
    "request_id": "3f6c…"
  },
  "msg": "The request has failed"
}
```

The default logger (see [`@binden/logger`](https://github.com/binden-js/binden/tree/main/packages/logger)) is created when an application (or a context) first needs it. It is silent unless the `BINDEN_LOG_LEVEL` environment variable sets a level, and its `serializers` log an allowlist of details only, which keeps credentials and the input of the requests out of the logs:

- a `request` is its method and its path (without the query string and the fragment, nor the scheme, authority and userinfo of an absolute-form request-target; anything secret in the path itself, e.g. a token, is logged);
- a `response` is its status code;
- a `context` is its `id`, request and response (not the fields the application sets on it);
- a `body` that the application logs (e.g. `context.log.debug({ body }, "Received")`) is redacted (the body parsers never log the bodies themselves);
- an `error` (and `err`, the key under which `pino` logs an `Error`) is reduced to its type, a known `code` and its `status`, as in the snapshots.

A value of another kind under these keys is reduced to its type. A custom logger (for example with another level or destination, or to log more details) is passed with the `logger` option: any object with the methods of `ILogger` (`fatal`, `error`, `warn`, `info`, `debug`, `trace` and `child`). The default `serializers` are exported to build on, and `createSerializers({ error_details: true })` creates them with an `error` that adds its message, its stack, its cause and any `code` (which may quote the input of a request). The `error_details` option of `@binden/logger` does not apply to them: the `error` of binden replaces the one of the logger.

```typescript
import { Binden, createSerializers, serializers } from "binden";
import { Logger } from "@binden/logger";

const logger = new Logger({ level: "debug", serializers });
const app = new Binden({ logger });

// Log the request bodies, and the details of the errors, as well: those that
// the application logs (`error`) and those of the framework (`failure`)
const verbose = new Logger({
  level: "debug",
  serializers: {
    ...createSerializers({ error_details: true }),
    body: (body: unknown): unknown => body,
  },
});
const debugApp = new Binden({ logger: verbose, log_error_details: true });
```

### Access log

With the `access_log` option, every request is logged once (at `info`, or at `debug` with `{ level: "debug" }`) when its response is closed, also when it has been aborted:

| Field         | Description                                                                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `method`      | The method of the request                                                                                                                            |
| `route`       | The templates of the matched mounts and of the layer that has started the reply (e.g. `/api/users/:id`), or `<unmatched>` (a reply of the framework) |
| `path`        | The path of the request, without its query (with `{ path: "path" }` only: it may name a user or a resource)                                          |
| `status`      | The status of the response, or `null` when it has been aborted before its headers were sent                                                          |
| `duration_ms` | The milliseconds from the request to the close of its response                                                                                       |
| `body_bytes`  | The bytes of the body, as written (e.g. compressed), without the headers                                                                             |
| `id`          | The id of the request                                                                                                                                |
| `aborted`     | Whether the request has been aborted (see [Lifecycle](#lifecycle))                                                                                   |

The `route` of a `use()` without a path is the template of its mounts (`*` at the root), and the replies of the framework (its `404`, `405` and the `204` of `OPTIONS`) are `<unmatched>`.

```typescript
import { Binden } from "binden";

const app = new Binden({ access_log: { level: "info", path: "template" } });
```

### Lifecycle

Every request has an abort signal, `context.signal`, aborted at most once (its `reason` is a `BindenAbortError`, whose `reason` says why):

- `client_closed` - the connection has closed before the response has finished;
- `deadline` - the deadline of the request has passed;
- `shutdown` - the server is shutting down, and its drain time has passed.

The deadline of a request is the `timeout` option of `Binden` (none by default). A middleware restarts it from now with `context.setTimeout(ms)`, or removes it with `context.setTimeout(0)` (e.g. for a stream of server-sent events). Once the deadline has passed:

- the stack stops: no other middleware runs, and the result of the running one is ignored (a later failure is logged at `debug`). Its later replies through the context or the response (`send()`, `json()`, `text()`, `html()`, `form()`, `redirect()`, `sendFile()` and `flush()`) do nothing, so that they cannot replace the reply of the error handler. The methods of Node.js (`write()`, `end()`, `writeHead()`, `flushHeaders()`, or a stream piped into the response) are not guarded: a middleware that writes with them must stop once `context.signal` is aborted;
- a request whose reply has not started gets a `BindenError(503, { code: "deadline" })`, which goes to the error handler;
- a reply that has started (or a response that has not finished once the stack has completed) is cut by closing the connection.

`context.onCleanup(fn)` runs `fn` once the response is closed (finished, or its connection closed), after the functions registered later; a failure is logged.

```typescript
import { Binden, type Context } from "binden";

const app = new Binden({ timeout: 30_000 }).use(async (context: Context) => {
  // Stops waiting once the client has gone away or the deadline has passed
  const upstream = await fetch("https://example.com/", {
    signal: context.signal,
  });
  context.onCleanup(() => {
    context.log.debug("The request is complete");
  });
  await context.text(await upstream.text());
});
```

### Shutdown

`shutdown(server, { timeout = 10000, cleanup_timeout = 1000 })` closes a server gracefully (a server created by `createServer()`, `createSecureServer()` or registered by `callback()`):

1. at once, `isClosing(server)` becomes `true`, the server stops accepting connections, and the idle connections are closed (and every other one as soon as it is idle). The newest response of every connection gets `Connection: close` when its headers are sent (the pipelined requests before it get their responses first). A request that still arrives on an open connection gets `503 Service Unavailable` with `Connection: close`, without running the stack (and the responses before it keep the connection open for it);
2. the requests in progress have `timeout` milliseconds to complete;
3. then, at once, their signal is aborted (`shutdown`), and every connection is closed, including those that have been upgraded (e.g. WebSocket) or tunnelled (`CONNECT`);
4. the promise resolves once the server has closed and the cleanups of the requests (see `context.onCleanup()`) have run. Cleanups that take longer than `cleanup_timeout` milliseconds once the server has closed reject it (and are logged).

Another call returns the same promise. A server that is not listening (before `listen()`, or once closed) only waits for the cleanups of its requests. A server whose `listen()` has not completed yet (e.g. while the address of a host name is looked up) is closed once it listens; when its `listen()` fails, the promise rejects with that error (and logs it).

```typescript
import { Binden, shutdown } from "binden";

const app = new Binden({ timeout: 30_000 }).use(middleware);
const server = app.createServer().listen(8080);

process.once("SIGTERM", () => {
  shutdown(server, { timeout: 10_000 }).then(
    () => {
      process.exitCode = 0;
    },
    (error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    },
  );
});
```

### Context

- `.log` - get the logger: a child of the logger of the application, with the `trace_id` of the context, whose calls never fail (see [Logging](#logging))

```typescript
const { log } = context;
log.info("Hello World", { data: 100 });
```

- `.setHeader()` - Set a response header

```typescript
const name = "X-HEADER";
const value = ["value1", "value2"];
context.setHeader(name, value);
```

- `.status()` - set the response status

```typescript
context.status(401);
```

- `.request` - get the original request object (`instanceof BindenRequest`)

```typescript
const { request } = context;
```

- `.response` - get the original response object (`instanceof BindenResponse`)

```typescript
const { response } = context;
```

- `.id` - get `id` of the context (generated by the [randomUUID()](https://nodejs.org/dist/latest/docs/api/crypto.html#crypto_crypto_randomuuid_options) function and logged as `trace_id` by the `context.log`)

```typescript
const { id } = context;
```

- `.signal`, `.setTimeout()` and `.onCleanup()` - the abort signal, the deadline and the cleanups of the request (see [Lifecycle](#lifecycle))
- `.state` - the state of the request, shared by every context of the request (see the `state` option of [Binden](#binden))
- `.params` and `.mount_path` - the parameters of the matched route and mounts, and the matched mount prefixes (see [Stack and routing](#stack-and-routing))

```typescript
import { Binden } from "binden";

new Binden().route("/users/:id", async (context) => {
  context.setTimeout(5000);
  context.onCleanup(() => {
    context.log.debug("Done", { id: context.params.id });
  });
  await context.json({ id: context.params.id, state: context.state });
});
```

- `.done` - stop passing the `context` to the following middlewares. The middleware should have started the response by then (e.g. `.send()` or a stream piped into it, even if not awaited); otherwise an empty response is sent, with the status and headers set so far. A middleware that starts the response without setting `.done` must finish it: the request is not passed on as `404 Not Found`.

```typescript
import { type Context, Middleware } from "binden";

class MyMiddleware extends Middleware {
  public run(context: Context): void {
    context.done = true; // Stop passing the `context` to other middlewares
  }
}
```

or with a function

```typescript
import type { Context } from "binden";

const MyMiddleware = (context: Context): void => {
  context.done = true;
};
```

- `.url` - parsed `URL` object

```typescript
const {
  log,
  url: { search },
} = context;
log.trace("url search string", { search });
```

- `.send()` - execute `context.response.send()` and set `context.done` to `true`. Like `.json()`, `.text()`, `.html()`, `.form()` and `.sendFile()`, it logs a warning when the response has already been started (e.g. a second reply, which is not sent), and does nothing once the deadline has passed (see [Lifecycle](#lifecycle))

```typescript
const data = "Hello World!";
await context.send(data);
// or
await context.response.send(data);
context.done = true;
```

- `.json()` - execute `context.response.json()` (any JSON value) and set `context.done` to `true`

```typescript
const json = { message: "Hello World!" };
await context.json(json);
// or
await context.response.json(json);
context.done = true;
```

A custom `stringify` function (e.g. [fast-json-stringify](https://github.com/fastify/fast-json-stringify)) can be passed as the second argument.

```typescript
const { default: fastJSON } = await import("fast-json-stringify");
const stringify = fastJSON({
  title: "Example Schema",
  type: "object",
  properties: {
    currency: {
      type: "string",
    },
    value: {
      type: "integer",
    },
  },
  required: ["currency", "value"],
  additionalProperties: false,
});
const json = { currency: "💶", value: 120 };
await context.json(json, stringify);
// or using `BindenResponse`
await context.response.json(json, stringify);
context.done = true;
```

- `.text()` - execute `context.response.text()` and set `context.done` to `true`

```typescript
const text = "Hello World!";
await context.text(text);
// or
await context.response.text(text);
context.done = true;
```

- `.html()` - execute `context.response.html()` and set `context.done` to `true`

```typescript
const html = "<html></html>";
await context.html(html);
// or
await context.response.html(html);
context.done = true;
```

- `.form()` - execute `context.response.form()` and set `context.done` to `true`

```typescript
const form = new URLSearchParams({ a: "1" });
await context.form(form);
// or
await context.response.form(form);
context.done = true;
```

- `.sendFile()` - execute `context.response.sendFile()` (with its options, see [BindenResponse](#bindenresponse)) and set `context.done` to `true`

```typescript
const path = "<path to file>";
await context.sendFile(path, { max_age: 3600 });
// or
await context.response.sendFile(path, { max_age: 3600 });
context.done = true;
```

- `.redirect()` - execute `context.response.redirect()` (`302 Found` by default, to the same origin unless `allow_external`) and set `context.done` to `true`

```typescript
await context.redirect("/login", 303);
await context.redirect("https://example.com/", 302, { allow_external: true });
```

- `.attachment()`, `.type()`, `.vary()` and `.clearCookie()` - execute those of `context.response` (they set headers, and return the context: `done` is set by the method that sends)

```typescript
await context
  .attachment("report.csv")
  .type("text/csv")
  .vary("Accept-Language")
  .clearCookie("session", { path: "/" })
  .send("a,b\n1,2\n");
```

- `.throw()` - throw `BindenError`

```typescript
context.throw(402, { json: { error: "Payment Required" }, expose: true });
```

### Middleware

Any middleware should be extended from the abstract `Middleware` class and implement the `.run()` method

```typescript
import { randomInt } from "crypto";
import { Middleware, Context } from "binden";

export class MyMiddleware extends Middleware {
  public async run(context: Context): Promise<void> {
    const randomNumber = await new Promise<number>((resolve, reject) => {
      randomInt(1, 100, (error, n) => {
        if (error) {
          reject(error);
        } else {
          resolve(n);
        }
      });
    });

    if (randomNumber <= 50) {
      context.throw(400, {
        message: "Generated number is less than or equal to 50",
        expose: true,
      });
    }

    return context.json({ message: "Generated number is greater than 50" });
  }
}
```

- `.disabled` - One can disable a middleware at any time

```typescript
import { Middleware, Context } from "binden";

export class MyMiddleware1 extends Middleware {
  public run(context: Context): Promise<void> {
    return context.json({ message: "Hello World" });
  }
}

const mm1 = new MyMiddleware1({ disabled: true });

// Enable or disable `mm1` every hour
setInterval(
  () => {
    mm1.disabled = !mm1.disabled;
  },
  1000 * 60 * 60,
).unref();
app.use(mm1);
```

- `.ignore_errors` - ignore errors from `await this.run(context)`

```typescript
import { Middleware, Context } from "binden";

export class MyMiddleware1 extends Middleware {
  public run(context: Context): Promise<void> {
    if (this.ignore_errors) {
      return context.json({ message: "Hello World" });
    }
    context.throw(400);
  }
}

const mm1 = new MyMiddleware1({ ignore_errors: true });

// Throw the errors of `mm1.run()` every other minute
setInterval(() => {
  mm1.ignore_errors = !mm1.ignore_errors;
}, 1000 * 60).unref();
app.use(mm1);
```

A middleware may return a context, which replaces the current one for the following middlewares: it must have the request and the response of the current context (otherwise the middleware fails with a `TypeError`).

### Router

A `Router` holds middlewares by method, for a path of the stack:

```typescript
import { Binden, type Context, Router } from "binden";

const router = new Router()
  .get((context: Context) => context.json({ items: [] }))
  .post((context: Context) => context.status(201).send())
  .on("PROPFIND", (context: Context) => context.status(207).send());
const app = new Binden().use("/items", router);
```

- `.get()`, `.head()`, `.post()`, `.put()`, `.patch()`, `.delete()`, `.options()`, `.trace()`, and `.on()` for any other method, in any case (`.on("propfind")` is `PROPFIND`): a method must be an HTTP token, and `CONNECT` throws a `TypeError` (Node.js emits its requests as `connect` events of the server: they never reach the middlewares). `.off()` removes middlewares, and `.methods` lists the methods that have some.
- `HEAD` is handled by the `HEAD` middlewares of a router, or else by its `GET` middlewares (unless the `auto_head` option of `Binden` is `false`). A response to `HEAD` sends no body.
- A `guarded` router (`new Router({ guarded: true })`) that does not allow the method of a request passes it on. When nothing else handles the request, it gets `405 Method Not Allowed`, whose `Allow` lists the methods of every guarded router that has refused it (with `HEAD` for `GET` when `auto_head` is `true`, and `OPTIONS`). An `OPTIONS` request that none of them has middlewares for gets `204 No Content` with the same `Allow` instead; their own `OPTIONS` (or `HEAD`) middlewares take precedence.
- `OPTIONS *` (the server as a whole) gets `204 No Content` without running the stack, with an `Allow` that lists the methods of every router of the application (in every stack, with `HEAD` for `GET` when `auto_head` is `true`, and `OPTIONS`).

```typescript
import { Binden, type Context, Router } from "binden";

const list = new Router({ guarded: true }).get((context: Context) =>
  context.send("list"),
);
const create = new Router({ guarded: true }).post((context: Context) =>
  context.status(201).send(),
);
// `DELETE /items` gets 405, and `OPTIONS /items` 204, with
// `Allow: GET, HEAD, POST, OPTIONS`
const app = new Binden().use("/items", list, create);
```

### Errors

A middleware that throws (or rejects) passes the error to the error handler. The default one:

- replies with the `status` of the error when it is an integer from 400 to 599 (e.g. of a [`BindenError`](#bindenerror)), and `500 Internal Server Error` otherwise (for any thrown value, also `null`), with the `headers` of a `BindenError` and its exposed `json` or `message`. The headers set for the body that is not sent (its framing, representation and validators, e.g. `Content-Type`, `Content-Language`, `Content-Length`, `Content-Encoding` or `ETag`) are removed, so that an exposed `message` is never sent as the type of the route (e.g. as HTML), and the cookies of the response are sent;
- logs a server error (5xx) at `error`, and a client error (4xx) at `debug` (see [Logging](#logging));
- cuts a reply that has already started by closing the connection, and leaves a reply that has ended.

The `error_handler` option replaces it. It gets the context and the thrown value (which may be anything, also `null`), may be `async` (it is awaited), and must have ended its reply when it settles: nothing started then gets the default reply, while a reply that is not ended (e.g. a `write()` without `end()`) is cut by closing the connection. A handler that throws, rejects or does not settle within `error_handler_timeout` gets an empty `500 Internal Server Error` instead (without the framing and representation headers it may have set), or the connection is closed when its reply has started; its later reply is ignored, and its later failure is logged (`debug`).

```typescript
import { Binden, BindenError, type Context } from "binden";

const app = new Binden({
  error_handler: async (context: Context, error: unknown): Promise<void> => {
    const status = error instanceof BindenError ? error.status : 500;
    await context.status(status).json({ error: status });
  },
});
```

### BindenError

`BindenError` represents an HTTP error, with a status code from 400 to 599 (an integer: anything else throws a `TypeError`, and one out of this range a `RangeError`). Its options:

- `expose` (a boolean, `false` by default) - whether the default error handler sends `json` (as `application/json`) or `message` (as `text/plain; charset=utf-8`); otherwise the reply is empty;
- `json` (a plain object), `message` (a string, by default the reason phrase of the status) and `cause`: another `expose`, `json` or `message` throws a `TypeError`;
- `code` - a machine-readable reason (such as `deadline`), which is logged but not sent;
- `headers` - headers that the default error handler sends with the error (e.g. `Allow`, `Retry-After` or `WWW-Authenticate`). They are copied (and frozen) when the error is created, and checked: an invalid name or value (e.g. with `CR` or `LF`), a duplicate name, or a header of the framing, the representation or the connection (`Content-Length`, `Transfer-Encoding`, `Content-Encoding`, `Content-Range`, `Content-Type` or `Connection`) throws a `TypeError`.

```typescript
import { BindenError } from "binden";

throw new BindenError(429, {
  expose: true,
  json: { error: "Too many requests" },
  headers: { "Retry-After": "60" },
});
```

```typescript
import { Middleware, Context, BindenError } from "binden";

export class MyMiddleware extends Middleware {
  public async run(context: Context): Promise<void> {
    const { length } = context.request.cookies;

    if (!length) {
      const status = 401;
      const expose = true;
      const message =
        "Text message to send (when `expose === true` and `json === null`)";
      const json = {
        error:
          "Send `json` as application/json (when `expose === true`) instead of `message`",
      };
      throw new BindenError(status, { expose, message, json });
    }

    try {
      await validateBody();
    } catch (cause) {
      const message = "Invalid body";
      const expose = true;
      throw new BindenError(400, { expose, message, json: { message }, cause });
    }

    return context.json({ message: `Received ${length} cookies` });
  }
}
```

### BindenRequest

Simple usage with `http`

```typescript
import { createServer } from "http";
import { BindenRequest } from "binden";
const server = createServer({ IncomingMessage: BindenRequest });
```

- `.header()` - get a header by name

```typescript
const rawHeader = request.header("X-Header");
```

- `.id` - the id of the request: a new UUID, or the id that the request carries when it is trusted (see [Request ids](#request-ids))

```typescript
const { id } = request;
```

- `.ip`, `.ips` - the address of the client: the peer (without the `::ffff:` prefix of an IPv4-mapped address) or, behind [trusted proxies](#proxies), the address that they have received; and the addresses of the client and of the trusted proxies, from left to right. `.ip` is `null` when the client is unknown (e.g. `for=unknown`)

```typescript
const { ip, ips } = request;
```

- `.host` - the effective host of the request (`hostname[:port]`, in lowercase, without the default port of the protocol): the authority of a request-target in absolute-form, otherwise the host from [trusted proxies](#proxies), otherwise `Host`; `null` without any. A host that is invalid, or not one of the [allowed hosts](#allowed-hosts), throws a `BindenError` with the status 400

```typescript
const { host } = request;
```

- `.protocol` - the protocol of the connection or, behind [trusted proxies](#proxies), the one that they have received

```typescript
const { protocol } = request;
if (protocol !== "https:") {
  console.error("The connection is not secure");
}
```

- `.secure` - same as `request.protocol === "https:"`

```typescript
const { secure } = request;
if (!secure) {
  console.error("The connection is not secure");
}
```

- `.URL` - the URL of the request: the protocol (`.protocol`), the effective host (`.host`), and the path and query of the request-target, set as such (`//a/b` is a path). It throws a `BindenError` with the status 400 (which `Binden` replies) for a request-target with a fragment, a backslash, a space or a control character, an invalid percent-encoding or a dot-segment (`/a/../b`, also percent-encoded, which would route the request to another path), for a path with an encoded slash or backslash (`%2F`, `%5C`, see [Encoded slashes](#encoded-slashes)), for a host that is missing, invalid or not allowed, and for a request with several `Host` field lines

```typescript
const { pathname } = request.URL;
```

- `.query` - a copy of `URL.search` parsed by the `querystring.parse()` method, with at most `query.max_keys` keys (1000 by default, the others are ignored)

```typescript
import { parse } from "node:querystring";

const { query } = request;
// same as
const parsed = { ...parse(request.URL.search.substring(1)) };
```

- `.accepts()`, `.acceptsCharsets()`, `.acceptsEncodings()`, `.acceptsLanguages()` - the preferred one of the offered media types, charsets, content codings or language tags (as given), by the `Accept`, `Accept-Charset`, `Accept-Encoding` and `Accept-Language` headers ([RFC 9110, section 12.5](https://www.rfc-editor.org/rfc/rfc9110#section-12.5)): the first one without the header, `false` when none is acceptable. An offer takes the weight of the most specific element that matches it (`text/html;q=0` excludes HTML, even with `*/*`), and on a tie the more specific element wins, then the earlier element, then the earlier offer. The parameters of a media range must be those of the offer: their names are case-insensitive, and so is the value of `charset`, but the other values are compared as they are

```typescript
import { BindenError } from "binden";

const type = request.accepts("application/json", "text/html");
if (type === false) {
  throw new BindenError(406);
}
const language = request.acceptsLanguages("en", "fr") || "en";
```

#### Request options

The requests of a `Binden` application take these options of `new Binden()`, checked by `validateRequestOptions()` (a `TypeError` for a wrong type, a `RangeError` for a value out of its range, e.g. `trust_proxy: -1`):

- `trust_proxy` (default `false`) - the trusted proxies, see [Proxies](#proxies)
- `allowed_hosts` - the hosts that the requests may have (any by default), see [Allowed hosts](#allowed-hosts)
- `request_id` - the request ids, see [Request ids](#request-ids)
- `encoded_slashes` (default `false`) - see [Encoded slashes](#encoded-slashes)
- `query.max_keys` (default `1000`) - the greatest number of keys that `request.query` parses (`Infinity` for no limit)

With `http.createServer()`, return them from the protected `options` getter of a subclass of `BindenRequest`:

```typescript
import { createServer } from "node:http";
import {
  BindenRequest,
  type IRequestOptions,
  validateRequestOptions,
} from "binden";

const options = validateRequestOptions({
  trust_proxy: 1,
  allowed_hosts: ["example.com"],
});

class Request extends BindenRequest {
  protected override get options(): IRequestOptions {
    return options;
  }
}

const server = createServer({ IncomingMessage: Request });
```

#### Proxies

A client can send any `Forwarded` or `X-Forwarded-*` header: by default, the requests trust no proxy, `.ip` and `.protocol` are those of the connection, and `.host` is `Host`. With `trust_proxy`, they are found by walking the hops from the server: the peer (hop 0), then the addresses of the header from right to left (every proxy appends the address of its own client). The walk goes on while the hops are trusted, and the client is the first address that is not (the leftmost one when all of them are). `trust_proxy` is

- `false` (none), `true` (all of them), or the number of the nearest trusted hops: `1` for one proxy in front of the server;
- a function `(address, hop) => boolean` that tells whether the address of a hop is a trusted proxy. It is called synchronously and must return a boolean: anything else (e.g. a promise) is an error of the configuration, replied with a 500, never an implicit trust;
- `{ trust, headers }`, where `trust` is one of the above, and `headers` the headers that the proxies send: `"forwarded"` (the default, [RFC 7239](https://www.rfc-editor.org/rfc/rfc7239)) or `"x-forwarded"` (`X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host`). The families are not mixed.

The walk stops with an unknown client (`.ip` is `null`) on `unknown` or an obfuscated identifier (`_hidden`), and on an invalid element; an invalid element also makes `.protocol` that of the connection and `.host` `Host`, so that the element of a client never takes the place of the one of a proxy. Every field line of `Forwarded` is read from its end, where the proxies append their elements: a quoted string that a client leaves unterminated invalidates its own element (and those before it), never the elements appended after it. With `Forwarded`, the protocol and the host are the `proto` and `host` of the element of the farthest trusted proxy. With `X-Forwarded-*`, they are the `X-Forwarded-Proto` and `X-Forwarded-Host` that the trusted peer has set: one field line of one value each, or those of the connection and `Host` when one of them is duplicated, a list or invalid.

Behind nginx, which sets the headers like this:

```
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host $host;
```

trust the peer (one hop) and its headers. The same goes behind an AWS Application Load Balancer, which appends to `X-Forwarded-For` and sets `X-Forwarded-Proto` (not `X-Forwarded-Host`: the host is `Host`):

```typescript
import { Binden } from "binden";

const app = new Binden({ trust_proxy: { trust: 1, headers: "x-forwarded" } });
```

Behind proxies that send `Forwarded` (e.g. `Forwarded: for=192.0.2.60;proto=https;host=example.com`), count them:

```typescript
import { Binden } from "binden";

// A CDN, then a load balancer
const app = new Binden({ trust_proxy: 2 });
```

Or trust the addresses of the proxies, wherever they are in the chain:

```typescript
import { BlockList, isIPv6 } from "node:net";
import { Binden } from "binden";

const proxies = new BlockList();
proxies.addSubnet("10.0.0.0", 8);
proxies.addSubnet("fd00::", 8, "ipv6");

const app = new Binden({
  trust_proxy: {
    trust: (address) =>
      proxies.check(address, isIPv6(address) ? "ipv6" : "ipv4"),
    headers: "x-forwarded",
  },
});
```

Trust only the proxies that overwrite or append to these headers: a trusted proxy that passes on the headers of its client lets the client choose its address, protocol and host.

#### Allowed hosts

`request.URL` (and the links that an application builds with it) has the host of the request, which a client chooses. `allowed_hosts` lists the hosts that the effective host (`.host`) may be: `hostname` (on any port) or `hostname:port` (the default port of the protocol counts as given), in any case, or a function of the effective host (`hostname[:port]`) that returns a boolean (synchronously, like `trust_proxy`). Another host, or none, throws a `BindenError` with the status 400 when `.URL` or `.host` is read; the headers are left as they are. An empty list (that would refuse every request) throws a `RangeError`, and a host that is not a host name, an IPv4 address or an IPv6 address in brackets (with a port from 1 to 65535) a `TypeError`.

```typescript
import { Binden } from "binden";

const app = new Binden({
  allowed_hosts: ["example.com", "www.example.com", "localhost:3000"],
});
const api = new Binden({
  allowed_hosts: (host) => /^[\w-]+\.example\.com$/u.test(host),
});
```

#### Request ids

`request.id` is a new UUID for every request. Without the `request_id` option, the id is not sent back. With it (even `request_id: {}`, which sends it back with the defaults), a request may carry its id, so that the logs of the proxies and services in front of the server can be joined with those of the application:

- `header` (default `"x-request-id"`) - the field of the id
- `trust_incoming` (default `false`) - whether the id of the request is used: only when the proxies in front of the server set (or check) it, since a client can send any id. The id is used when it is one field line of 1 to 128 letters, digits, `.`, `_`, `:` and `-`; otherwise the request gets a new UUID
- `echo` (default `true`, once `request_id` is set) - whether every response of a `Binden` application sends the id back (in the field `header`), also the error replies of the framework (the deadline, a closing server, a failed error handler). It is set when the request arrives: a middleware may remove it.

```typescript
import { Binden } from "binden";

// nginx sets it: `proxy_set_header X-Request-Id $request_id;`
const app = new Binden({ request_id: { trust_incoming: true } });
```

#### Encoded slashes

A `%2F` (or `%5C`) in a path is a slash (or a backslash) once decoded: a router would see one segment where a proxy or a file server sees several, or the opposite. A request whose path has one (in any case) gets a 400, unless `encoded_slashes` is `true`: then a parameter of [`route()` or `mount()`](#stack-and-routing) has the decoded `/` (or `\`) in its value (e.g. `name` is `a/b` for `/files/:name` and `/files/a%2Fb`), while the segments of the path stay those that the client has sent. The query is not checked, and `%252F` is fine: once decoded, it is the text `%2F`.

```typescript
import { Binden } from "binden";

const app = new Binden({ encoded_slashes: true });
```

### BindenResponse

Simple usage with `http`

```typescript
import { createServer } from "http";
import { BindenResponse } from "binden";
const server = createServer({ ServerResponse: BindenResponse });
```

- `.started` - whether the response has been started: by `.send()` or `.sendFile()`, by a stream piped into it, or by its headers being sent

- `.cookies` - the cookies to send. They are added to the `Set-Cookie` header once, when the headers are sent by any path (`.send()`, `writeHead()` with any of its arguments, `write()`, `end()`, `flushHeaders()` or a piped stream), after the `Set-Cookie` values set on the response or given to `writeHead()`

```typescript
import { randomUUID } from "crypto";
import { Cookie } from "binden";

const key = "__Secure-Random-UUID";
const value = randomUUID();
const cookie = new Cookie({ key, value });
response.cookies.add(cookie);
await response.send("Check the `Set-Cookie` header for a random UUID");
```

- `.clearCookie()` - remove a cookie from the client: an empty value that expires at once, with the `domain`, `path`, `secure`, `same_site` and `partitioned` of the cookie to remove (it replaces a cookie of the same name, domain and path in `.cookies`)

```typescript
response.clearCookie("session");
response.clearCookie("__Host-chips", { same_site: "None", partitioned: true });
await response.send();
```

- `.status()` - Set the status code of the response: an integer from 100 to 599

```typescript
await response.status(400).send();
```

- `.set()` - Set the headers (the own properties of the object)

```typescript
const headers = {
  "X-AMOUNT": "100.02 USD",
  "X-MONTHS": ["jan", "feb"],
};
await response.status(402).set(headers).send("Payment is required");
```

- `.type()` - set the `Content-Type`: a media type with its parameters (a `TypeError` otherwise)

- `.attachment()` - ask the client to save the response (`Content-Disposition: attachment`), with the name to save it as: `filename` in ASCII (other characters are replaced with `_`) and `filename*` in UTF-8 ([RFC 6266](https://www.rfc-editor.org/rfc/rfc6266.html), [RFC 8187](https://www.rfc-editor.org/rfc/rfc8187.html))

- `.vary()` - add the names of the request headers that select the response to `Vary` (once each, after the values it has; `*` replaces them all)

```typescript
await response
  .type("text/csv; charset=utf-8")
  .attachment("отчёт.csv")
  .vary("Accept-Language")
  .send("a,b\n1,2\n");
```

- `.send()` - send data, framed by the final status: a body gets its exact `Content-Length` (also a stale one is replaced), 1xx, 204 and 304 responses have none (but the `304` of the dynamic `ETag` and of `.sendFile()`, which has the length of the `200` that it stands for), and 205 has `Content-Length: 0`. A response without a body (to `HEAD`, or with a 1xx, 204, 205 or 304 status) sends none: a `Readable` is destroyed without being read, and a response to `HEAD` gets the `Content-Length` of the body it would send to `GET`. It resolves once the response is flushed to the connection, and rejects when it cannot be sent (e.g. the client went away), or when a `Readable` fails, closes before its end, or does not have its `Content-Length`. A `Readable` is no longer read (and is destroyed) once another writer has ended the response, e.g. a compression that has replaced it with `406 Not Acceptable` when its first chunk committed the headers. Nothing sent yet, such an error can still be replied; otherwise the response is cut, so that the client knows that it is truncated. An unknown `encoding` of a string rejects with a `TypeError` before anything is sent.

```typescript
await response.send(
  "Could be `number` | `string` | `Buffer` | `Readable` | `bigint` | `undefined`",
);
```

- `.json()` - send a JSON value (`null`, a number, a string, a boolean, an array or an object) as `application/json` using `JSON.stringify()`. A value without a JSON text (`undefined`, a function or a symbol), a `bigint` or a cyclic value rejects with a `TypeError` before the response is started, so that the error can still be replied

```typescript
const json = { k: "v", k1: 1, m: "message", f: false };
await response.json(json);
```

or using a custom `stringify` function, which must return a string

```typescript
const json = { currency: "💶", value: 120 };
const { default: fastJSON } = await import("fast-json-stringify");
const stringify = fastJSON({
  title: "Example Schema",
  type: "object",
  properties: {
    currency: {
      type: "string",
    },
    value: {
      type: "integer",
    },
  },
  required: ["currency", "value"],
  additionalProperties: false,
});
await response.json(json, stringify);
```

- `.text()` - send text as `text/plain; charset=utf-8`

```typescript
const text = "Hello World!";
await response.text(text);
```

- `.html()` - send text as `text/html; charset=utf-8`

```typescript
const html = "<html></html>";
await response.html(html);
```

- `.form()` - send `URLSearchParams`;

```typescript
const form = new URLSearchParams([
  ["a", "1"],
  ["b", "a"],
  ["b", "c"],
]);
await response.form(form);
```

- `.redirect()` - redirect (`302 Found` by default, or `301`, `303`, `307` and `308`) with an empty body. `Location` is the [WHATWG URL](https://url.spec.whatwg.org/) serialization of the location, resolved against the URL of the request (a relative reference stays relative). Without `allow_external`, only a relative reference or an absolute URL of the origin of the request (`BindenRequest.URL`; none is known for other requests) is allowed, so that a location taken from the request cannot send the client to another site; a network-path reference (`//host/path`) needs `allow_external` too. A location with userinfo, a control character, whitespace, a backslash or a scheme other than `http` and `https` is never allowed. A refused location rejects with a `TypeError` before the response is started.

```typescript
await response.redirect("/login?next=%2Faccount", 303);
// To another site
await response.redirect("https://example.com/", 302, { allow_external: true });
```

- `.flush()` - send the headers, then resolve once what has been written so far is flushed to the connection (e.g. an event of a `text/event-stream`); it rejects when the response is closed before. [@binden/compression](https://github.com/binden-js/binden/tree/main/packages/compression) flushes its compressor as well.

```typescript
response.setHeader("Content-Type", "text/event-stream");
response.write("data: 1\n\n");
await response.flush();
```

- Dynamic `ETag` - with the `etag` option of the response (`new Binden({ etag: true })`, `false` by default), a `200` response to `GET` or `HEAD` whose body is a `Buffer` or a string (`.send()`, `.json()`, `.text()`, `.html()`, `.form()`) gets a strong `ETag` (the SHA-256 of the bytes that are sent, in base64url), unless it has an `ETag` already, and becomes `304 Not Modified` (without a body, with the same `ETag`, `Vary`, `Cache-Control` and `Content-Type`, and the `Content-Length` of the `200`, as RFC 9110 allows) when `If-None-Match` matches it by the weak comparison. With `http.createServer()`, set the option in a subclass

```typescript
import { createServer } from "http";
import {
  BindenResponse,
  type IResponseOptions,
  validateResponseOptions,
} from "binden";

class ETagResponse extends BindenResponse {
  protected override get options(): Readonly<IResponseOptions> {
    return validateResponseOptions({ etag: true });
  }
}
const server = createServer({ ServerResponse: ETagResponse });
```

- `.sendFile()` - Send a file with its `Last-Modified` (never in the future), a weak `ETag` from its size and modification time (`W/"<size>-<mtime>"`, unless the response has an `ETag`), its `Content-Type` (by the extension of its name, from a table of common web types, otherwise `application/octet-stream`, unless the response has one), `Accept-Ranges: bytes` and `X-Content-Type-Options: nosniff`. Its metadata and its content are read from the one file it opens (a FIFO is not waited for), and no more than its size is sent. Follows [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html) for the following headers, with the `ETag` of the response, in this order
  - [If-Match](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-Match) (or else [If-Unmodified-Since](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-Unmodified-Since)) - `412 Precondition Failed` when it does not match (by the strong comparison; `*` matches the file, and a weak `ETag` never matches). It is evaluated against the file as it is: [`@binden/compression`](https://github.com/binden-js/binden/tree/main/packages/compression) sends the file uncompressed when `If-Match` lists its strong `ETag`, as a compressed one would have a weak tag

  - [If-None-Match](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-None-Match) (or else [If-Modified-Since](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-Modified-Since), for `GET` and `HEAD`) - when it matches (by the weak comparison), `304 Not Modified` for `GET` and `HEAD` (with the headers of the file and its `Content-Length`), `412 Precondition Failed` for other methods

  - [Range](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Range) - for `GET` only: `206 Partial Content` for one range (overlapping or adjacent ranges are merged; several distinct ranges get the whole file, as `multipart/byteranges` is not supported), `416 Range Not Satisfiable` when no range can be satisfied

  - [If-Range](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-Range) - the ranges apply when it is a strong `ETag` of the response (a weak one gets the whole file), or exactly the `Last-Modified` when that is at least a second old (a strong validator)

  A response to `HEAD` gets the headers of the whole file, without reading it.

  The path is a filesystem path (not URL-decoded) or a `file:` URL. Without `root`, it is trusted as it is: a missing file rejects with the error of the filesystem.

```typescript
const path = "<path to file>";
await response.sendFile(path);
```

With the `root` option, the path must be a relative string (a `URL` throws a `TypeError`) that is served from inside the root directory (e.g. a parameter of the request): a path that is absolute or has an empty, `.` or `..` segment (or a NUL character, and on Windows a drive letter, a stream or a UNC path; the segments are split on `/`, and on Windows also on `\`), or a file that does not exist, is not a regular file, or whose real path (with every symbolic link or junction resolved) is not inside the real path of the root rejects with a `404` `BindenError`. A segment that starts with a dot, in the path or in its real path, follows `dotfiles`: `"ignore"` (`404`, the default), `"deny"` (`403`) or `"allow"`. The file is opened without following a symbolic link that replaced it since its real path was resolved.

The guarantee has limits: the root directory (and the directories above it) must be trusted, and a race in which an attacker who can write inside the root replaces a directory of the path by a symbolic link between the check and the open is not prevented.

```typescript
await response.sendFile("css/site.css", {
  root: new URL("./public/", import.meta.url),
  dotfiles: "deny",
  max_age: 31536000,
  immutable: true,
});
```

The other options (an invalid one rejects with a `TypeError` or a `RangeError` before the file is opened):

- `etag` - the weak `ETag` from the size and the modification time (`true` by default)
- `validator` - a strong `ETag` (`"…"`) that the application guarantees for the file (e.g. a hash of its content), sent instead
- `last_modified` - the `Last-Modified` header (`true` by default); without it, `If-Modified-Since`, `If-Unmodified-Since` and a date in `If-Range` do not apply
- `cache_control` - the `Cache-Control` header, or else `max_age` (in seconds: `public, max-age=<max_age>`) with `immutable` (which needs `max_age`)
- `content_type` - the `Content-Type` (a media type), or `false` to leave it unset

### Headers

- [Accept](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Accept) - `Accept.fromString()` returns the valid elements (media ranges in lowercase, with their parameters and weight) from the greatest weight, and `Accept.negotiate()` selects one of the offered media types like `request.accepts()`

```typescript
import { Accept } from "binden";

const ranges = Accept.fromString(request.headers.accept);
const type = Accept.negotiate(
  ["application/json", "text/html"],
  request.headers.accept,
);
// or using BindenRequest
const preferred = request.accepts("application/json", "text/html");
```

- [Accept-Charset](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Accept-Charset)

```typescript
import { AcceptCharset } from "binden";

const charsets = AcceptCharset.fromString(request.headers["accept-charset"]);
const charset = AcceptCharset.negotiate(
  ["utf-8", "iso-8859-1"],
  request.headers["accept-charset"],
);
// or using BindenRequest
const preferred = request.acceptsCharsets("utf-8", "iso-8859-1");
```

- [Accept-Encoding](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Accept-Encoding) - the known codings (`gzip`, `x-gzip`, `compress`, `deflate`, `br`, `zstd`, `identity` and `*`). In `AcceptEncoding.negotiate()` (and `request.acceptsEncodings()`), `x-gzip` is `gzip`, unknown codings of the header count too, and `identity` is acceptable unless excluded (`identity;q=0`, or `*;q=0` without `identity`)

```typescript
import { AcceptEncoding } from "binden";

const encodings = AcceptEncoding.fromString(request.headers["accept-encoding"]);
const encoding = AcceptEncoding.negotiate(
  ["br", "gzip", "identity"],
  request.headers["accept-encoding"],
);
// or using BindenRequest
const { accept_encoding } = request;
const preferred = request.acceptsEncodings("br", "gzip", "identity");
```

- [Accept-Language](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Accept-Language) - in `AcceptLanguage.negotiate()` (and `request.acceptsLanguages()`), a language range matches the tags that it is, or is a prefix of (`en` matches `en-US`, not the opposite)

```typescript
import { AcceptLanguage } from "binden";

const languages = AcceptLanguage.fromString(request.headers["accept-language"]);
const language = AcceptLanguage.negotiate(
  ["en-US", "fr"],
  request.headers["accept-language"],
);
// or using BindenRequest
const preferred = request.acceptsLanguages("en-US", "fr");
```

- [Authorization](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Authorization)

```typescript
import { Authorization } from "binden";

const credentials = Authorization.fromString(request.headers.authorization);
// or using BindenRequest
const { authorization } = request;
```

- [Content-Encoding](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Encoding) - the codings (`gzip`, `x-gzip`, `compress`, `deflate`, `br` and `zstd`) in the order to remove them, or `null` when one of them is unknown or malformed (the content cannot be decoded then)

```typescript
import { ContentEncoding } from "binden";

const encodings = ContentEncoding.fromString(
  request.headers["content-encoding"],
);
// or using BindenRequest
const { content_encoding } = request;
```

The constructors of the headers throw a `TypeError` for what their parsers reject (e.g. a reversed `Range`, a weight that is not a qvalue, a `Content-Type` parameter with control characters, an unsupported `Authorization` scheme, an unknown content coding, or an Invalid Date).

- [Content-Range](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Range) - `bytes <first>-<last>/<size>` (the size may be `*`) or an unsatisfied range, with decimal positions only

```typescript
import { ContentRange } from "binden";

const cr = new ContentRange({ start: 0, end: 499, size: 1000 });
response.setHeader("Content-Range", cr.toString());
```

- [Content-Type](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Type) - a media type and all of its parameters (`.parameters`, by lowercase name), serialized as quoted strings when they are not tokens

```typescript
import { ContentType } from "binden";

const type = ContentType.fromString(request.headers["content-type"]);
// or using BindenRequest
const { content_type } = request;
```

- [Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cookie) - `new Cookie()` throws a `TypeError` for a name, value or attribute that would change the `Set-Cookie` header (e.g. a value with `;`); `Cookie.fromString()` skips such cookies. A cookie is `Secure` with the `__Secure-` or `__Host-` prefix, `SameSite=None`, or `partitioned` ([CHIPS](https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Privacy_sandbox/Partitioned_cookies), the `Partitioned` attribute)

```typescript
import { Cookie } from "binden";

const parsed = Cookie.fromString(request.headers.cookie);
// or using BindenRequest
const { cookies } = request;
// or using BindenResponse
const cookie1 = new Cookie({
  key: "__Secure-K1",
  value: "v1",
  http_only: false,
});
const cookie2 = new Cookie({
  key: "K2",
  value: "v2",
  same_site: "None",
  max_age: 1000,
});
response.cookies.add(cookie1).add(cookie2);
```

- [Forwarded](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Forwarded) - `Forwarded.parse()` returns the elements of a field value (or of its field lines, e.g. `request.headersDistinct.forwarded`) in their positions (`null` for an invalid one: a parameter that is not `name=value`, that is given twice, or with control characters; a field line is read from its end, so that an unterminated quoted string invalidates what is before it only), and `Forwarded.fromString()` the valid ones. `.toString()` sends the values that are not tokens as quoted strings (`for="[2001:db8::1]:4711"`). These are the elements that a client sends too: `request.ip`, `.protocol` and `.host` read those of the [trusted proxies](#proxies)

```typescript
import { Forwarded } from "binden";

const elements = Forwarded.parse(request.headers.forwarded);
const proxies = Forwarded.fromString(request.headers.forwarded);
// or using BindenRequest
const { forwarded } = request;
```

- [If-Modified-Since](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-Modified-Since)

```typescript
import { IfModifiedSince } from "binden";

const ims = IfModifiedSince.fromString(request.headers["if-modified-since"]);
// or using BindenRequest
const { if_modified_since } = request;
```

- [Range](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Range)

```typescript
import { Range } from "binden";

const ranges = Range.fromString(request.headers.range);
// or using BindenRequest
const { range } = request;
```
