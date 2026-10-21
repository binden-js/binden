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
traces and "go to definition" lead to the sources rather than to `dist`.

The supported TypeScript setups are `@types/node` 24, type checked strictly, and `@types/node` 26
with `skipLibCheck: true`: with `@types/node` 26, the types of `thread-stream` (used by `pino`, the
logger of `@binden/logger`) do not compile, so `skipLibCheck: false` fails (see the
[known issues](https://github.com/binden-js/binden#known-issues)).

### MIT license

All the packages are published under the [MIT license](LICENSE) (they were under the
AGPL-3.0-only).

## binden

### Options are checked

`new Binden()`, `new Router()` and the constructor of every `Middleware` validate their options:
a value of the wrong type throws a `TypeError` (e.g. `new Router({ guarded: 1 })`, or a `logger`
without the methods of `ILogger`), and a value out of its range a `RangeError`. They used to be
coerced or ignored.

So does `new BindenError()` (and `context.throw()`): an `expose` that is not a boolean, a `json`
that is not a plain object (e.g. an array, which was sent as an object with numeric keys) or a
`message` that is not a string throws a `TypeError`. Its `json` is copied once, by the
constructor, which throws what reading it throws: binden 2.0.4 kept the object and copied it on
every read of `error.json`, so that a later change of the object showed, and its getters ran on
each read.

`new Context()` throws a `TypeError` for a `request` that is not a `BindenRequest`, a `response`
that is not a `BindenResponse` (also a proxy of one) and a `report` that is not a function:
binden 2.0.4 accepted any request (it read its `id`) and any response.

Options that are neither an object nor `undefined` throw a `TypeError` ("`options` is not an
object") in `new Binden()`, `createServer()`, `createSecureServer()`, `new Router()`, the
constructor of every `Middleware` and `new BindenError()` (also through `context.throw()`): binden
2.0.4 read a string or a number as an object without options, e.g.
`new BindenError(404, "Not found")` replied with the default message, `Not Found`. A function is
not an object of options either ("`options` is not an object: (a function)"), also one that
carries the options as its properties (which TypeScript accepts for the option types): binden
2.0.4 read its properties as the options.

```diff
-throw new BindenError(404, "Not found");
+throw new BindenError(404, { message: "Not found" });
```

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
  has committed its headers. Its `send()` of a stream or `sendFile()` that has not is cancelled
  first, as by a deadline (it rejects with the failure of the handler, or with
  `BindenError(500, { code: "error_handler_timeout" })` once the handler has timed out), and so is
  one that the stack has left pending: the `500` replaces them.

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

Once a request is abandoned (its deadline has passed, or its error handler has failed or timed
out), the work that still runs can no longer change its response: also the methods of Node.js
(`write()`, `end()`, `writeHead()`, `setHeader()`, `destroy()`, `setTimeout()`, …), `statusCode`,
`sendDate`, `shouldKeepAlive` and the cookies do nothing (a callback of `write()` or `end()` is
still called), so that a late middleware cannot replace or cut the reply of the error handler. An
array of the values of a header is copied when it is set or read (Node.js keeps the array itself). A deadline that passes before a `send()` of a stream
or a `sendFile()` has committed the headers cancels it (it rejects with the abort reason) and
replies `503`, instead of closing the connection; also while the error handler runs for another
error, whose later reply, failure or time out then changes nothing. A reply that a timed out error handler has
ended is still sent. The `503` of a deadline, the `500` of a failed error handler and the
default error reply close the connection (`Connection: close`) when the body of the request has
not been received in full (`request.complete`).

The default error reply is sent with the cookies of the response and the `headers` of a
`BindenError`, without the headers of the body that it replaces (`Content-Length`,
`Content-Encoding`, `ETag`, …). When a reply has started, the error cuts it by closing the
connection, so that the client knows that it is incomplete (it was ended as if it were complete),
and a reply that has ended is left as it is (its request was destroyed).

The type and language of the body that the error replaces are removed as well: an exposed
`message` is sent as `text/plain; charset=utf-8` (and `json` as `application/json`), never with
the `Content-Type` that the route had set (e.g. `text/html`, which used to be kept).

### Pipes and listeners of the response

The work of a request owns its response through what it adds to it, which changes a few
behaviours of Node.js:

- **An abandoned work sees its response closed early.** When a work loses the response (its
  deadline, a superseded, timed out or failed error handler, a failed pipe), its `close` listeners
  on the response (and its `error` listeners, with the error of its failed pipe) run once, on the
  next tick: an extension of the `close` event of Node.js. Cleanups that it has registered with
  `response.on("close")` run then, not at the real close; its `stream.pipeline()` and
  `stream.finished()` of the response settle with `ERR_STREAM_PREMATURE_CLOSE` (or that error).
  `context.onCleanup()` and the access log still run at the real close.
- **A legacy `Stream.prototype.pipe()` into the response is refused**: the work that has piped it
  fails with a `TypeError` (`500` before the headers), also through `stream.pipeline()`, which
  pipes such a stream with its own `pipe()`. Wrap such a stream (e.g. of an old stream library)
  with `new Readable().wrap(stream)`, then pipe the wrapper or send it
  (`context.send(new Readable().wrap(stream))`). A legacy pipe of a work of no request (or of
  another request), which has no `unpipe()`, cannot be dismantled: it is left to Node.js, with a
  warning, and writes as the work that feeds it.
- **A pipe that binden cannot attribute is refused** the same way: while the response or the source
  has listeners of `newListener` or `removeListener`, when the source is a `Proxy` or has its own
  listener methods, `emit()`, `pipe()`, `unpipe()`, `pause()`, `resume()`, `read()`,
  `rawListeners()`, `listeners()`, `listenerCount()`, `removeListener()`, `off()` or
  `removeAllListeners()` (e.g. patched on an instance; a pipe of the middleware stack whose source
  has no method of its own but listener methods is left to Node.js instead, see **OpenTelemetry**
  below), an accessor of its own of one of them or of `_readableState`, `_writableState`, `_events`,
  `_eventsCount`, `_maxListeners`, `readableEnded` or `destroyed`, or when it is not extensible
  (`Object.seal()`; Node.js itself cannot pipe a frozen stream). The class of the source (also of
  `readable-stream`) is trusted, with the whole prototype chain of the source, accessors included:
  only the own properties of the source are checked. Piping a stream that another work has patched
  (its class, any prototype of its chain, e.g. one inserted with `Object.setPrototypeOf()`, with its
  methods or accessors, or its own methods, which refuse the pipe once it is set up) runs that code
  as the work that pipes.
- **OpenTelemetry**: its `http` instrumentation binds every request and client response to its
  context (`context.bind()`: listener methods of their own). A native pipe of such a stream by a
  middleware (e.g. `request.pipe(response)` or `upstream.pipe(response)`, also through
  `stream.pipeline()`) is left to Node.js, as without binden: a write or an end of the response that
  throws in it is not caught (it is thrown out of the events of the stream, as with Node.js: e.g. an
  uncaught exception for a head that Node.js refuses), and any revocation of the stack during it
  (its deadline, or the failure of a pipe of its own) closes the connection instead of replying
  `503` (or `500`) unless its response has ended, also once the stream has ended (e.g. piped with
  `{ end: false }`). In an error handler, such a pipe is refused (`500`). Send such a stream with
  `context.send(stream)` (or pipe `new Readable().wrap(stream)`), which keeps those replies and
  fails the work for those throws.
- **A pipe whose write or end throws fails its work** (e.g. a reason phrase or a `Trailer` that
  Node.js refuses; not a pipe left to Node.js, see **OpenTelemetry** above): instead of a destroyed
  response (or a crash, from its end), the error handler replies before the headers, and the
  connection is closed afterwards (but a complete reply that waits for the response before it on
  its connection is sent); `stream.pipeline()` rejects with the error, and so does every pending
  `send()` of a stream or `sendFile()` that has not committed the headers (it is cancelled, as by a
  deadline, also one that the stack has left pending). A source piped by an error handler that
  errors or closes before its end fails the handler at once, as does a destroy of the response by
  its `stream.pipeline()` before the headers (also when one of its streams fails from a timer of no
  request): `500`, not a closed connection.
- A listener added to the source in the turn of its pipe runs as the work that has added it
  (e.g. one added by a listener of `pipe` of another work gets no rights from the pipe); one added
  later runs as the work that emits its event.
- `response.rawListeners()` has the listeners as Node.js has them (the listener itself, or the
  wrapper of a `once()`), and every listener and callback gets the receiver that Node.js gives it.

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
- `OPTIONS *` gets `204 No Content` with the methods of every router of the application in
  `Allow`, without running the stack (it ran the stack with the path `/*`).
- With `auto_head`, the `HEAD` middlewares of a router run when it has some; its `GET` middlewares
  handle `HEAD` only otherwise (they used to handle it in any case).
- `Binden` is a `Stack`: `app.stack` lists the layers of `use()`, `route()` and `mount()`, whose
  path is a string, a RegExp, `null`, `{ route }` or `{ mount }`. A string path of `use()` still
  matches exactly; the new `route()` and `mount()` take [patterns with parameters](https://github.com/binden-js/binden/tree/main/packages/binden#stack-and-routing).
- `use()` throws a `TypeError` without a middleware or router, or when its first argument is
  neither one nor a path (a string or a RegExp): `use(stack)` and `use(undefined)` were silently
  ignored. A stack is added with `mount()`.
- A RegExp path of `use()` keeps its flags (but `g` and `y`, which make `test()` stateful): it was
  compiled again as `new RegExp(path, "u")`, which dropped its flags and added `u`. A flag such as
  `i` now applies, and a RegExp that needs `u` (e.g. `/^\/\p{L}+$/u`, whose `\p{L}` is a literal
  `p{L}` without it) must have it.

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
- A `write()` or an `end()` that Node.js throws from once the head is committed (e.g. a body that
  does not have its `Content-Length` under `strictContentLength`) closes the connection: the
  response is destroyed before the error is thrown, so that nothing that it has queued is flushed,
  also for a later `write()` past the length, which Node.js refuses and keeps the response usable.
  `ERR_HTTP_BODY_NOT_ALLOWED` and the checks of a chunk (`ERR_INVALID_ARG_TYPE`,
  `ERR_STREAM_NULL_VALUES`, `ERR_UNKNOWN_ENCODING`) leave it usable, as with Node.js. Under
  `strictContentLength`, a first `write()` past a valid `Content-Length` throws
  `ERR_HTTP_CONTENT_LENGTH_MISMATCH` before anything is committed, where Node.js 24 and 26 and
  binden 2.0.4 send the whole chunk (the client reads its excess as the next response).
- A `Content-Length` that is neither a number nor a string (e.g. an object with a `toString()`),
  or an array with such an element or a hole, throws a `TypeError` (`ERR_HTTP_INVALID_HEADER_VALUE`,
  "Invalid Content-Length: …", the value described) when the head is committed, and a `send()`
  rejects with it before anything is sent (the error can be replied): binden 2.0.4, as Node.js,
  sent it converted (e.g. `Content-Length: 5` for `{ toString: () => "5" }`) without counting the
  body by it, so that a body of another length desynchronized the connection (the client read
  the response after it as part of the body). Set a number or a string.
- `writeContinue()`, `writeProcessing()`, `writeEarlyHints()` and `writeInformation()` throw
  `ERR_HTTP_HEADERS_SENT` once the head is committed, on every version of Node.js: on Node.js
  before 24.18, binden 2.0.4 (as `node:http`) wrote the raw `1xx` head of the first three into the
  body, which desynchronized the connection (Node.js 26 throws). A call that is ignored (by a work
  that can no longer change the response, or for an HTTP/1.0 client) is still ignored.
- `Content-Length` values that disagree (`["2", "3"]`, or two `appendHeader()` calls) now throw a
  `TypeError` (`ERR_HTTP_INVALID_HEADER_VALUE`, "Content-Length values disagree") when the head is
  committed, where Node.js and binden 2.0.4 sent every line. So does any comma list, even one whose
  members agree (`2, 3`, but also `2, 2` and `2,2`, alone or as an element of an array), with
  "Content-Length is a list": Node.js sends it as it is, and cannot read it.
- `send()` with a `1xx` status rejects with a `TypeError` (use `writeEarlyHints()`). A string sent
  with an `encoding` is encoded once: the bytes that it decodes to are sent, with their length. A
  `HEAD` response without a body gets `Content-Length: 0`, as for `GET`, and `send("")` gets the
  default `Content-Type` and the dynamic `ETag` of an empty body, as an empty `Buffer`. A
  `Readable` that has ended is an empty body.
- A `Readable` that has been destroyed, or that has errored without being destroyed (its
  `errored` is set, e.g. a stream without `autoDestroy`), rejects `send()` at once, with its
  `errored` (otherwise `ERR_STREAM_PREMATURE_CLOSE`). binden 2.0.4 rejected only when the error of
  the stream had not been emitted yet (e.g. a `destroy(error)` in the same tick as `send()`), and
  otherwise never settled.
- `send()` of a stream resolves once the response is flushed to the connection, where binden 2.0.4
  resolved at the end of the stream (its data could still be buffered), and it rejects when the
  client goes away before: with the error of the connection when a write fails first (e.g.
  `EPIPE`, `ECONNRESET` or `ECANCELED`), otherwise as a premature close
  (`ERR_STREAM_PREMATURE_CLOSE`). The send of binden 2.0.4 never settled then, unless the stream
  failed by itself (e.g. the request of an echo, with `ECONNRESET`).
- A `send()` that is ignored (once the response has ended, or by a work that can no longer change
  it, e.g. once its deadline has passed) releases a Node.js `Readable` without reading it: it is
  destroyed (closing the file of a stream), where binden 2.0.4 left it untouched. The request of
  the response itself (`send(context.request)`) is never destroyed. A `sendFile()` whose response
  has ended before it sends anything (before it is called, or while it opens its file) resolves
  without sending anything, where binden 2.0.4 rejected with `ERR_HTTP_HEADERS_SENT` (or with the
  error of its `stat()`).
- `send()` takes a Node.js `Readable` over: it is destroyed without being read when nothing of it
  would be sent (to `HEAD`, with a `204`, `205` or `304` status, and with a `1xx` status, which
  rejects), and once the client goes away, also when the stream is shared (e.g. one `PassThrough`
  sent to several responses: the others lose it too), where binden 2.0.4 piped it (reading it for
  a response without a body) and only unpiped it from a response that the client had left. A
  shared stream is also destroyed, where binden 2.0.4 delivered it whole to the other responses,
  when another writer ends the response (e.g. its own `end()`), and when binden fails the send
  itself (e.g. a body longer than its `Content-Length`): the stream is destroyed with that error,
  which the other sends of the stream reject with. Send each response a stream of its own (e.g. a
  `PassThrough` that the shared stream is piped into). The request of the response itself is only
  no longer read.
- A source that fails once the response has ended no longer rejects `send()`, whether another
  writer (e.g. its own `end()`) or the send itself, with the whole body, has ended the response:
  the reply is sent whole, and the responses after it on the connection too, and the error is
  logged at `debug`. binden 2.0.4 rejected with that error when another writer had ended the
  response, and its default error handler, which destroys the connection of a response that has
  ended, then cut the reply (the pipelined responses after it were never sent). It resolved the
  send of a whole body once its stream had ended (binden 4 resolves once the response is flushed),
  and ignored a later error of the stream.
- `send()` (and `context.send()`) rejects with a `TypeError`, before anything is sent, for an
  object that is neither a `Buffer`, a `Uint8Array`, a `Readable` nor a stream-like source: it sent
  its `toString()` (e.g. `[object Object]`, or the text of a `URLSearchParams`). Send a string
  instead (e.g. `send(String(value))`, or `form()` for `URLSearchParams`). A stream that is not a
  Node.js `Readable` (e.g. of `readable-stream` or `through2`: an object with `on()`, `pause()`,
  `resume()`, and `removeListener()` or `off()`) is sent as a stream (it sent `[object Object]`),
  and a `Uint8Array` is sent as its bytes (it sent its numbers, separated by commas).
- `text()`, `html()`, `form()` and `json()` of a response that has ended resolve without doing
  anything, as `send()` did and does: binden 2.0.4 set their `Content-Type` first, so that
  `text()`, `html()` and `form()` threw `ERR_HTTP_HEADERS_SENT` synchronously, and `json()`
  rejected with it. Of a response whose head is sent but that has not ended (e.g. after a
  `write()`), they reject with `ERR_HTTP_HEADERS_SENT`, also `text()`, `html()` and `form()`,
  which threw it synchronously: await them (a `try` around a call that is not awaited no longer
  catches it).
- `form()` sends only `URLSearchParams`, serialized by `URLSearchParams.prototype.toString()`:
  binden 2.0.4 sent `params.toString()` of whatever it was given (e.g. a string as it is, or the
  override of a subclass). Anything else now rejects with a `TypeError` ("The parameters are not
  URLSearchParams"); send a string with `text()` or `send()` and the `Content-Type` that it needs.
- `response.set()` sets the own enumerable properties of its object (by `Object.entries()`), and
  throws a `TypeError` ("`headers` is not an object") for anything but an object, also a function.
  binden 2.0.4 set every enumerable property by `for…in`, also an inherited one (e.g. of
  `Object.create(defaults)`): it did nothing for `null`, `undefined` or a number, set the headers
  `0` and `1` for `"ab"`, and set the enumerable properties of a function. Copy inherited headers
  into the object (e.g. `set({ ...defaults, ...headers })`).
- The `q_value` of an `AcceptEncoding` must be a number or `null`: binden 2.0.4 kept any value (e.g.
  `"0.5"`) as its `q_value`, but serialized only a number (`toString()` dropped the weight of any
  other value, e.g. `gzip` for `"0.5"`). Anything else now throws a `TypeError` ("`q_value` is not a
  number").
- `response.type()` throws a `TypeError` for a parameter that is not a token with a token or a
  quoted string as value (e.g. `text/plain; charset`), which it used to drop.
- With `root`, `sendFile()` replies `404` for a socket, a device or a FIFO, without opening it.
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
- `new ContentType({ charset })` throws a `TypeError` for a `charset` that is neither a string nor
  `null` or `undefined` ("`charset` is not a string: …"), for every media type: binden 2.0.4
  dropped it.
- `ContentType` requires the `boundary` of `multipart/form-data` in any case of the media type
  (e.g. `Multipart/Form-Data`), and refuses a parameter value that is not a valid field value (a
  control character, or a character above `\xFF`): so does `response.type()`.
- `new ContentRange({ size: "*" })` without a range throws a `TypeError`: an unsatisfied range
  needs the complete length (`bytes */<size>`).
- `new Cookie()` throws a `TypeError` for a name, a value or an attribute that would change the
  `Set-Cookie` header (e.g. a value with `;`), and `request.cookies` skips such cookies.
- The constructor of every header throws a `TypeError` for an init that is not an object
  ("`init` is not an object: …"): binden 2.0.4 read a string as an object without its properties
  (e.g. `new Range("bytes=0-1")` was `bytes=-`), or threw an unrelated error. A function is not an
  init either: binden 2.0.4 read its properties as the init (e.g. `new Range(init)` of
  `Object.assign(() => {}, { start: 0, end: 1 })` was `bytes=0-1`).
- `Cookie.fromString()`, `Range.fromString()` and `IfModifiedSince.fromString()` throw a
  `TypeError` for anything but a string or `undefined` ("The header is not a string: …"), where
  binden 2.0.4 returned no cookies, no ranges or `null` for e.g. `null`, a number or an array. So
  do `request.cookies`, `request.range` and `request.if_modified_since` for such a value that the
  application has put into `request.headers`.
- `AcceptEncoding.fromString()` throws a `TypeError` for an element of an array that is not a
  string ("A field line is not a string: …"), which binden 2.0.4 converted with `join()` (e.g. by
  its `toString()`).
- `AcceptEncoding.fromString()`, `Authorization.fromString()`, `ContentEncoding.fromString()`,
  `ContentRange.fromString()`, `ContentType.fromString()` and `Forwarded.fromString()` throw a
  `TypeError` for a `String` object (e.g. "The header is not a string: (an object)"), which binden
  2.0.4 parsed as its string: so do `request.content_type` and `request.authorization` for a
  `String` object that the application has put into `request.headers`. Give a string (e.g.
  `String(value)`).
- `new IfModifiedSince({ date })` takes a `Date`, a number or a string: `null` and a boolean (1970
  for binden 2.0.4, e.g. `{ date: true }`), `undefined` (an Invalid Date for binden 2.0.4) and
  other objects (converted, e.g. by their `valueOf()`) throw a `TypeError` ("The date is not a
  Date: …").
- `request.header()` and `router.middlewares()` throw a `TypeError` for a name or a method that is
  not a string, where binden 2.0.4 accepted a `String` object, or anything with a `toLowerCase()`
  (a `toUpperCase()` for `middlewares()`).

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

The stack of a `BindenError` is formatted in its constructor (see
[Lifecycle](https://github.com/binden-js/binden/tree/main/packages/binden#lifecycle)), so that
an error that is kept retains nothing of its frames: its header (`BindenError: <message>`) is
fixed then. A `message` or a `name` that the application changes later, and an
`Error.prepareStackTrace` installed later (e.g. by `source-map-support` or an APM agent; one
installed before still formats it), no longer apply to its `stack`, which binden 2.0.4 left to
V8 to format when it was first read. Pass the message through the options, or create an
instance of a subclass, whose stack the constructor of `BindenError` does not format, so that
its own constructor gives it its header (e.g. its `name`):

```typescript
import { BindenError } from "binden";

// `error.message = "No user 42"` after `new BindenError(404)` no longer changes its stack
const notFound = new BindenError(404, { message: "No user 42" });

class ValidationError extends BindenError {
  public constructor(message: string) {
    super(400, { message });
    this.name = "ValidationError";
  }
}

// Its stack starts with "ValidationError: Invalid email"
const invalid = new ValidationError("Invalid email");
```

## @binden/logger

- The default serializers log an allowlist of details: an `error` is its type, a known `code` and
  its `status` (its message and stack only with the new `error_details: true` option), a `request`
  is `{ method, path }` and a `response` is `{ status }`. A value of another kind under these keys
  is reduced to `{ type }`. They were the standard serializers of `pino`, which log the headers
  of the requests and the messages of the errors.
- The `serializers` option replaces the default serializers of its own keys only: it used to
  replace all of them.
- `new Logger()` throws a `TypeError` for options that are neither an object nor `undefined`
  ("`options` is not an object: …"), also a function: @binden/logger 2.0.3 read a string or a
  number as no options, and the properties of a function as the options. `Logger.getLevel()`
  throws a `TypeError` for a name that is not a string, which 2.0.3 converted (e.g. `5` read the
  variable `5`).
- `logger` (an existing `pino` logger) and any other option (`destination`, `level`,
  `serializers`, `error_details`, …) throw a `TypeError` together: the other options do not apply
  to it (`logger` used to be ignored with `destination`, and the other options with `logger`). A
  `logger` that is not a `pino` logger, and an unknown level (of the options, of `child()` or set
  to `level`), throw a `TypeError` as well.
- The `err` key, under which `pino` logs an `Error` given as the fields of a record, has the
  default `error` serializer too: the serializer of `pino` logged the message, the stack and
  every property of the error.
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
- `new BodyParser()` throws a `TypeError` for options that are neither an object nor `undefined`
  ("`options` is not an object: …"), also a function: @binden/body 2.0.1 read a string or a
  number as no options, and the properties of a function as the options.
- A body that the parser refuses before it has read it in full (e.g. over a limit, or with a coding
  or a charset that it does not support) closes the connection after the reply, whoever replies
  (the default error reply, or an `error_handler` of the application, also one that echoes the
  request with `send(context.request)`). binden 2.0.4 with @binden/body 2.0.1 kept the connection,
  and answered the next request on it.

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
  and `config.limits`) or an invalid value throws a `TypeError` or a `RangeError`, and so do
  options that are neither an object nor `undefined` ("`options` is not an object"), also a
  function: @binden/multipart 2.0.3 read a string or a number as no options, and the properties
  of a function as the options.
- A body over a limit of `config.limits` gets `413 Content Too Large` (it was a `415`), a malformed
  body or boundary `400 Bad Request` (it was a `415`), and a `multipart/form-data` request without
  a boundary `400` (it was skipped).
- A client that goes away rejects `run()` with a `400` of code `aborted`. After the deadline or
  during a shutdown, `run()` rejects with the reason of `context.signal` (a `BindenAbortError`), as
  `@binden/body` does: after the deadline the framework replies `503`, and a shutdown closes the
  connection without a reply.
- A parse that starts once the response has finished (Node.js has then discarded the body)
  rejects with a `500`: it was an empty or a malformed form.
- A body with a content coding (a `Content-Encoding` other than `identity`) gets
  `415 Unsupported Media Type`: it was parsed without being decoded.
- A body that the parser refuses before it has read it in full (e.g. over a limit) closes the
  connection after the reply, whoever replies (the default error reply, or an `error_handler` of
  the application, also one that echoes the request with `send(context.request)`). binden 2.0.4
  with @binden/multipart 2.0.3 kept the connection, and answered the next request on it.
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
  `br`. The `DefaultCompression` constant, which named that fallback, is removed.
  `Vary: Accept-Encoding` is added to every response with a body.
- A fixed `format` is no longer sent whatever the request accepts: it is the only coding offered,
  and a request that does not accept it (or sends no `Accept-Encoding`) gets the response as it is.
- A request that refuses `identity` (`identity;q=0`, or `*;q=0` without `identity`) and accepts
  none of the codings gets `406 Not Acceptable`, also for a response that is not compressed (see
  below). An encoded response (a `Content-Encoding` set by the application, e.g. of a
  precompressed file) gets `406` when the request does not accept its coding (also with an empty
  `Accept-Encoding`). A response without a body never does.
- A response smaller than `threshold` (`1024` bytes), or of a type that the `filter` refuses
  (`isCompressible()` by default: e.g. images, `text/event-stream`, or no `Content-Type`), is not
  compressed. Nor is a response without a body, a range (`206`, `Content-Range`), an encoded
  response or one with `Cache-Control: no-transform`, even with a fixed `format`.
- A compressed response loses its `Content-Length` and `Accept-Ranges`, and its strong `ETag`
  becomes weak. `sendFile()` and the dynamic `ETag` choose the representation before they evaluate
  the preconditions: once compressed, a strong `If-Match` fails with `412 Precondition Failed` (a
  weak tag never meets it), and `Range` is ignored (the whole compressed file is sent). A client
  that needs either sends `Accept-Encoding: identity`.
- `br` compresses with the quality 4 (it was 11, the default of `node:zlib`, which is meant for
  compression ahead of time).
- A second compression of the same response does nothing (it added a second coding).
- A response to `HEAD` gets the decision of `GET` by the same body: the chunk of its `end()`, or
  the `Content-Length` of a stream that `send()` does not read (without one, a body of unknown
  length, never an empty one).
- What the decision reads (the status, the headers of the representation, `skipCompression()`) is
  set before the reply starts (`send()`, `sendFile()`, or a first write), which may choose the
  representation at once. Once the work of a request is abandoned (e.g. at its deadline),
  `skipCompression()` and the `run()` of a compression are ignored.
- `Content-Digest`, `Repr-Digest` and `Digest` are removed from a compressed response and from
  the empty `406` and `500` that replace a response: they were kept for a body they no longer
  matched.
- A reason phrase, a header or a status that Node.js refuses throws before the decision (or leaves
  nothing of it), and the error is replied as without a compression, without compressed bytes.
- `new Compression()` throws a `TypeError` for options that are neither an object nor `undefined`
  ("`options` is not an object: …"), also a function: @binden/compression 3.0.0 read a string or
  a number as no options, and the properties of a function as the options.

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
