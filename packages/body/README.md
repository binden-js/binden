# @binden/body [![CI Status](https://github.com/binden-js/binden/actions/workflows/ci.yml/badge.svg)](https://github.com/binden-js/binden/actions/workflows/ci.yml) [![version](https://img.shields.io/npm/v/@binden/body?style=plastic)](https://www.npmjs.com/package/@binden/body) [![Coverage Status](https://coveralls.io/repos/github/binden-js/binden/badge.svg?branch=main)](https://coveralls.io/github/binden-js/binden?branch=main) [![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://github.com/prettier/prettier) [![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](https://github.com/binden-js/binden/blob/main/CODE_OF_CONDUCT.md) [![semantic-release](https://img.shields.io/badge/semantic--release-conventional--commits-e10079.svg?logo=semantic-release)](https://github.com/semantic-release/semantic-release) [![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg)](https://conventionalcommits.org) ![node version](https://img.shields.io/node/v/@binden/body) ![npm downloads](https://img.shields.io/npm/dt/@binden/body) [![License](https://img.shields.io/npm/l/@binden/body)](https://github.com/binden-js/binden/blob/main/packages/body/LICENSE)

[Binden](https://github.com/binden-js/binden) body parser middleware: it reads the body of a request
into `request.body`, once its [content codings](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Encoding)
are removed, as

| Kind   | [Content types](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Type) (by default) | `request.body`                         | Empty body              |
| ------ | ---------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------- |
| `json` | `application/json`, and any `+json` type (e.g. `application/ld+json`)                                | the result of `parse` (`JSON.parse()`) | `undefined`             |
| `text` | `text/plain`                                                                                         | a `string`, decoded with its charset   | `""`                    |
| `form` | `application/x-www-form-urlencoded`                                                                  | `URLSearchParams`                      | empty `URLSearchParams` |
| `raw`  | `application/octet-stream` (with `raw: true` only)                                                   | a `Buffer`                             | empty `Buffer`          |

Any other body is **skipped**: it is not read, and is left to the next middlewares (e.g.
[`@binden/multipart`](https://github.com/binden-js/binden/tree/main/packages/multipart)).

## Installation

```bash
npm install @binden/body
```

## Usage

```typescript
import { type Context, Router } from "binden";
import { BodyParser } from "@binden/body";

// In production, limit the size of the bodies (here 1 MiB)
const body = new BodyParser({ limit: 1024 * 1024, encoded_limit: 1024 * 1024 });

const deposit = (context: Context): Promise<void> => {
  const { body: parsed } = context.request;
  return context.json({ received: parsed !== undefined });
};

app.use("/deposit", new Router().post(body, deposit));
```

The default export is a `BodyParser` with the default options (no limits).

## Options

| Option            | Default           | Description                                                                                                                 |
| ----------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `limit`           | none (`Infinity`) | The largest body in bytes once decoded, at every stage of the decoding: a larger one gets `413`                             |
| `encoded_limit`   | none (`Infinity`) | The largest body in bytes as received: a larger `Content-Length` gets `413` before the body is read, as does a larger body  |
| `parameter_limit` | `1000`            | The most parameters of a form: more get `413`                                                                               |
| `type`            | JSON, text, forms | The bodies to parse: a list of media types, or a function of the `Content-Type` (see [Selecting bodies](#selecting-bodies)) |
| `raw`             | `false`           | Whether `application/octet-stream` is parsed, as a `Buffer`                                                                 |
| `parse`           | `JSON.parse`      | Parses a JSON body, synchronously or not (see [Custom `parse`](#custom-parse))                                              |
| `strict`          | `true`            | Whether the default `parse` accepts only an object or an array                                                              |
| `verify`          | none              | Checks the decoded body before it is parsed (see [Verification](#verification))                                             |
| `verify_encoded`  | `false`           | Whether `verify` gets the body as received too                                                                              |
| `zstd`            | `false`           | Whether the `zstd` content coding is decoded (see [Content codings](#content-codings))                                      |
| `disabled`        | `false`           | Whether the middleware is skipped                                                                                           |
| `ignore_errors`   | `false`           | Whether its errors are ignored                                                                                              |

An invalid option throws a `TypeError` (or a `RangeError`) in the constructor, and so do options
that are not an object (or `undefined`: "`options` is not an object: …"); what reading them throws
(e.g. a revoked proxy) is formatted, as by every entry point of binden. The limits are non-negative
integers, or `Infinity` (no limit).

## Limits

The body is read into memory, and **nothing limits its size by default**: a small compressed body
may decode to gigabytes. In production, set `limit` (and `encoded_limit`) explicitly, e.g. to 1 MiB.

- `encoded_limit` counts the bytes as received: a larger `Content-Length` is refused before the
  body is read, and a body without it (chunked) is counted while it is read.
- `limit` counts the bytes that every decoder outputs (a counter follows each of them, the
  intermediate ones too), so that a body is not decoded beyond it at any stage. Without content
  codings, a larger `Content-Length` is refused before the body is read too. A coded body may be
  much larger than what it decodes to (e.g. a `deflate` stream of empty blocks): only
  `encoded_limit` bounds the bytes that are read, and kept for `verify_encoded`.
- `parameter_limit` counts the parameters of a form before they are parsed.

A body that exceeds a limit gets `413 Content Too Large`. A body that is refused before it has been
read completely is not read further: the request is paused (not destroyed, so that the reply is
sent), every decoder is destroyed, and the connection is closed after the reply
(`Connection: close`).

## Selecting bodies

`type` replaces the default selection, as a list of media types: `type/subtype`, `type/*`, `*/*`, or
a structured syntax suffix such as `+json`. Their kind is the one of the content type of the body:
`json` for `application/json` and `+json` types, `form` for `application/x-www-form-urlencoded`,
`text` for `text/*`, `raw` for any other type. `raw: true` adds `application/octet-stream` to the
list.

```typescript
import { BodyParser } from "@binden/body";

// CSV and HTML as text, and images as bytes
const uploads = new BodyParser({
  type: ["text/csv", "text/html", "image/*"],
  limit: 10 * 1024 * 1024,
});
```

A function of the `Content-Type` returns the kind of the body instead (`null` skips it). It is
called synchronously: one that throws, or that returns anything else than a kind or `null` (e.g. a
promise), is an error of the configuration (logged at `error`, `500 Internal Server Error`).

```typescript
import type { ContentType } from "binden";
import { BodyParser, type IBodyKind } from "@binden/body";

// Content Security Policy reports are JSON
const reports = new BodyParser({
  type: (content_type: ContentType): IBodyKind | null =>
    content_type.type === "application/csp-report" ? "json" : null,
  limit: 64 * 1024,
});
```

A body that is not selected is skipped (it is not read, and the parser does not mark it as
parsed), so that `BodyParser` and `Multipart` can be used together:

```typescript
import { BodyParser } from "@binden/body";
import { Multipart } from "@binden/multipart";

// JSON, text and forms by the first, `multipart/form-data` by the second
app.use(new BodyParser({ limit: 1024 * 1024 }), new Multipart());
```

A body is parsed once: another `BodyParser` that selects it later skips it.

## Content codings

`gzip`, `x-gzip`, `deflate` and `br` are decoded, as are two of them combined (e.g.
`Content-Encoding: gzip, br`). `identity` is no coding (RFC 9110): it is ignored, as in
`Content-Encoding: identity`. More than two codings, an unknown or unsupported coding (e.g.
`compress`) and an unknown charset (of a body that is not `raw`) get `415 Unsupported Media Type`,
before the body is read; corrupt data gets `400 Bad Request`. The codings of a body that is not
selected are not checked.

Data after the end of a coding (e.g. after the end of a `deflate` or `br` stream, or zero padding
after a `gzip` member or a `zstd` frame), which the decoders of Node.js would ignore while they go
on reading it, is corrupt data too: the reading stops there. So is a body that has a coding but not
a single byte, whatever the coding; a coding of an empty content (e.g. an empty `gzip` member) is
an empty body.

`zstd: true` decodes `zstd` too. Its API is experimental in Node.js, and a `zstd` decoder
allocates the window that a frame declares, whatever `limit` is: the parser refuses a window larger
than 8 MiB (`400 Bad Request`, as RFC 9659 allows), so a `zstd` body may still take up to 8 MiB of
memory per `zstd` coding (its frames are decoded one at a time).

Concatenated `gzip` members are one body, and so are concatenated `zstd` frames (RFC 8878), on
every supported version of Node.js: the parser finds the frames itself, and decodes them one after
the other, each data frame by a decoder of its own (but an empty one), which gets the bytes of that
frame only once they have been read. Once the decoder of a frame has ended, before the next frame is decoded, the
size of its content is checked against the `Frame_Content_Size` that the frame declares, if it
declares one: a different size is a `400`, however the body is split (and a frame that produces
more than it declares fails at once). Skippable frames are ignored, and a truncated frame is a
`400`. `limit` counts the content of all the frames, `encoded_limit` and `verify_encoded` the body
as received, skippable frames included.

A request has at most **1024 `zstd` frames**, on every supported version of Node.js: its data,
empty and skippable frames, over all its `zstd` codings (e.g. both codings of
`Content-Encoding: zstd, zstd`). Each frame is a step of the decoding, so that a body of many tiny
frames would cost much more than its size: the next frame gets `413 Content Too Large` (a
`BindenError` of code `zstd_frames`), before the decoder gets any byte of the chunk where it
starts. A compressed body is usually one frame; a client that compresses a stream may write a
frame per flush, which must stay within the limit.

Its **decoders are limited to 64 MiB** too, over all its `zstd` codings: a decoder allocates the
window of its frame (or its declared content size when smaller) and its buffers, so that a small
body of frames that each declare a large window would cost much more memory and garbage collection
than its size. Each frame that needs a decoder is charged its window, or its `Frame_Content_Size`
when smaller, and at least 256 KiB: a request has at most 256 decoders (e.g. of frames of a few
bytes each), and 8 of frames that declare a window of 8 MiB and no size. The next one gets the same
`413` (`zstd_frames`), before its decoder gets any byte. An empty frame (whose blocks are all empty,
of a declared size of 0 if any) needs no decoder and is not charged: the parser checks it as a
decoder would (its reserved bit, no dictionary, a window within 8 MiB, its blocks, and a checksum
that is that of no content).

## Custom `parse`

`parse` replaces `JSON.parse()` for the JSON bodies, synchronously or not: its result (or what its
promise resolves to) is `request.body`, whose type is inferred from it. It gets the body decoded
with its charset (an empty body is `undefined`, and a body of whitespace only is a `400` without
calling `parse`), and `strict` does not apply to it.

- `undefined` (as the parsers of [Ajv](https://ajv.js.org/guide/getting-started.html#parsing-and-serializing-json)
  return for an invalid body, with the reason in their `message`) is a `400 Bad Request`;
- a `BindenError` that it throws is the reply;
- any other failure is a `500 Internal Server Error`: a parser should reject an invalid body with
  `undefined`, or with a `BindenError` (e.g. `422`).

```typescript
import { Binden, type Context, Router } from "binden";
import { Ajv, type JTDDataType } from "ajv/dist/jtd.js";
import { BodyParser } from "@binden/body";

const port = 8080;
const ajv = new Ajv();
const schema = {
  properties: { username: { type: "string" }, password: { type: "string" } },
  additionalProperties: false,
} as const;
type ILogin = JTDDataType<typeof schema>;
const parse = ajv.compileParser<ILogin>(schema);
// `BodyParser<ILogin>`
const body_parser = new BodyParser({ parse, limit: 1024 * 1024 });
const login = (context: Context): Promise<void> => {
  const { username } = context.request.body as ILogin;
  return context.json({ username });
};
new Binden()
  .use("/login", new Router().post(body_parser, login))
  .createServer()
  .listen(port, () => {
    console.log(`Server is listening on the port ${port}`);
  });
```

## Verification

`verify(decoded, context, { encoded })` checks a body before it is parsed, synchronously or not:
it gets the body once its content codings are removed (a `Buffer`, before its charset is decoded),
even when it is empty, and, with `verify_encoded: true`, the body as received (`encoded`, within
`encoded_limit`; `null` otherwise). A `BindenError` that it throws is the reply, any other failure
is a `500 Internal Server Error`, and its result is ignored. For example, the signature of a
webhook:

```typescript
import { createHmac, timingSafeEqual } from "node:crypto";
import { BindenError, type Context, Router } from "binden";
import { BodyParser } from "@binden/body";

const secret = process.env.WEBHOOK_SECRET ?? "";

const webhook = new BodyParser({
  limit: 1024 * 1024,
  encoded_limit: 1024 * 1024,
  verify: (decoded: Buffer, context: Context): void => {
    const header = context.request.headers["x-signature"];
    const signature = Buffer.from(
      typeof header === "string" ? header : "",
      "hex",
    );
    const expected = createHmac("sha256", secret).update(decoded).digest();
    if (
      signature.length !== expected.length ||
      !timingSafeEqual(signature, expected)
    ) {
      throw new BindenError(401);
    }
  },
});

app.use(
  "/webhook",
  new Router().post(webhook, (context: Context) => context.send()),
);
```

## Aborted requests

The reading, `verify` and `parse` stop once `context.signal` is aborted: a promise of `verify` or
`parse` that never settles is abandoned (its late rejection is observed), and the parser does not
stay pending.

- A client that goes away gets a `BindenError(400, { code: "aborted" })` (logged at `debug`), also
  when the parser is still reading once the response has finished (e.g. it was not awaited): then
  `context.signal` is no longer aborted, but the connection closes before the body has been
  received whole.
- After the deadline of the request, the parser rejects with the reason of the signal (a
  `BindenAbortError` of reason `deadline`): the framework replies `503 Service Unavailable`, and
  closes the connection. When the timeout of a shutdown passes, the parser rejects with the
  reason `shutdown`, and the connection is closed without a reply.

A parser must start before the response has finished: Node.js then reads and discards what has
not been read of the body. A parser that starts later (e.g. after a middleware that has replied
without `done`) refuses the body with a `500 Internal Server Error` (logged at `error`), never
with an empty body.

`run()` reads each property of its context once, before anything is awaited (the request, the
response, the signal and the logger). What a later use of them throws stops the parse as any other
failure does: the request is unpiped, the decoders destroyed, the listeners removed, and the
connection closed after the reply. Examples are a context that only looks like one, such as a proxy
whose response's `setHeader()` throws as a chunked body goes over the limit, or whose signal's
`removeEventListener()` throws once the body is read. That error is the rejection of `run()`: the
first such error, as it is, formatted. It never crashes the process nor leaves `run()` pending, and
what the parse throws once something has been awaited (e.g. a logger, or the setter of
`request.body`) is formatted too.

## Errors

| Situation                                                                                                                                                          | Reply                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| Invalid JSON (for the default `parse`), whitespace only, not an object or an array (`strict`), `undefined` from `parse`                                            | `400 Bad Request`              |
| Corrupt compressed data (also data after the end of a coding, no byte at all, or a `zstd` frame not of its declared size), bytes that are not valid in the charset | `400 Bad Request`              |
| A client that goes away                                                                                                                                            | `400 Bad Request` (`aborted`)  |
| A limit is exceeded (`limit`, `encoded_limit`, `parameter_limit`)                                                                                                  | `413 Content Too Large`        |
| More than 1024 `zstd` frames in a request, or more than 64 MiB of their decoders                                                                                   | `413` (`zstd_frames`)          |
| An unknown or unsupported content coding, more than two codings, an unknown charset                                                                                | `415 Unsupported Media Type`   |
| A content type that is not selected                                                                                                                                | skipped (the body is not read) |
| A `BindenError` of `parse` or `verify`                                                                                                                             | that error                     |
| Any other failure of `parse` or `verify`, a `type` function that fails, a body that something else has read                                                        | `500 Internal Server Error`    |
| A parser that starts once the response has finished                                                                                                                | `500 Internal Server Error`    |
| A use of the context that throws once the parse has started                                                                                                        | that error, formatted (`500`)  |

The parser never logs the body itself: its logs have the reason of the refusal, and the type,
known `code` and status of an error.
