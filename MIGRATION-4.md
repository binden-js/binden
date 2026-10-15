# Migrating to binden 4

binden 4.0.0 is the first release of the packages of this repository together: `binden`,
`@binden/logger`, `@binden/body`, `@binden/compression` and `@binden/multipart` are now released
at the same time, always with the same version. This guide lists what changes since their last
separate releases, and how to update an application:

| Package               | Last release before 4.0.0 | Its Node.js | Its license   |
| --------------------- | ------------------------- | ----------- | ------------- |
| `binden`              | 2.0.4                     | `>=20.11.0` | AGPL-3.0-only |
| `@binden/logger`      | 2.0.3                     | `>=20.11.0` | AGPL-3.0-only |
| `@binden/body`        | 2.0.1                     | `>=20.11.0` | AGPL-3.0-only |
| `@binden/compression` | 3.0.0                     | `>=24.14.1` | AGPL-3.0-only |
| `@binden/multipart`   | 2.0.3                     | `>=22.17.0` | AGPL-3.0-only |

Most changes make a request that used to be accepted, or answered with a misleading status, fail
safely. Each section starts with what fails at once (a type error, or a `TypeError` when the
application starts), then what changes silently (statuses, headers, logs). The
[production guide](PRODUCTION.md) shows how to configure the new options (deadlines, shutdown,
proxies, limits).

- [Upgrading](#upgrading)
- [All packages](#all-packages)
- [binden](#binden)
- [@binden/logger](#bindenlogger)
- [@binden/body](#bindenbody)
- [@binden/multipart](#bindenmultipart)
- [@binden/compression](#bindencompression)
- [New features](#new-features)

## Upgrading

1. Run Node.js 24.14.1 or later.
2. Install version 4 of every package that the application uses, together:

   ```bash
   npm install binden@^4.0.0 @binden/logger@^4.0.0 @binden/body@^4.0.0 @binden/compression@^4.0.0 @binden/multipart@^4.0.0
   ```

   `@binden/body`, `@binden/compression` and `@binden/multipart` have a peer dependency on
   `binden` of their own version (`^4.0.0`): npm refuses to install them next to `binden` 2.

3. Replace the deep imports (see [Entry points](#entry-points)), then compile: most of the
   changes of the API are type errors.
4. Read the sections of the packages that the application uses, and check its tests against the
   new statuses.

## All packages

### Versions

Every release has one version for all the packages: a fix of one package is released as a new
version of all of them, and the middlewares depend on the `binden` of the same version. The notes
of every release are the [GitHub Releases](https://github.com/binden-js/binden/releases); the
`CHANGELOG.md` of each package keeps the history before 4.0.0.

### Node.js 24.14.1

Every package requires Node.js `>=24.14.1` (see the table above for the earlier requirements).
The packages no longer declare an `npm` version in their `engines`: any npm that supports Node.js
24 installs them.

### Entry points

The packages are ES modules (as before) with an `exports` map: only the entry point of a package
(`binden`, `@binden/logger`, …) can be imported. A deep import of one of their files fails with
`ERR_PACKAGE_PATH_NOT_EXPORTED` (and does not compile): import everything from the entry point,
which exports all of the public API.

```diff
-import Cookie from "binden/dist/src/headers/cookie.js";
+import { Cookie } from "binden";
```

With TypeScript, use the `"nodenext"` (or `"bundler"`) module resolution, which reads the
`exports` maps.

The packages declare `"sideEffects": false` (a bundler may drop what an application does not
use), and they publish their TypeScript sources with source maps and declaration maps: stack
traces and "go to definition" lead to the sources rather than to `dist`. The types of `pino` (used by `@binden/logger`) need `skipLibCheck` with
`@types/node` 26 (see the [known issues](https://github.com/binden-js/binden#known-issues)).

### MIT license

All the packages are published under the [MIT license](LICENSE) (they were under the
AGPL-3.0-only).

## binden

### Options are checked

`new Binden()`, `new Router()` and the constructor of every `Middleware` validate their options:
a value of the wrong type throws a `TypeError` (e.g. `new Router({ guarded: 1 })`, or a `logger`
without the methods of `ILogger`), and a value out of its range a `RangeError`. They used to be
coerced or ignored.

`IBindenOptions` is a type (with a `State` parameter), no longer an interface: an interface cannot
extend it. Extend `IBindenBaseOptions` (every option but `state`) instead, or intersect the type
(`IBindenOptions & { port: number }`):

```typescript
import { Binden, type IBindenBaseOptions } from "binden";

// `interface IServerOptions extends IBindenOptions` no longer compiles
interface IServerOptions extends IBindenBaseOptions {
  port: number;
}

function start({ port, ...options }: IServerOptions): void {
  new Binden(options).createServer().listen(port);
}

start({ port: 8080, timeout: 30_000 });
```

### Status codes

- `response.status()` takes an integer from 100 to 599 (a `TypeError` otherwise), and
  `new BindenError()` an integer from 400 to 599 (a `TypeError` for a string such as `"400"`, a
  `RangeError` out of the range). Any integer in the range is accepted, such as `499`: only the
  codes known to Node.js were, also as strings.
- The default error reply uses the `status` of a thrown value only when it is an integer from 400
  to 599: any other value (a string such as `"404"`, or `302`) gets `500 Internal Server Error`.
  It used to accept any status known to Node.js, also as a string.

```diff
-throw Object.assign(new Error("Not found"), { status: "404" });
+throw new BindenError(404);
```

### The error handler

The `error_handler` option was called without being awaited: a handler that rejected crashed the
process with an unhandled rejection, and one that did not reply left the request pending. Now:

- its result is awaited, for at most `error_handler_timeout` milliseconds (`5000` by default);
- a handler that has not started a reply once it settles gets the default reply instead. A reply
  that it sends later (e.g. without awaiting it) is too late: make the handler `async` and await
  its reply;
- a handler that throws, rejects or takes longer gets an empty `500 Internal Server Error`
  (without the headers of the body it may have set), or its connection is closed when its reply
  has started.

```typescript
import { Binden, BindenError, type Context } from "binden";

const app = new Binden({
  error_handler_timeout: 2000,
  error_handler: async (context: Context, error: unknown): Promise<void> => {
    const status = error instanceof BindenError ? error.status : 500;
    // Awaited: the reply must be complete once the handler settles
    await context.status(status).json({ error: status });
  },
});
```

The default error reply is sent with the cookies of the response and the `headers` of a
`BindenError`, without the headers of the body that it replaces (`Content-Length`,
`Content-Encoding`, `ETag`, …). When a reply has started, the error cuts it by closing the
connection, so that the client knows that it is incomplete (it was ended as if it were complete),
and a reply that has ended is left as it is (its request was destroyed).

### Routing

- `Router.on()` and `Router.off()` take any method token in any case (`router.on("propfind")` is
  `PROPFIND`), instead of the methods of Node.js in uppercase only. `CONNECT` throws a `TypeError`:
  Node.js never passes its requests to the request listener.
- A guarded router that does not allow the method of a request passes it on: the next routers of
  the path are tried, and `405 Method Not Allowed` is replied only when none handles it. Its
  `Allow` lists the methods of every guarded router that has refused the request, with `HEAD`
  (for `GET`, with `auto_head`) and `OPTIONS`.
- `OPTIONS` to guarded routers without `OPTIONS` middlewares gets `204 No Content` with the same
  `Allow` (it was a `405`).
- With `auto_head`, the `HEAD` middlewares of a router run when it has some; its `GET` middlewares
  handle `HEAD` only otherwise (they used to handle it in any case).
- `Binden` is a `Stack`: `app.stack` lists the layers of `use()`, `route()` and `mount()`, whose
  path is a string, a RegExp, `null`, `{ route }` or `{ mount }`. A string path of `use()` still
  matches exactly; the new `route()` and `mount()` take [patterns with parameters](https://github.com/binden-js/binden/tree/main/packages/binden#stack-and-routing).

### Replies

`json()` sends any JSON value (not only an object or an array). A value without a JSON text
(`undefined`, a function, a symbol), a `bigint` or a cyclic value rejects with a `TypeError`
before anything is sent: `undefined` used to send an empty body.

```diff
-await context.json(undefined);
+await context.json(null);
+// or
+await context.status(204).send();
```

`sendFile(path, stats)` takes options instead of the `Stats` (it reads the file and its metadata
from one file handle). It sends a weak `ETag` (`W/"<size>-<mtime>"`), a `Content-Type` from the
extension of the file and `X-Content-Type-Options: nosniff` by default. Never pass a path from the
request without the `root` option (see [Static files](PRODUCTION.md#static-files)).

```typescript
// The headers of binden 2 (without an ETag and a Content-Type)
await context.sendFile("<path to file>", { etag: false, content_type: false });
```

- `text()` sends `text/plain; charset=utf-8` (it was `plain/text`, and `ct_text` is
  `"text/plain"`), and `html()` sends `text/html; charset=utf-8`.
- A response is framed by its final status: a body gets its exact `Content-Length` (a stale one is
  replaced), `1xx` and `204` responses have none, and a response to `HEAD` (or with a `1xx`, `204`,
  `205` or `304` status) sends no body. The `304` of `send()` (with the `etag` option) and of
  `sendFile()` keeps the `Content-Length` and the `Content-Type` of the `200` it stands for; a
  `304` that the application sends itself has no `Content-Length`. A response without a body no
  longer gets a default `Content-Type`.
- The cookies of `response.cookies` are added when the headers are sent by any path (`writeHead()`,
  `write()`, `end()`, a piped stream), not only by `send()`.
- A middleware that sets `context.done` without starting a reply gets an empty response with the
  status and the headers set so far (the request used to stay pending). A stack that runs out once
  a response has started lets it finish, instead of replying `404`.

### Requests

#### Proxies

`request.protocol` and `request.secure` followed the `Forwarded` header of any client: a client
could make a plain HTTP request look secure. They now ignore `Forwarded` unless the `trust_proxy`
option trusts the proxies that send it, and behind trusted proxies `request.URL` takes the host
that they forward. A trusted element with an invalid `for`, `proto` or `host` gives the protocol of
the connection. An application behind a TLS-terminating proxy must trust it:

```typescript
import { Binden } from "binden";

// One proxy that sends `Forwarded`
const app = new Binden({ trust_proxy: 1 });
// One proxy that sends X-Forwarded-For, X-Forwarded-Proto and X-Forwarded-Host (nginx, AWS ALB)
const behindNginx = new Binden({
  trust_proxy: { trust: 1, headers: "x-forwarded" },
});
```

Trusting the proxies by their addresses is safer: see
[Reverse proxies](PRODUCTION.md#reverse-proxies).

#### Request-targets

- A request-target with a fragment, a backslash, a space or a control character, an invalid
  percent-encoding or a dot-segment (`/a/../b`, also percent-encoded), a request with several `Host` field lines, and a request
  without a valid host get `400 Bad Request` (an invalid `Host` used to be a `500`, and several
  were reduced to the first one).
- The scheme of an absolute-form target no longer sets `request.secure` and the protocol of
  `request.URL`.
- A request whose path has `%2F` or `%5C` gets `400 Bad Request`: a router and a proxy (or a file
  server) would split such a path differently. `encoded_slashes: true` accepts them (route
  parameters then contain the decoded `/` or `\`).

#### Headers

`request.content_encoding` (and `ContentEncoding.fromString()`) is `null` when a coding is unknown
or malformed (it was a list), and `ContentEncoding` is no longer a subclass of `AcceptEncoding`:

```typescript
import { BindenError, type Context } from "binden";

const decodable = (context: Context): void => {
  if (context.request.content_encoding === null) {
    throw new BindenError(415);
  }
};
```

- The constructors of the headers throw a `TypeError` for what their parsers reject: `Range`,
  `AcceptEncoding`, `ContentType`, `ContentEncoding` (an unknown coding), `Authorization` (an
  unsupported scheme, or one not in its usual casing), `Forwarded` (control characters) and
  `IfModifiedSince` (an Invalid Date, or a year out of 0 to 9999).
- `ContentType#toString()` includes every parameter, and `Forwarded#toString()` quotes the values
  that are not tokens.
- `ContentType` requires the `boundary` of `multipart/form-data` in any case of the media type
  (e.g. `Multipart/Form-Data`), and refuses a parameter value that is not a valid field value (a
  control character, or a character above `\xFF`): so does `response.type()`.
- `new ContentRange({ size: "*" })` without a range throws a `TypeError`: an unsatisfied range
  needs the complete length (`bytes */<size>`).
- `new Cookie()` throws a `TypeError` for a name, a value or an attribute that would change the
  `Set-Cookie` header (e.g. a value with `;`), and `request.cookies` skips such cookies.

#### Servers and subclasses

`createServer()` and `createSecureServer()` register the server for `shutdown()`. For a server
created by other means, `serverOptions()` gives the request and response classes of the
application, and `callback(server)` its request listener: a request of other classes (e.g.
`BindenRequest` itself) is logged and its connection closed.

A subclass of `BindenRequest` (for a server created with `http.createServer()`) sets the request
options by overriding the protected `options` getter with the result of
`validateRequestOptions()` (the `trust_proxy` getter of the pre-release builds is gone):

```typescript
import { createServer } from "node:http";
import {
  BindenRequest,
  type IRequestOptions,
  validateRequestOptions,
} from "binden";

const options = validateRequestOptions({
  trust_proxy: { trust: 1, headers: "x-forwarded" },
});

class Request extends BindenRequest {
  protected override get options(): IRequestOptions {
    return options;
  }
}

createServer({ IncomingMessage: Request });
```

### Logging

- The framework logs its failures under the `failure` key, as a snapshot that it builds itself,
  instead of `{ context, error }`: the type of the error (`BindenError`, `BindenAbortError` or the
  nearest built-in error class), a known `code` (a system error, a few stream and HTTP codes, or
  `deadline` and `aborted`), its `status`, the `request_id` and the `location` (`middleware`,
  `error_handler`, `send`, `cleanup` or `shutdown`). Update the queries and alerts that read the
  `error` of these records.
- The message, the stack, the cause and any other `code` of an error may quote the input of a
  request: they are logged only with the `log_error_details: true` option.
- The default serializers log an allowlist of details: a `request` is `{ method, path }`
  (without the query and the headers), a `response` is `{ status }`, a `context` is
  `{ id, request, response }`, a `body` is redacted, and an `error` is `{ type, code, status }`
  (without the `expose` and the `json` of a `BindenError`). The default logger is created when
  it is first used, still with the level of `BINDEN_LOG_LEVEL`.
- `context.log` is an `ILogger` (it was the `Logger` class of `@binden/logger`): its methods
  return `unknown`, and its calls never throw. The `logger` option takes any `ILogger`.

To log more details (e.g. outside of production), pass a logger:

```typescript
import { Binden } from "binden";
import { Logger } from "@binden/logger";

// The messages and stacks of the errors, in the records of the application
// (`error_details`) and of the framework (`log_error_details`)
const logger = new Logger({ level: "debug", error_details: true });
const app = new Binden({ logger, log_error_details: true });
```

## @binden/logger

- The default serializers log an allowlist of details: an `error` is its type, a known `code` and
  its `status` (its message and stack only with the new `error_details: true` option), a `request`
  is `{ method, path }` and a `response` is `{ status }`. A value of another kind under these keys
  is reduced to `{ type }`. They were the standard serializers of `pino`, which log the headers
  of the requests and the messages of the errors.
- The `serializers` option replaces the default serializers of its own keys only: it used to
  replace all of them.
- `logger` (an existing `pino` logger) and `destination` throw a `TypeError` together: `logger`
  used to be ignored.
- The default logger (`import log from "@binden/logger"`) is created when it is first used:
  importing the package has no side effect, and `BINDEN_LOG_LEVEL` is read then.
- `pino` 10 is used (it was 9).

```typescript
import { Logger } from "@binden/logger";

// Before: the default `request` and `response` serializers were dropped
const logger = new Logger({
  level: "info",
  serializers: {
    user: (user: { id: string }): Record<string, unknown> => ({ id: user.id }),
  },
});
logger.info("Signed in", { user: { id: "42", email: "user@example.com" } });
```

New: `ILogger` (what binden needs), `child(bindings, { level })`, `level`, `isLevelEnabled()`,
`flush()`, `Logger.fromPino()` and `createSerializers()` (see the
[README](https://github.com/binden-js/binden/tree/main/packages/logger)).

## @binden/body

The statuses follow one rule: a body that cannot be parsed or decoded is a `400`, a body over a
limit a `413`, a coding or a charset that the parser does not support a `415`, and a failure of the
application a `500`.

| Request                                                   | 2.0.1                         | 4.0.0                                            |
| --------------------------------------------------------- | ----------------------------- | ------------------------------------------------ |
| Invalid JSON, corrupt compressed data                     | `415`                         | `400`                                            |
| `parse` returns `undefined`                               | `request.body` is `undefined` | `400`                                            |
| `parse` throws (other than a `BindenError`)               | `415`                         | `500`                                            |
| A JSON value other than an object or an array (e.g. `1`)  | parsed                        | `400` (`strict: false` parses it)                |
| An empty JSON body                                        | `415`                         | `request.body` is `undefined`                    |
| A JSON body of whitespace only                            | `415`                         | `400`                                            |
| Bytes that are not valid in the charset                   | replaced (`U+FFFD`)           | `400`                                            |
| A text body in another charset than UTF-8                 | decoded as UTF-8              | decoded with its charset (`415` for unknown one) |
| More than two content codings                             | decoded                       | `415`                                            |
| A form with more than 1000 parameters                     | parsed                        | `413` (`parameter_limit`)                        |
| A `+json` type (e.g. `application/ld+json`)               | skipped                       | parsed as JSON                                   |
| A request destroyed before it is read, an aborted request | skipped, or a `500`           | `400` (code `aborted`)                           |
| A parser that starts once the response has finished       | an empty body                 | `500`                                            |
| Data after the end of a content coding                    | ignored                       | `400`                                            |

- The `IBodyContentType` type is removed: the kinds of bodies are `IBodyKind` (`"json"`,
  `"text"`, `"form"` and `"raw"`).
- A custom `parse` gets the decoded text (not called for an empty body) and may be `async`. It
  rejects a body with `undefined` (`400`) or a `BindenError` (its status): an error that it lets
  through (e.g. the `SyntaxError` of `JSON.parse()`) is now a `500`.
- Nothing limits the size of a body by default (as before): set `limit` and `encoded_limit`.

```typescript
import { BindenError } from "binden";
import { BodyParser } from "@binden/body";

interface IPayment {
  amount: number;
}

const parse = (input: string): IPayment | undefined => {
  let value: unknown = null;
  try {
    value = JSON.parse(input);
  } catch {
    // Invalid JSON: `400 Bad Request` (a SyntaxError thrown here would be a 500)
    return undefined;
  }
  const { amount } = (value ?? {}) as { amount?: unknown };
  if (typeof amount !== "number") {
    throw new BindenError(422, { expose: true, message: "Invalid amount" });
  }
  return { amount };
};

const payments = new BodyParser({ parse, limit: 64 * 1024 });
// Any JSON value at the top level, as before
const values = new BodyParser({ strict: false, limit: 1024 * 1024 });
```

## @binden/multipart

- The default export takes the options of `Multipart` (it took the configuration of busboy):

  ```diff
  -const formData = multipart({ limits: { fields: 2, fileSize: 1024 } });
  +const formData = multipart({ config: { limits: { fields: 2, fileSize: 1024 } } });
  ```

- The options are validated when the middleware is created: an unknown option (also in `config`
  and `config.limits`) or an invalid value throws a `TypeError` or a `RangeError`.
- A body over a limit of `config.limits` gets `413 Content Too Large` (it was a `415`), a malformed
  body or boundary `400 Bad Request` (it was a `415`), and a `multipart/form-data` request without
  a boundary `400` (it was skipped).
- A client that goes away rejects `run()` with a `400` of code `aborted`. After the deadline or
  during a shutdown, `run()` rejects with the reason of `context.signal` (a `BindenAbortError`), as
  `@binden/body` does: the framework replies `503`.
- A parse that starts once the response has finished (Node.js has then discarded the body)
  rejects with a `500`: it was an empty or a malformed form.
- A body with a content coding (a `Content-Encoding` other than `identity`) gets
  `415 Unsupported Media Type`: it was parsed without being decoded.
- The parameters of the parts (e.g. the names of the files) are decoded as UTF-8 (busboy decodes
  them as Latin-1 by default): set `config.defParamCharset` to `"latin1"` to keep the former names.
- A file name is cleaned: its control characters are removed, it is cut to 255 bytes, and an empty
  one is `"blob"`.
- The files are `MultipartFile`s: `File`s with a `truncated` flag.
- `@types/busboy` is a dependency (it was a peer dependency): remove it from the application unless
  the application uses busboy itself.

```typescript
import multipart, { MultipartFile } from "@binden/multipart";
import { type Context, Router } from "binden";

const MiB = 1024 * 1024;
const formData = multipart({
  limit: 10 * MiB,
  config: {
    limits: { fileSize: 5 * MiB, files: 10, fields: 100, parts: 1000 },
  },
});

const upload = async (context: Context): Promise<void> => {
  const avatar = (context.request.body as FormData).get("avatar");
  if (!(avatar instanceof MultipartFile)) {
    return context.throw(400, { expose: true, message: "No avatar" });
  }
  await context.json({ name: avatar.name, size: avatar.size });
};

app.use("/avatar", new Router().post(formData, upload));
```

## @binden/compression

The coding is negotiated when the headers of a response are committed, once its status and its
headers are known:

- A request without `Accept-Encoding` (or with an empty one) gets an uncompressed response: it got
  `br`. The `DefaultCompression` constant, which named that fallback, is removed. `Vary: Accept-Encoding` is added to the
  responses whose coding depends on it.
- A request that refuses `identity` (`identity;q=0`, or `*;q=0` without `identity`) and accepts
  none of the codings gets `406 Not Acceptable`.
- A response smaller than `threshold` (`1024` bytes), or of a type that the `filter` refuses
  (`isCompressible()` by default: e.g. images, `text/event-stream`, or no `Content-Type`), is not
  compressed. Nor is a response without a body, a range (`206`, `Content-Range`), an encoded
  response or one with `Cache-Control: no-transform`, even with a fixed `format`.
- A compressed response loses its `Content-Length` and `Accept-Ranges`, and its strong `ETag`
  becomes weak. A request whose `If-Match` lists the strong `ETag` of the response gets that
  representation, uncompressed (a weak tag never meets a strong `If-Match`).
- `br` compresses with the quality 4 (it was 11, the default of `node:zlib`, which is meant for
  compression ahead of time).
- A second compression of the same response does nothing (it added a second coding).
- The `IComressFormats` type is renamed `ICompressFormats`.

```diff
-import type { IComressFormats } from "@binden/compression";
+import type { ICompressFormats } from "@binden/compression";
```

```typescript
import zlib from "node:zlib";
import { Compression, isCompressible } from "@binden/compression";

const compression = new Compression({
  // The quality of binden 2 (slow: for a few large responses that are cached)
  brotli: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } },
  // From 256 bytes, and NDJSON too
  threshold: 256,
  filter: (_context, type) =>
    type?.type === "application/x-ndjson" || isCompressible(type),
});
```

Server-sent events were compressed and held in the compressor: they are not compressed by
default, and a `filter` that compresses them must be followed by a `response.flush()` after each
event (see [Server-sent events](PRODUCTION.md#server-sent-events)).

## New features

These need no change, and are off by default unless noted:

- `binden`: request deadlines (`timeout`, `context.signal`, `context.setTimeout()`), cleanups
  (`context.onCleanup()`), graceful `shutdown()`, a typed `state`, `route()` and `mount()` with
  typed parameters, `request.ip`, `request.host`, `allowed_hosts`, request ids, content
  negotiation (`request.accepts()`, …), an access log, a dynamic `ETag`, `redirect()`,
  `attachment()`, `type()`, `vary()`, `clearCookie()`, `flush()`, and the options of `sendFile()`
  (see the [README](https://github.com/binden-js/binden/tree/main/packages/binden));
- `@binden/body`: `limit`, `encoded_limit`, `type`, `raw`, `verify` and `zstd`;
- `@binden/multipart`: `limit`, the disk and stream storages, `file_filter` and `multipartInfo()`;
- `@binden/compression`: `encodings`, `threshold`, `filter`, the options of the compressors,
  `zstd`, `flush()` and `skipCompression()`.
