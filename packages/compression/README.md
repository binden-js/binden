# @binden/compression [![CI Status](https://github.com/binden-js/binden/actions/workflows/ci.yml/badge.svg)](https://github.com/binden-js/binden/actions/workflows/ci.yml) [![version](https://img.shields.io/npm/v/@binden/compression?style=plastic)](https://www.npmjs.com/package/@binden/compression) [![Coverage Status](https://coveralls.io/repos/github/binden-js/binden/badge.svg?branch=main)](https://coveralls.io/github/binden-js/binden?branch=main) [![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://github.com/prettier/prettier) [![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](https://github.com/binden-js/binden/blob/main/CODE_OF_CONDUCT.md) [![semantic-release](https://img.shields.io/badge/semantic--release-conventional--commits-e10079.svg?logo=semantic-release)](https://github.com/semantic-release/semantic-release) [![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg)](https://conventionalcommits.org) ![node version](https://img.shields.io/node/v/@binden/compression) ![npm downloads](https://img.shields.io/npm/dt/@binden/compression) [![License](https://img.shields.io/npm/l/@binden/compression)](https://github.com/binden-js/binden/blob/main/packages/compression/LICENSE)

[Binden](https://github.com/binden-js/binden) compression middleware: `br`, `gzip`, `deflate` and (opt-in) `zstd`.

## Installation

```bash
npm install @binden/compression
```

## Usage

```typescript
import { Binden } from "binden";
import compression, { Compression } from "@binden/compression";

// With the default options
const app = new Binden().use(compression);

// Or with options of its own
const other = new Binden().use(
  new Compression({ threshold: 2048, encodings: ["br", "gzip"] }),
);

app.createServer().listen(8080);
other.createServer().listen(8081);
```

The compression replaces `writeHead()`, `write()`, `end()` and `flush()` on the response of each
request, so that every writer (the following middlewares, `send()`, `sendFile()`, the error handler, a
piped stream) goes through it. It is installed once per response: a second compression on the
same response does nothing. A head that Node.js refuses (e.g. a reason phrase with a line break,
or a `Trailer` of a body that is not chunked) throws as without a compression, and leaves nothing
of the decision, whether the body would be compressed or sent as it is: the compressor is
destroyed, and the status, the headers and the framing of Node.js (e.g. whether it closes the
connection) are those from before, so that the error is replied with a decision of its own.

The arguments of a `write()` or an `end()` are checked first, as binden checks them, and a refused
one throws before anything is decided or changed:

- a chunk that Node.js refuses (neither a string nor bytes) throws the error of Node.js. As for
  Node.js, a falsy chunk of `end()` is none: `end(null)`, `end(0)` and `end(false)` are a plain
  `end()`, while `write(null)` throws. Nothing of the socket is changed either (`end()` of Node.js
  would leave it corked, and the next reply stalled), also once the response has been replaced
  (`406`) or ended through its compressor: it throws as for a response that has not ended, rather
  than the `error` event that Node.js emits for an ended one (a response that the application has
  ended as it is answers as without a compression);
- an unknown encoding (or `buffer` for a string) throws `ERR_UNKNOWN_ENCODING`, but for a response
  without a body (to `HEAD`, or with a 1xx, 204 or 304 status), whose chunks Node.js ignores;
- a string in `hex`, `base64` or `base64url` (the name in any case) is written as the bytes that
  `Buffer.from()` decodes from it: Node.js only estimates its length, which may be more than it
  writes (e.g. for invalid digits). The decision (the `threshold`) and the framing of the body
  are those of its bytes. An explicit `Content-Length` is never replaced.

## Options

| Option                      | Default                     | Description                                                                                                                |
| --------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `format`                    | `"auto"`                    | `"auto"` negotiates the coding with `Accept-Encoding`; `"br"`, `"gzip"`, `"deflate"` or `"zstd"` is the only one offered   |
| `encodings`                 | `["br", "gzip", "deflate"]` | The codings that `"auto"` offers, the preferred first (only with `"auto"`). `zstd` is offered only when listed             |
| `threshold`                 | `1024`                      | A response whose `Content-Length` is smaller (in bytes) is not compressed; a response without a length may be              |
| `filter`                    | `isCompressible`            | `(context, content_type) => boolean`: whether a response is compressed, by its `Content-Type` (`null` without a valid one) |
| `gzip`, `deflate`           | `{}`                        | The [options](https://nodejs.org/api/zlib.html#class-options) of the compressors                                           |
| `brotli`                    | `BROTLI_PARAM_QUALITY` `4`  | The [options](https://nodejs.org/api/zlib.html#class-brotlioptions) of the `br` compressor                                 |
| `zstd`                      | `{}`                        | The [options](https://nodejs.org/api/zlib.html#class-zstdoptions) of the `zstd` compressor                                 |
| `disabled`, `ignore_errors` | `false`                     | As for every `Middleware`                                                                                                  |

Invalid options throw a `TypeError` (or a `RangeError`) in the constructor: also invalid options of a
compressor (one is created to check them), and `zstd` (by `format` or `encodings`) on a version of
Node.js whose `node:zlib` does not have it.

The quality of `br` is 4 by default, rather than the 11 of `node:zlib`: 11 is meant for compressing
ahead of time, and is far too slow for responses compressed as they are sent. Set it with
`brotli: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }` (e.g. for a few large responses
that are cached).

### `filter`

The default filter, `isCompressible()`, compresses text (`text/*`, but `text/event-stream`), JSON and
XML (also as `+json` and `+xml`, such as `image/svg+xml`), JavaScript, WebAssembly, and uncompressed
fonts and images (`font/ttf`, `font/otf`, `image/bmp`, …). A response without a valid `Content-Type` is
not compressed.

`filter` is called synchronously, once per response, when its representation is chosen (see
[When a response is compressed](#when-a-response-is-compressed)). It must return a
boolean: anything else (a promise as well) is a configuration error, which is logged (`error`) and
replaces the response with an empty `500 Internal Server Error`, as does a filter that throws.

```typescript
import { Binden, type ContentType, type Context } from "binden";
import { Compression, isCompressible } from "@binden/compression";

// Also compresses `application/x-ndjson`, but never the responses of `/download`
const compression = new Compression({
  filter: (context: Context, type: ContentType | null): boolean =>
    !context.url.pathname.startsWith("/download") &&
    (type?.type === "application/x-ndjson" || isCompressible(type)),
});

new Binden().use(compression).createServer().listen(8080);
```

## When a response is compressed

The decision is taken once for each response, when its status and its representation are known:
whatever the following middlewares set before is taken into account. A response to `HEAD` gets the
decision of the response to `GET`, by the same body: the chunk of its `end()` (which Node.js does
not send), or the `Content-Length` of a stream that `send()` does not read for `HEAD` (a stream
without one is a body of unknown length, not an empty one). It is taken when its headers are
committed (by `writeHead()`, `flushHeaders()`, `flush()`, or the first `write()` or `end()`), or
before:

- `sendFile()`, and `send()` with the dynamic `ETag` of binden, choose the representation of their
  body before they evaluate the preconditions of the request (`If-Match`, `If-None-Match`, …), so
  that these apply to the representation that is sent (see
  [A compressed response](#a-compressed-response)). The choice sends no header and creates no
  compressor: the commit of the headers applies it. A reply that replaces that body (e.g. of the
  error handler, once the file has failed or the deadline has passed) gets a decision of its own.
- `send()` of a stream that it does not read (for `HEAD`, or a status without a body) chooses the
  representation of the `Content-Length` of the response (of an unknown length without one).

So what the decision reads (the status, `Content-Type`, `Content-Encoding`, `Content-Length`,
`Cache-Control` and `skipCompression()`) must be set before the reply starts (`send()`,
`sendFile()`, or a first write): a later change may not be taken into account. Once the work of a
request may no longer change its response (e.g. abandoned at its deadline), `skipCompression()`
and the `run()` of a compression are ignored, as its other changes are.

A response without a body is sent as it is, whatever the request accepts: a `1xx`, `204` or `205`
status, or an empty body (`Content-Length: 0`, e.g. of a `304` that stands for an empty `200`). Any
other response depends on the `Accept-Encoding` of the request (`Vary: Accept-Encoding`, see
[Content negotiation](#content-negotiation)), and may be compressed unless:

- it is a range (`206`, or any `Content-Range`): ranges refer to the representation as it is;
- it is encoded already (`Content-Encoding` other than `identity`; an `identity` is removed);
- it has `Cache-Control: no-transform`;
- `skipCompression()` has been called for it;
- the `filter` refuses it, or its `Content-Length` is below the `threshold`.

A response that may not be compressed is sent as it is when the request accepts it, and replaced
with `406 Not Acceptable` otherwise (also with a fixed `format`). The compression leaves a response
alone only when it ran once its headers had been sent.

```typescript
import { Binden, type Context } from "binden";
import compression, { skipCompression } from "@binden/compression";

// A response that is never compressed: before its reply starts
const handler = (context: Context): Promise<void> => {
  skipCompression(context.response);
  return context.text("as it is");
};

new Binden().use(compression).use("/raw", handler).createServer().listen(8080);
```

### Content negotiation

The representation is chosen with the `Accept-Encoding` of the request
([RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#section-12.5.3)), and `Vary: Accept-Encoding`
is added to every response with a body:

- the response is compressed with the coding of `encodings` (with `format: "auto"`), or the fixed
  `format` (the only one offered then), of the greatest weight (its own `q`, or the one of `*`;
  `x-gzip` is `gzip`), the earlier one of `encodings` on a tie, unless `identity` weighs more.
  Browsers (`gzip, deflate, br, zstd`) get `br`. A coding with `q=0`, or that the header does not
  name (without `*`), is not acceptable;
- without `Accept-Encoding`, or with an empty one, the response is not compressed (any coding is
  acceptable without the header, but the response as it is suits a client that does not ask for
  one);
- `identity` (the response as it is) is acceptable unless refused (`identity;q=0`, or `*;q=0`
  without `identity`). When nothing is acceptable, the response is replaced with
  `406 Not Acceptable`: an empty body (`Content-Length: 0`) without the headers of the body that
  it replaces, as an error reply of binden (its type, framing with `Trailer`, validators,
  digests, …), nor `Accept-Ranges`. What the application writes afterwards is discarded (the
  callbacks of its writes still run, and a refused chunk or encoding still throws);
- an encoded response (e.g. a precompressed file, with the `Content-Encoding` that the application
  has set) has no other version: it is sent as it is when the request accepts its coding (any
  coding without `Accept-Encoding`, none with an empty one), and replaced with `406` otherwise.

A fixed `format` offers one coding, so that a proxy that negotiates can ask for it (e.g. `zstd`,
which `auto` does not offer by default): a request that does not accept it gets the response as it
is (or `406`).

### A compressed response

- `Content-Encoding` names the coding; `Content-Length` and `Accept-Ranges` are removed (ranges of
  the compressed body are not served), as are the digests of the uncompressed body
  (`Content-Digest`, `Repr-Digest` and `Digest`,
  [RFC 9530](https://www.rfc-editor.org/rfc/rfc9530.html)), which the compressed body does not
  match. The body is sent in chunks
  (`Transfer-Encoding: chunked`, also on the headers of `HEAD`), or to an HTTP/1.0 client delimited
  by closing the connection (`Connection: close`, and never a `Transfer-Encoding`): a stale framing
  header (e.g. copied from an upstream response) neither closes a connection that may be kept alive
  nor sends chunks to a client that does not know them;
- a strong `ETag` becomes weak (`W/"…"`, [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#section-8.8.3.3)):
  it was set for the bytes of the uncompressed body. It still validates caches (`If-None-Match`
  compares weakly), but no longer ranges (`If-Range`) nor `If-Match`, which
  [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.1) compares strongly.
  `sendFile()` and the dynamic `ETag` of binden evaluate the preconditions against the compressed
  representation: a strong `If-Match` (e.g. the `validator` of a file) fails with an empty
  `412 Precondition Failed`, without `Content-Encoding` (nothing is compressed), while
  `If-Match: *` matches any representation. A request that must meet a strong `If-Match` accepts
  the uncompressed representation only (`Accept-Encoding: identity`);
- `sendFile()` sends a compressed file whole: `Range` (and `If-Range`) is ignored, as the ranges
  would be of the compressed bytes. The uncompressed file keeps its ranges (`206`, `416`);
- a `304 Not Modified` (e.g. of `sendFile()`, or of the dynamic `ETag` of binden) gets the same
  decision as the `200` that it stands for (as a response to `HEAD` gets the one of `GET`): the same
  `ETag` and `Vary`, without `Content-Length` and `Accept-Ranges` when the `200` is compressed, but
  without `Content-Encoding` (a cache that updates its stored response with it could mislabel an
  uncompressed one). The `threshold` applies to it by
  its `Content-Length`, the length of that `200` (binden keeps it on the `304` of `sendFile()` and of
  its dynamic `ETag`); a `304` without one gets the decision of a body without a length;
- errors and backpressure are kept: `write()` returns `false` while the compressor is full, the
  response emits `drain` once it is not, the callbacks of `write()` get the errors, the callback of
  `end()` runs once the response has finished, and `writableEnded` is set by `end()`. A client that
  goes away closes the compressor (its pending writes fail).

## `flush()` and server-sent events

`response.flush()` of a compressed response flushes the compressor (`Z_SYNC_FLUSH`,
`BROTLI_OPERATION_FLUSH` or `ZSTD_e_flush`): what has been written so far can be decompressed by the
client. Its promise resolves once the response has written the flushed bytes, and rejects if the
response is closed (or fails) before. Without a compressor, it is the `flush()` of binden.

Server-sent events (`text/event-stream`) are not compressed by default: an event would wait in the
compressor. A filter may compress them, with a `flush()` after each complete event:

```typescript
import { Binden, type ContentType, type Context } from "binden";
import { Compression, isCompressible } from "@binden/compression";

const sse = new Compression({
  filter: (_context: Context, type: ContentType | null): boolean =>
    type?.type === "text/event-stream" || isCompressible(type),
});

const events = async (context: Context): Promise<void> => {
  const { response } = context;
  context.done = true;
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  for (let id = 1; id <= 3 && !context.signal.aborted; id += 1) {
    response.write(`id: ${id}\ndata: ${new Date().toISOString()}\n\n`);
    // The event reaches the client now
    await response.flush();
    await new Promise((resolve) => {
      setTimeout(resolve, 1000);
    });
  }
  response.end();
};

new Binden().use("/events", sse, events).createServer().listen(8080);
```

## zstd

`zstd` is offered only when it is listed in `encodings` (or set as the `format`): it needs a version of
Node.js whose `node:zlib` has it (22.15, 23.8 and later; it is tested from 24.14.1), and not every
client supports it (e.g. Safari does not). Without it in `node:zlib`, the constructor throws a
`TypeError`.

```typescript
import { Binden } from "binden";
import { Compression } from "@binden/compression";

const compression = new Compression({ encodings: ["zstd", "br", "gzip"] });

new Binden().use(compression).createServer().listen(8080);
```
