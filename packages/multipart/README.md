# @binden/multipart [![CI Status](https://github.com/binden-js/binden/actions/workflows/ci.yml/badge.svg)](https://github.com/binden-js/binden/actions/workflows/ci.yml) [![version](https://img.shields.io/npm/v/@binden/multipart?style=plastic)](https://www.npmjs.com/package/@binden/multipart) [![Coverage Status](https://coveralls.io/repos/github/binden-js/binden/badge.svg?branch=main)](https://coveralls.io/github/binden-js/binden?branch=main) [![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://github.com/prettier/prettier) [![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](https://github.com/binden-js/binden/blob/main/CODE_OF_CONDUCT.md) [![semantic-release](https://img.shields.io/badge/semantic--release-conventional--commits-e10079.svg?logo=semantic-release)](https://github.com/semantic-release/semantic-release) [![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg)](https://conventionalcommits.org) ![node version](https://img.shields.io/node/v/@binden/multipart) ![npm downloads](https://img.shields.io/npm/dt/@binden/multipart) [![License](https://img.shields.io/npm/l/@binden/multipart)](https://github.com/binden-js/binden/blob/main/packages/multipart/LICENSE)

[Binden](https://github.com/binden-js/binden) `multipart/form-data` parser middleware (based on [busboy](https://github.com/mscdex/busboy)).

A request of another media type is skipped, and its body is not read: another parser (e.g. [`@binden/body`](https://github.com/binden-js/binden/tree/main/packages/body)) can take it. A request that the middleware has already parsed is skipped too.

The parser does not decode content codings: a `multipart/form-data` body with a `Content-Encoding` other than `identity` (e.g. `gzip`) gets `415 Unsupported Media Type`, before it is read.

## Installation

```bash
npm install @binden/multipart
```

## Usage

The fields and the files are parsed into a `FormData` (`request.body`), in the order of the request. A file is a `MultipartFile`: a `File` that tells whether its content has been truncated.

```typescript
import { type Context, Router } from "binden";
import multipart, { MultipartFile } from "@binden/multipart";

const MiB = 1024 * 1024;
const formData = multipart({
  limit: 10 * MiB,
  config: {
    limits: { fileSize: 5 * MiB, files: 10, fields: 100, parts: 1000 },
  },
});

const upload = async (context: Context): Promise<void> => {
  const form = context.request.body as FormData;
  const avatar = form.get("avatar");
  if (!(avatar instanceof MultipartFile)) {
    return context.throw(400, { expose: true, message: "No avatar" });
  }
  await context.json({ name: avatar.name, size: avatar.size });
};

app.use("/upload", new Router().post(formData, upload));
```

`multipart(options)` is the same as `new Multipart(options)`. Invalid options (e.g. an unknown option, also in `config` and `config.limits`, or a negative limit) throw a `TypeError` or a `RangeError` when the middleware is created.

It works with the body parser as a shared middleware: each one parses its own media types.

```typescript
import { BodyParser } from "@binden/body";
import { Multipart } from "@binden/multipart";

app.use(new BodyParser(), new Multipart({ storage: {} }));
```

### Limits

Nothing limits a request by default but the `fieldSize` of busboy (1 MiB), and a file in memory takes as much memory as it is large: set the limits of your application explicitly. As a starting point for production:

| Option                    | What it limits                               | Suggestion |
| ------------------------- | -------------------------------------------- | ---------- |
| `limit`                   | The whole body, in bytes, all parts included | 10 MiB     |
| `config.limits.fileSize`  | A file, in bytes                             | 5 MiB      |
| `config.limits.files`     | The count of the files                       | 10         |
| `config.limits.fields`    | The count of the fields                      | 100        |
| `config.limits.parts`     | The count of the parts (fields and files)    | 1000       |
| `config.limits.fieldSize` | A field, in bytes                            | 1 MiB      |

`Infinity` disables a limit. A request over a limit gets a `413 Content Too Large`: its body is not read further, and its connection is closed after the reply (`Connection: close`). A `Content-Length` over `limit` is refused before the body is read; a body without one is counted as it arrives.

The limits of `config.limits` are those of [busboy](https://github.com/mscdex/busboy/#api), which reports `fileSize`, `fieldSize` and `parts` once they are **reached**: a file of exactly `fileSize` bytes counts as truncated, and a form of exactly `parts` parts as over the limit. Its `fieldNameSize` and `headerPairs` apply to `application/x-www-form-urlencoded` bodies only, which this middleware does not parse: they have no effect here (the headers of a part are at most 16 KiB).

#### Truncated forms

With `throw_limits: false` a request that reaches a limit of `config.limits` is not refused: a field is truncated to `fieldSize`, a file to `fileSize` (its `truncated` is `true`), and the parts over `fields`, `files` and `parts` are dropped. `multipartInfo(context)` tells what has been truncated or dropped (it is `null` for a request that the middleware has not parsed). `limit` still refuses a larger body.

```typescript
import { type Context, Router } from "binden";
import { Multipart, multipartInfo } from "@binden/multipart";

const formData = new Multipart({
  throw_limits: false,
  limit: 1024 * 1024,
  config: { limits: { fieldSize: 16 * 1024, fields: 4, files: 4, parts: 8 } },
});

const next = async (context: Context): Promise<void> => {
  const info = multipartInfo(context);
  if (
    info !== null &&
    (info.truncated_fields.length > 0 || info.limits_hit.length > 0)
  ) {
    context.log.warn("The form has been truncated", { ...info });
  }
  await context.json({
    fields: [...(context.request.body as FormData).keys()],
  });
};

app.use("/form", new Router().post(formData, next));
```

### Storage

`storage` tells where the files go:

| `storage`            | The files                      | `request.body`                                                         |
| -------------------- | ------------------------------ | ---------------------------------------------------------------------- |
| `"memory"` (default) | In memory, as `MultipartFile`s | `FormData`                                                             |
| `{ dir }` (or `{}`)  | On the disk, as `IStoredFile`s | `{ fields: Map<string, string[]>; files: Map<string, IStoredFile[]> }` |
| `{ on_file }`        | Streamed to `on_file`          | `FormData` of the fields only                                          |

`run()` settles once the body is parsed and every file has been stored or handled.

#### Disk

Each file is written to a file of its own (`0600`, named by a random UUID, opened with `O_EXCL`) in a private directory of the request (`0700`), created under `dir` (resolved when the middleware is created) or `os.tmpdir()`. The name that the client has sent is never a path: it is the `filename` of the file.

Once the response is closed (also when the request has been refused or aborted), the files that have not been persisted are removed, with the directory. `persist(target)` keeps a file: it moves it to `target` (a hard link, or a copy where there cannot be one: another file system, or one without hard links), which must not exist: an existing file or symbolic link is an `EEXIST` error, and is never replaced. A copy writes into a new file that it creates itself (`O_EXCL`): a copy that fails removes that file, and only while `target` is still that file (the same device and inode, without following a symbolic link). A copy that cannot even read the identity of the file that it has created (its `fstat()` fails) closes it and leaves it, empty: without that identity, nothing tells it from a file that has replaced it. The directory of `target` must be trusted: nothing can make that check and the removal atomic against another process that renames files in it. Persist the files before the response is closed: a removed file cannot be persisted. Persisting a file again to the same path does nothing, to another path throws. A persisted file keeps its mode (`0600`).

The files are stored until the cleanup of the request, which starts once the response is closed. A body received before it is stored as usual (and its files removed by the cleanup, unless persisted), but a parse that goes on after it (e.g. one that has not been awaited before the reply) refuses the files that come later, as no cleanup would remove them: `run()` rejects with a `500` (`A file cannot be stored once the cleanup of the request has started`).

```typescript
import { type Context, Router } from "binden";
import { type IStoredForm, Multipart } from "@binden/multipart";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const formData = new Multipart({
  storage: { dir: "/var/tmp/uploads" },
  limit: 10 * 1024 * 1024,
  config: { limits: { fileSize: 5 * 1024 * 1024, files: 10 } },
});

const keep = async (context: Context): Promise<void> => {
  const { fields, files } = context.request.body as IStoredForm;
  const kept: string[] = [];
  for (const file of files.get("documents") ?? []) {
    // A name of the application: the name sent by the client is not trusted
    const target = join("/srv/documents", `${randomUUID()}.bin`);
    await file.persist(target);
    kept.push(target);
  }
  await context.json({ title: fields.get("title")?.[0] ?? null, kept });
};

app.use("/documents", new Router().post(formData, keep));
```

#### Stream

`on_file(file, context)` gets each file as a stream (with what it declares, and `truncated()`), e.g. to forward it to a storage service without keeping it: the memory stays bounded, whatever the size of the files. It should read the whole stream before it settles: what it has not read once it has settled is read and discarded (within the limits). Do not destroy the stream: throw a `BindenError` to refuse the request instead (destroying it fails the request). The handlers are awaited in a race with `context.signal`: a handler that never settles does not keep an aborted request, and a later rejection is observed. Each file has its handler, and they may overlap (once the stream of a file is read, the next file may start).

```typescript
import { BindenError, type Context, Router } from "binden";
import { type IStreamFile, Multipart } from "@binden/multipart";
import { createHash } from "node:crypto";

const checksums: Record<string, string> = {};

const formData = new Multipart({
  config: { limits: { fileSize: 64 * 1024 * 1024, files: 4 } },
  storage: {
    on_file: async (file: IStreamFile): Promise<void> => {
      const hash = createHash("sha256");
      for await (const chunk of file.stream) {
        hash.update(chunk as Buffer);
      }
      if (file.truncated()) {
        throw new BindenError(413);
      }
      checksums[file.field] = hash.digest("hex");
    },
  },
});

app.use(
  "/checksums",
  new Router().post(formData, (context: Context) => context.json(checksums)),
);
```

### File filter

`file_filter(info, context)` decides from what a file declares (`field`, `filename`, `mime_type`, `encoding`) whether it is accepted, before it is read. It may return a `Promise` (awaited until the request is aborted), which must resolve to a boolean: anything else is an error (`500`). A file that it refuses refuses the request with `415 Unsupported Media Type`, or is read and discarded with `filtered: "skip"`.

The filter checks only the **declared** metadata, never the content: the media type and the name of a file are chosen by the client. Check the content itself (e.g. its magic bytes) when it matters.

```typescript
import { Multipart } from "@binden/multipart";

const images = new Multipart({
  storage: {},
  file_filter: ({ field, mime_type }) =>
    field === "photo" && ["image/png", "image/jpeg"].includes(mime_type),
  filtered: "skip",
});

app.use("/photos", images);
```

### File names

The `filename` of a file is the name that the client has sent, without its control characters (also those of the direction of the text), cut to 255 bytes of UTF-8, and `"blob"` when it is empty. The parameters of the parts are decoded as UTF-8 (`config.defParamCharset`). It is metadata: never use it as a path.

### Errors

| Situation                                                      | Reply                                                                      |
| -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| A limit (`limit`, `config.limits` with `throw_limits`)         | `413 Content Too Large`                                                    |
| A malformed body, a missing or invalid `boundary`              | `400 Bad Request`                                                          |
| A file refused by `file_filter`, a field of an unknown charset | `415 Unsupported Media Type`                                               |
| A content coding other than `identity` (`Content-Encoding`)    | `415 Unsupported Media Type`                                               |
| A `BindenError` thrown by `file_filter` or `on_file`           | Its status                                                                 |
| Another failure of `file_filter`, `on_file` or the storage     | `500 Internal Server Error`                                                |
| A parse that starts once the response has finished             | `500 Internal Server Error`                                                |
| Another media type than `multipart/form-data`                  | Skipped: the body is not read                                              |
| The client goes away                                           | `run()` rejects with a `400` of code `aborted`                             |
| The deadline passes, or the server shuts down                  | `run()` rejects with the reason of `context.signal` (a `BindenAbortError`) |
| A file once the cleanup of the request has started (disk)      | `run()` rejects with a `500`                                               |

After a refusal the body is not read further, nor parsed, but the connection is kept: the client that is still sending its body receives the status (with `Connection: close`), and the connection is closed after the reply. Only a response whose headers have been sent destroys the request (its reply cannot tell the error): a send whose headers are not sent yet (e.g. of a stream that has not given its first chunk) is left to the framework, whose reply closes the connection.

After the deadline, the framework replies `503 Service Unavailable` and closes the connection (a send that has not sent its headers is cancelled first). When the server shuts down and its `timeout` passes, the connection is closed without a reply.

A parse must start before the response has finished: Node.js then reads and discards what has not been read of the body. A parse that starts later (e.g. after a middleware that has replied without `done`) refuses the body with a `500` (logged at `error`), never with an empty form.

A client that goes away is seen also when the parser is still reading once the response has finished (e.g. it was not awaited): `context.signal` is no longer aborted then, but the connection closes before the body has been received whole, and `run()` rejects with a `400` of code `aborted`. The streams of the files in progress are destroyed (a body received whole is still parsed, and with the disk storage its files are stored until the cleanup of the request).

The middleware logs with `context.log`, as `{ middleware: "Multipart" }`.
