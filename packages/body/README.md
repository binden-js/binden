# @binden/body ![CI Status](https://github.com/binden-js/body/workflows/CI/badge.svg) [![version](https://img.shields.io/github/package-json/v/binden-js/body?style=plastic)](https://github.com/binden-js/body) [![Known Vulnerabilities](https://snyk.io/test/github/binden-js/body/badge.svg)](https://snyk.io/test/github/binden-js/body) [![Coverage Status](https://coveralls.io/repos/github/binden-js/body/badge.svg?branch=main)](https://coveralls.io/github/binden-js/body?branch=main) [![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://github.com/prettier/prettier) [![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](CODE_OF_CONDUCT.md) [![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release) [![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg)](https://conventionalcommits.org) ![GitHub top language](https://img.shields.io/github/languages/top/binden-js/body) ![node version](https://img.shields.io/node/v/@binden/body) ![npm downloads](https://img.shields.io/npm/dt/@binden/body) ![License](https://img.shields.io/github/license/binden-js/body)

[Binden](https://github.com/binden-js/binden) body parser middleware. Supports the following [content types](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Type)

- `application/json`
- `application/x-www-form-urlencoded`
- `plain/text`

and any combination of the following [encodings](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Encoding)

- `br`
- `x-gzip`
- `gzip`
- `deflate`

## Installation

```bash
npm install @binden/body
```

## Usage

```typescript
import BodyParser from "@binden/body";

class MyMiddleware extends Middleware {
  public run(context: Context): void {
    const { body } = context.request;
    context.log.info("Body has been parsed (or not)", { body });
  }
}

app.use("/deposit", new Router().post(BodyParser, new MyMiddleware()));
```

### Custom `parse` function

```typescript
import { Binden } from "binden";
import AJV, { JTDDataType } from "ajv/dist/jtd.js";
import BodyParser from "@binden/body";
const ajv = new AJV();
const schema = {
  properties: { username: { type: "string" }, password: { type: "string" } },
  additionalProperties: false,
};
const parse = ajv.compileParser<JTDDataType<typeof schema>>(schema);
const body_parser = new BodyParser({ parse });
const echo = (context) => {
  const { body } = context.request;
  context.log.info("Body has been parsed (or not)", { body });
  return context.json(body);
};
new Binden()
  .use("/login", new Router().post(BodyParser, echo))
  .createServer()
  .listen(port, () => {
    console.log(`Server is listening on the port ${port}`);
  });
```

### Test

```bash
npm test
```
