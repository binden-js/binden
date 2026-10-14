# Binden [![CI Status](https://github.com/binden-js/binden/actions/workflows/ci.yml/badge.svg)](https://github.com/binden-js/binden/actions/workflows/ci.yml) [![version](https://img.shields.io/npm/v/binden?style=plastic)](https://www.npmjs.com/package/binden) [![Coverage Status](https://coveralls.io/repos/github/binden-js/binden/badge.svg?branch=main)](https://coveralls.io/github/binden-js/binden?branch=main) [![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://github.com/prettier/prettier) [![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](https://github.com/binden-js/binden/blob/main/CODE_OF_CONDUCT.md) [![semantic-release](https://img.shields.io/badge/semantic--release-conventional--commits-e10079.svg?logo=semantic-release)](https://github.com/semantic-release/semantic-release) [![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg)](https://conventionalcommits.org) ![node version](https://img.shields.io/node/v/binden) ![npm downloads](https://img.shields.io/npm/dt/binden) [![License](https://img.shields.io/npm/l/binden)](https://github.com/binden-js/binden/blob/main/packages/binden/LICENSE)

A simple server framework (written in [TypeScript](https://www.typescriptlang.org/)).

## Installation

```bash
npm install binden
```

## Usage

### Binden

`new Binden(options)` takes the following options:

- `auto_head` (default `true`) - a router without `HEAD` middlewares handles `HEAD` with its `GET` middlewares (see [Router](#router))
- `error_handler` - replaces the default reply to an error thrown by a middleware (the thrown value may be anything, also `null`). It may be `async`: it is awaited, and it must have ended its reply when it settles. Nothing started then gets the default reply, while a reply that is not ended (e.g. a `write()` without `end()`) is cut by closing the connection. When it fails, the connection is closed. There is no deadline: a handler that never settles keeps its request.
- `logger` - see [Logging](#logging)
- `trust_proxy`, `allowed_hosts`, `request_id`, `encoded_slashes`, `query` - the options of the requests, see [Request options](#request-options)

- `.use()` - Add a `Middleware/Router` to the stack

```typescript
import { Binden, type Context } from "binden";

const app = new Binden().use(middleware1).use(router2);
app.use("/path", middleware2, router2);
app.use(new RegExp("path"), router3, middleware1);
const middleware3 = (context: Context): Promise<void> =>
  context.json({ message: "Hello World!" });
app.use("/path2", middleware3);
```

A RegExp path keeps its flags, except `g` and `y` (they would make `test()` stateful).

- `.off()` - remove a `Middleware/Router` from the stack (returns the removed items)

```typescript
import { Binden } from "binden";

const app = new Binden().use("/path", middleware1).use(middleware2);
// `.off()` returns the removed items
const removed = app.off("/path", middleware1);
```

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

### Logging

Every context logs through `context.log`: a child (with the `trace_id` of the context) of the logger of the application. The default logger (see [`@binden/logger`](https://github.com/binden-js/binden/tree/main/packages/logger)) is silent unless the `BINDEN_LOG_LEVEL` environment variable sets a level, and its `serializers` log an allowlist of details only, which keeps credentials and the input of the requests out of the logs:

- a request is its method, its path and its `Host`, `User-Agent`, `Content-Type` and `Content-Length` headers. The path is logged without the query string and the fragment, nor the scheme, authority and userinfo of an absolute-form request-target; anything secret in the path itself (e.g. a token) is logged;
- a response is its status code and its `Content-Type` and `Content-Length` headers;
- a context is its `id`, request and response (not the fields the application sets on it);
- a logged `body` (e.g. the one that [`@binden/body`](https://github.com/binden-js/binden/tree/main/packages/body) failed to parse) is redacted;
- an `error` is reduced to its type (the nearest of `BindenError` and the built-in error classes, never a name the error defines), its `status` and `expose`, and its `code` when it is a system error code (such as `ECONNRESET`) or one of a few stream and HTTP codes (such as `ERR_STREAM_PREMATURE_CLOSE`). Its message, stack, cause and `json` may quote the input (e.g. an error of `JSON.parse()`). The serializer never throws, whatever is thrown.

A custom logger (for example with another level or destination, or to log more details) is passed with the `logger` option. The default `serializers` are exported to build on:

```typescript
import { Binden, serializers } from "binden";
import { Logger } from "@binden/logger";

const logger = new Logger({ level: "debug", serializers });
const app = new Binden({ logger });

// Log the request bodies as well
const verbose = new Logger({
  level: "debug",
  serializers: { ...serializers, body: (body: unknown): unknown => body },
});
const debugApp = new Binden({ logger: verbose });
```

Likewise, `error` can be replaced with a serializer that keeps the details of the errors (e.g. `stdSerializers.err` of [pino](https://getpino.io/#/docs/api?id=pino-stdserializers)).

### Context

- `.log` - get the logger (see [`@binden/logger`](https://github.com/binden-js/binden/tree/main/packages/logger))

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

- `.send()` - execute `context.response.send()` and set `context.done` to `true`

```typescript
const data = "Hello World!";
await context.send(data);
// or
await context.response.send(data);
context.done = true;
```

- `.json()` - execute `context.response.json()` and set `context.done` to `true`

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

- `.sendFile()` - execute `context.response.sendFile()` and set `context.done` to `true`

```typescript
const path = "<path to file>";
await context.sendFile(path);
// or
await context.response.sendFile(path);
context.done = true;
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

- `.get()`, `.head()`, `.post()`, `.put()`, `.patch()`, `.delete()`, `.options()`, `.trace()`, and `.on()` for any other method of Node.js but `CONNECT`, which Node.js emits as a `connect` event of the server: its requests never reach the middlewares. `.off()` removes middlewares, and `.methods` lists the methods that have some.
- `HEAD` is handled by the `HEAD` middlewares of a router, or else by its `GET` middlewares (unless the `auto_head` option of `Binden` is `false`). A response to `HEAD` sends no body.
- A `guarded` router (`new Router({ guarded: true })`) that does not allow the method of a request passes it on. When nothing else handles the request, it gets `405 Method Not Allowed`, with the methods of every guarded router that has refused it in `Allow`.

```typescript
import { Binden, type Context, Router } from "binden";

const list = new Router({ guarded: true }).get((context: Context) =>
  context.send("list"),
);
const create = new Router({ guarded: true }).post((context: Context) =>
  context.status(201).send(),
);
// `DELETE /items` gets 405, with `Allow: GET, HEAD, POST`
const app = new Binden().use("/items", list, create);
```

### BindenError

`BindenError` represents an HTTP error, with a status code from 400 to 599 (an integer: anything else throws a `TypeError`)

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

- `.URL` - the URL of the request: the protocol (`.protocol`), the effective host (`.host`), and the path and query of the request-target, set as such (`//a/b` is a path). It throws a `BindenError` with the status 400 (which `Binden` replies) for a request-target with a fragment, a backslash, an invalid percent-encoding or a dot-segment (`/a/../b`, also percent-encoded, which would route the request to another path), for a path with an encoded slash or backslash (`%2F`, `%5C`, see [Encoded slashes](#encoded-slashes)), for a host that is missing, invalid or not allowed, and for a request with several `Host` field lines

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

- `.accepts()`, `.acceptsCharsets()`, `.acceptsEncodings()`, `.acceptsLanguages()` - the preferred one of the offered media types, charsets, content codings or language tags (as given), by the `Accept`, `Accept-Charset`, `Accept-Encoding` and `Accept-Language` headers ([RFC 9110, section 12.5](https://www.rfc-editor.org/rfc/rfc9110#section-12.5)): the first one without the header, `false` when none is acceptable. An offer takes the weight of the most specific element that matches it (`text/html;q=0` excludes HTML, even with `*/*`), and on a tie the more specific element wins, then the earlier element, then the earlier offer

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

The walk stops with an unknown client (`.ip` is `null`) on `unknown` or an obfuscated identifier (`_hidden`), and on an invalid element; an invalid element also makes `.protocol` that of the connection and `.host` `Host`, so that the element of a client never takes the place of the one of a proxy. With `Forwarded`, the protocol and the host are the `proto` and `host` of the element of the farthest trusted proxy. With `X-Forwarded-*`, they are the `X-Forwarded-Proto` and `X-Forwarded-Host` that the trusted peer has set: one field line of one value each, or those of the connection and `Host` when one of them is duplicated, a list or invalid.

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

`request.id` is a new UUID for every request. With `request_id`, a request may carry its id, so that the logs of the proxies and services in front of the server can be joined with those of the application:

- `header` (default `"x-request-id"`) - the field of the id
- `trust_incoming` (default `false`) - whether the id of the request is used: only when the proxies in front of the server set (or check) it, since a client can send any id. The id is used when it is one field line of 1 to 128 letters, digits, `.`, `_`, `:` and `-`; otherwise the request gets a new UUID
- `echo` (default `true`) - whether the response sends the id back (in the field `header`)

```typescript
import { Binden } from "binden";

// nginx sets it: `proxy_set_header X-Request-Id $request_id;`
const app = new Binden({ request_id: { trust_incoming: true } });
```

#### Encoded slashes

A `%2F` (or `%5C`) in a path is a slash (or a backslash) once decoded: a router would see one segment where a proxy or a file server sees several, or the opposite. A request whose path has one (in any case) gets a 400, unless `encoded_slashes` is `true`. The query is not checked, and `%252F` is fine: once decoded, it is the text `%2F`.

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

- `.cookies` - The `.send()` method will add cookies to the response

```typescript
import { randomUUID } from "crypto";
import { Cookie } from "binden";

const key = "__Secure-Random-UUID";
const value = randomUUID();
const cookie = new Cookie({ key, value });
response.cookies.add(cookie);
await response.send("Check the `Set-Cookie` header for a random UUID");
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

- `.send()` - send data, framed by the final status: a body gets its exact `Content-Length` (also a stale one is replaced), 1xx, 204 and 304 responses have none, and 205 has `Content-Length: 0`. A response without a body (to `HEAD`, or with a 1xx, 204, 205 or 304 status) sends none: a `Readable` is destroyed without being read, and a response to `HEAD` gets the `Content-Length` of the body it would send to `GET`. It resolves once the response is flushed to the connection, and rejects when it cannot be sent (e.g. the client went away), or when a `Readable` fails, closes before its end, or does not have its `Content-Length`. Nothing sent yet, such an error can still be replied; otherwise the response is cut, so that the client knows that it is truncated.

```typescript
await response.send(
  "Could be `number` | `string` | `Buffer` | `Readable` | `bigint` | `undefined`",
);
```

- `.json()` - send an object as `application/json` using `JSON.stringify()`

```typescript
const json = { k: "v", k1: 1, m: "message", f: false };
await response.json(json);
```

or using a custom `stringify` function

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

- `.text()` - send text as `text/plain`

```typescript
const text = "Hello World!";
await response.text(text);
```

- `.html()` - send text as `text/html`

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

- `.sendFile()` - Send a file with its `Last-Modified` (never in the future). Its metadata and its content are read from the one file it opens (a FIFO is not waited for), and no more than its size is sent. Follows [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html) for the following headers, with the `ETag` set on the response (if any), in this order
  - [If-Match](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-Match) (or else [If-Unmodified-Since](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-Unmodified-Since)) - `412 Precondition Failed` when it does not match (by the strong comparison; `*` matches the file)

  - [If-None-Match](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-None-Match) (or else [If-Modified-Since](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-Modified-Since), for `GET` and `HEAD`) - when it matches (by the weak comparison), `304 Not Modified` for `GET` and `HEAD`, `412 Precondition Failed` for other methods

  - [Range](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Range) - for `GET` only: `206 Partial Content` for one range (overlapping or adjacent ranges are merged; several distinct ranges get the whole file), `416 Range Not Satisfiable` when no range can be satisfied

  - [If-Range](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-Range) - the ranges apply when it is the strong `ETag` set on the response, or exactly the `Last-Modified` when that is at least a second old (a strong validator)

  A response to `HEAD` gets the headers of the whole file, without reading it.

```typescript
const path = "<path to file>";
await response.sendFile(path);
```

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

- [Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cookie) - `new Cookie()` throws a `TypeError` for a name, value or attribute that would change the `Set-Cookie` header (e.g. a value with `;`); `Cookie.fromString()` skips such cookies

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

- [Forwarded](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Forwarded) - `Forwarded.parse()` returns the elements in their positions (`null` for an invalid one: a parameter that is not `name=value`, that is given twice, or with control characters), and `Forwarded.fromString()` the valid ones. `.toString()` sends the values that are not tokens as quoted strings (`for="[2001:db8::1]:4711"`). These are the elements that a client sends too: `request.ip`, `.protocol` and `.host` read those of the [trusted proxies](#proxies)

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
