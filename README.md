# Binden ![CI Status](https://github.com/binden-js/binden/workflows/CI/badge.svg) [![version](https://img.shields.io/github/package-json/v/binden-js/binden?style=plastic)](https://github.com/binden-js/binden) [![Known Vulnerabilities](https://snyk.io/test/github/binden-js/binden/badge.svg)](https://snyk.io/test/github/binden-js/binden) [![Coverage Status](https://coveralls.io/repos/github/binden-js/binden/badge.svg?branch=main)](https://coveralls.io/github/binden-js/binden?branch=main) [![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://github.com/prettier/prettier) [![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](CODE_OF_CONDUCT.md) [![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release) [![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg)](https://conventionalcommits.org) ![GitHub top language](https://img.shields.io/github/languages/top/binden-js/binden) ![node version](https://img.shields.io/node/v/binden) ![npm downloads](https://img.shields.io/npm/dt/binden) ![License](https://img.shields.io/github/license/binden-js/binden)

A simple server framework (written in [TypeScript](https://www.typescriptlang.org/)).

## Installation

```bash
npm install binden
```

## Usage

### Binden

- `.use()` - Add a `Middleware/Router` to the stack

```typescript
import { Binden } from "binden";

const app = new Binden().use(middleware1).use(router2);
app.use("/path", middleware2, router2);
app.use(new RegExp("path"), router3, middleware1);
const middleware3 = (context) => context.json({ message: "Hello World!" });
app.use("/path2", middleware3);
```

- `.off()` - remove a `Middleware/Router` form the stack

```typescript
import { Binden } from "binden";

const app = new Binden()
  .use("/path", middleware1)
  .use(middleware2)
  .off("/path", middleware1);
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

### Context

- `.log` - get the logger (see [`@binden/logger`](https://github.com/binden-js/logger))

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

- `.done`

```typescript
class MyMiddleware extends Middleware {
  public run(context: Context): void {
    context.done = true; // Stop passing the `context` to other middlewares
  }
}
```

or with a function

```typescript
const MyMiddleware = (context): void => {
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

A custom `stringify` function (e.g. [fast-json-stringify](https://github.com/fastify/fast-json-stringify-stringify)) can pan passed as the second argument.

```typescript
const json = { currency: "💶", value: 120 };
const fastJSON = await import("fast-json-stringify");
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
    const randomNumber = await new Promise((resolve, reject) => {
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

export class MyMiddleware2 extends Middleware {
  public async run(): Promise<void> {
    // Disable `mm1` every hour
    setInterval(
      () => {
        mm1.disabled = !mm1.disabled;
      },
      1000 * 60 * 60,
    );
  }
}
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

export class MyMiddleware2 extends Middleware {
  public async run(): Promise<void> {
    // Throw errors from `mm1.run()` every minute
    setInterval(() => {
      mm1.ignore_errors = !mm1.ignore_errors;
    }, 1000 * 60);
  }
}
```

### BindenError

`BindenError` represents an HTTP error

```typescript
import { Middleware, Context, BindenError } from "binden";

export class MyMiddleware extends Middleware {
  public run(context: Context): Promise<void> {
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
server = createServer({ IncomingMessage: BindenRequest });
```

- `.header()` - get a header by name

```typescript
const rawHeader = request.header("X-Header");
```

- `.id` - get the request id

```typescript
const { id } = request;
```

- `.protocol` - respects the [Forwarded](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Forwarded) header:

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

- `.query` - A copy of `URL.search` parsed by the `querystring.parse()` method

```typescript
const { query } = request;
// same as
const query = { ...parse(this.URL.search.substring(1)) };
```

### BindenResponse

Simple usage with `http`

```typescript
import { createServer } from "http";
import { BindenResponse } from "binden";
server = createServer({ ServerResponse: BindenResponse });
```

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

- `.status()` - Set the status code of the response

```typescript
await response.status(400).send();
```

- `.set()` - Set the headers

```typescript
const headers = {
  "X-AMOUNT": "100.02 USD",
  "X-MONTHS": ["jan", "feb"],
};
await response.status(402).set(headers).send("Payment is required");
```

- `.send()` - send data

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
const fastJSON = await import("fast-json-stringify");
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
await response.json(json);
```

- `.text()` - send text as `plain/text`

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
const form = new URLSearchParams({ a: "1", b: ["a", "c"] });
await response.form(form);
```

- `.sendFile()` - Send a file. Respects the following headers

  - [If-Modified-Since](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-Modified-Since)

  - [Range](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Range)

  - [If-Range](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-Range)

```typescript
const path = "<path to file>";
await response.sendFile(path);
// Or with custom Stats
import { stat } from "node:fs/promises";
const stats = await stat("<PATH>");
await response.sendFile(path, stats);
```

### Headers

- [Accept-Encoding](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Accept-Encoding)

```typescript
import { AcceptEncoding } from "binden";

const encodings = AcceptEncoding.fromString(request.headers["accept-encoding"]);
// or using BindenRequest
const { accept_encoding } = request;
```

- [Authorization](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Authorization)

```typescript
import { Authorization } from "binden";

const authorization = AcceptEncoding.fromString(
  request.headers["Authorization"],
);
// or using BindenRequest
const { authorization } = request;
```

- [Content-Encoding](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Encoding)

```typescript
import { ContentEncoding } from "binden";

const encodings = ContentEncoding.fromString(
  request.headers["content-encoding"],
);
// or using BindenRequest
const { content_encoding } = request;
```

- [Content-Range](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Range)

```typescript
import { ContentRange } from "binden";

const cr = new ContentRange({ start: 0, end: 499, size: 1000 });
response.setHeader("Content-Range", cr.toString());
```

- [Content-Type](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Type)

```typescript
import { ContentType } from "binden";

const type = ContentType.fromString(request.headers["content-type"]);
// or using BindenRequest
const { content_type } = request;
```

- [Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cookie)

```typescript
import { Cookie } from "binden";

const cookies = Cookie.fromString(request.headers["cookie"]);
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

- [Forwarded](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Forwarded)

```typescript
import { Forwarded } from "binden";

const forwarded = Forwarded.fromString(request.headers["forwarded"]);
// or using BindenRequest
const { forwarded } = request;
```

- [If-Modified-Since](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-Modified-Since)

```typescript
import { IfModifiedSince } from "binden";

const if_modified_since = IfModifiedSince.fromString(
  request.headers["if-modified-since"],
);
// or using BindenRequest
const { if_modified_since } = request;
```

- [Range](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Range)

```typescript
import { Range } from "binden";

const range = Range.fromString(request.headers.range);
// or using BindenRequest
const { range } = request;
```

### Test

```bash
npm run test:ci
```
