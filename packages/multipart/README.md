# @binden/multipart [![CI Status](https://github.com/binden-js/binden/actions/workflows/ci.yml/badge.svg)](https://github.com/binden-js/binden/actions/workflows/ci.yml) [![version](https://img.shields.io/npm/v/@binden/multipart?style=plastic)](https://www.npmjs.com/package/@binden/multipart) [![Coverage Status](https://coveralls.io/repos/github/binden-js/binden/badge.svg?branch=main)](https://coveralls.io/github/binden-js/binden?branch=main) [![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://github.com/prettier/prettier) [![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](https://github.com/binden-js/binden/blob/main/CODE_OF_CONDUCT.md) [![semantic-release](https://img.shields.io/badge/semantic--release-conventional--commits-e10079.svg?logo=semantic-release)](https://github.com/semantic-release/semantic-release) [![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg)](https://conventionalcommits.org) ![node version](https://img.shields.io/node/v/@binden/multipart) ![npm downloads](https://img.shields.io/npm/dt/@binden/multipart) [![License](https://img.shields.io/npm/l/@binden/multipart)](https://github.com/binden-js/binden/blob/main/packages/multipart/LICENSE)

[Binden](https://github.com/binden-js/binden) `multipart/form-data` parser middleware (based on [busboy](https://github.com/mscdex/busboy)).

## Installation

```bash
npm install @binden/multipart
```

## Usage

```typescript
import { type Context, Router } from "binden";
import multipart from "@binden/multipart";

const formDataParser = multipart({ limits: { fields: 2, fileSize: 1024 } });

const next = (context: Context): Promise<void> => {
  if (context.request.body instanceof FormData) {
    context.log.info("Body has been parsed successfully");
    return context.status(200).text("GOOD");
  } else {
    context.log.warn("Body is not a valid `form-data`");
    return context.status(400).text("BAD");
  }
};

app.use("/formdata", new Router().post(formDataParser, next));
```

### Truncated `FormData`

Set the `throw_limits` to `false` to avoid throwing errors. `FormData` might be truncated due to `config.limits` (See `busboy` [limits](https://github.com/mscdex/busboy/#api))

```typescript
import { type Context, Router } from "binden";
import { Multipart } from "@binden/multipart";

const formDataParser = new Multipart({
  throw_limits: false,
  config: {
    limits: {
      fieldNameSize: 5,
      fieldSize: 16 * 1024,
      fields: 4,
      fileSize: 128 * 1024,
      files: 4,
      parts: 6,
    },
  },
});

const next = (context: Context): Promise<void> => {
  if (context.request.body instanceof FormData) {
    context.log.info("Fields and files might have been truncated");
    return context.status(200).text("MAYBE GOOD");
  } else {
    context.log.warn("Body is not a valid `form-data`");
    return context.status(400).text("BAD");
  }
};

app.use("/formdata", new Router().post(formDataParser, next));
```
