# @binden/multipart ![CI Status](https://github.com/binden-js/multipart/workflows/CI/badge.svg) [![version](https://img.shields.io/github/package-json/v/binden-js/multipart?style=plastic)](https://github.com/binden-js/multipart) [![Known Vulnerabilities](https://snyk.io/test/github/binden-js/multipart/badge.svg)](https://snyk.io/test/github/binden-js/multipart) [![Coverage Status](https://coveralls.io/repos/github/binden-js/multipart/badge.svg?branch=main)](https://coveralls.io/github/binden-js/multipart?branch=main) [![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://github.com/prettier/prettier) [![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](CODE_OF_CONDUCT.md) [![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release) [![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg)](https://conventionalcommits.org) ![GitHub top language](https://img.shields.io/github/languages/top/binden-js/multipart) ![node version](https://img.shields.io/node/v/@binden/multipart) ![npm downloads](https://img.shields.io/npm/dt/@binden/multipart) ![License](https://img.shields.io/github/license/binden-js/multipart)

[Binden](https://github.com/binden-js/binden) `multipart/form-data` parser middleware (based on [busboy](https://github.com/mscdex/busboy)).

## Installation

```bash
npm install @binden/multipart
```

## Usage

```typescript
import multipart from "@binden/multipart";

const formDataParser = multipart({ limits: { fields: 2, fileSize: 1024 } });

const next = (context) => {
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

const next = (context) => {
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

### Test

```bash
npm test
```
