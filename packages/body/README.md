# @binden/body [![CI Status](https://github.com/binden-js/binden/actions/workflows/ci.yml/badge.svg)](https://github.com/binden-js/binden/actions/workflows/ci.yml) [![version](https://img.shields.io/npm/v/@binden/body?style=plastic)](https://www.npmjs.com/package/@binden/body) [![Coverage Status](https://coveralls.io/repos/github/binden-js/binden/badge.svg?branch=main)](https://coveralls.io/github/binden-js/binden?branch=main) [![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://github.com/prettier/prettier) [![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](https://github.com/binden-js/binden/blob/main/CODE_OF_CONDUCT.md) [![semantic-release](https://img.shields.io/badge/semantic--release-conventional--commits-e10079.svg?logo=semantic-release)](https://github.com/semantic-release/semantic-release) [![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg)](https://conventionalcommits.org) ![node version](https://img.shields.io/node/v/@binden/body) ![npm downloads](https://img.shields.io/npm/dt/@binden/body) [![License](https://img.shields.io/npm/l/@binden/body)](https://github.com/binden-js/binden/blob/main/packages/body/LICENSE)

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
import { Binden, type Context, Router } from "binden";
import { Ajv, type JTDDataType } from "ajv/dist/jtd.js";
import { BodyParser } from "@binden/body";

const port = 8080;
const ajv = new Ajv();
const schema = {
  properties: { username: { type: "string" }, password: { type: "string" } },
  additionalProperties: false,
} as const;
const parse = ajv.compileParser<JTDDataType<typeof schema>>(schema);
const body_parser = new BodyParser({ parse });
const echo = (context: Context): Promise<void> => {
  const body = context.request.body as JTDDataType<typeof schema>;
  context.log.info("Body has been parsed (or not)", { body });
  return context.json(body);
};
new Binden()
  .use("/login", new Router().post(body_parser, echo))
  .createServer()
  .listen(port, () => {
    console.log(`Server is listening on the port ${port}`);
  });
```
