# @binden/logger [![CI Status](https://github.com/binden-js/binden/actions/workflows/ci.yml/badge.svg)](https://github.com/binden-js/binden/actions/workflows/ci.yml) [![version](https://img.shields.io/npm/v/@binden/logger?style=plastic)](https://www.npmjs.com/package/@binden/logger) [![Coverage Status](https://coveralls.io/repos/github/binden-js/binden/badge.svg?branch=main)](https://coveralls.io/github/binden-js/binden?branch=main) [![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://github.com/prettier/prettier) [![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](https://github.com/binden-js/binden/blob/main/CODE_OF_CONDUCT.md) [![semantic-release](https://img.shields.io/badge/semantic--release-conventional--commits-e10079.svg?logo=semantic-release)](https://github.com/semantic-release/semantic-release) [![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg)](https://conventionalcommits.org) ![node version](https://img.shields.io/node/v/@binden/logger) ![npm downloads](https://img.shields.io/npm/dt/@binden/logger) [![License](https://img.shields.io/npm/l/@binden/logger)](https://github.com/binden-js/binden/blob/main/packages/logger/LICENSE)

A simple logger (based on [`pino`](https://github.com/pinojs/pino)), with default serializers that keep the input of the requests out of the logs.

## Installation

```bash
npm install @binden/logger
```

## Usage

```typescript
import { Logger } from "@binden/logger";

const logger = new Logger({ level: "info" });
logger.info("The server is listening", { port: 8080 });
```

or the default logger, whose level is the value of the `BINDEN_LOG_LEVEL` environment variable (`trace`, `debug`, `info`, `warn`, `error` or `fatal`; `silent` without it). It is created when it is first used: importing the package has no side effect, and the variable is read then.

```bash
BINDEN_LOG_LEVEL=debug node server.js
```

```typescript
import log from "@binden/logger";

log.debug("Received a message", { size: 42 });
```

### Options

`new Logger(options)` takes the options of [`pino`](https://getpino.io/#/docs/api?id=options) (e.g. `level`, `redact`, `serializers`), and:

| Option          | Default                                  | Description                                                                                                                                    |
| --------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `level`         | `Logger.getLevel()` (`BINDEN_LOG_LEVEL`) | The level of the logger: one of `pino`, a custom one (`customLevels`) or `silent` (another one throws a `TypeError`)                           |
| `destination`   | `stdout`                                 | Where the records are written (a `pino` destination, or any object with a `write()` method)                                                    |
| `logger`        | none                                     | An existing `pino` logger to write with, as it is (its own options and serializers apply): every other option set with it throws a `TypeError` |
| `error_details` | `false`                                  | Whether the default `error` serializer adds the message, the stack and any `code` of an error                                                  |
| `serializers`   | the default ones                         | Serializers by key: they replace the default ones of the same keys only                                                                        |

Options that are not an object (or `undefined`) throw a `TypeError` ("`options` is not an object: …"), and what reading them throws (e.g. a revoked proxy) is formatted, as by every entry point of binden. A level that is not a string (of the options, of `.level` and of `.child()`) is refused without being converted ("Unknown level: …"). Each option is read once, also the nested ones that `pino` reads several times or keeps: each level of `customLevels` (also of a function that carries them), the `hooks`, the options of `redact` and its paths, and the targets and steps of `transport` (also functions). `new Logger()` copies them as `pino` reads them, checks the copy and gives it to `pino`. For example, it copies the inherited `level` of a target only when the target has a pipeline, whose steps `pino` gives it, and the `writable`, `_writableState`, `targets` and prototype of `transport` (also inherited), by which `pino` refuses a stream given as `transport` and a `level` formatter with `targets`, as 2.0.3 did. A level of `customLevels` that is not a number and a path of `redact` that is not a string throw a `TypeError` ("`customLevels` has a level that is not a number: …", "`redact` has a path that is not a string: …"). Both are checked by their types before `pino` would convert them (it would write the records of a level given as an object with `valueOf()` with `"level": null`).

`Logger.getLevel(name)` reads a level from another environment variable (a name that is not a string throws a `TypeError` without being converted):

```typescript
import { Logger } from "@binden/logger";

const logger = new Logger({ level: Logger.getLevel("OTHER_ENV_NAME") });
```

### Serializers

The default serializers log an allowlist of details, found by duck typing (the logger does not depend on `binden`). A value of another kind under these keys is reduced to its type (e.g. `{ "type": "object" }`): it is never logged whole.

- `error`: the type of the error (its nearest built-in error class, never a name the error defines), its `code` when it is a system error code (such as `ECONNRESET`) or one of a few stream and HTTP codes (such as `ERR_STREAM_PREMATURE_CLOSE`), and its `status` (an integer from 100 to 599). Its message, stack and any other `code` may quote the input: they are added only with `error_details: true`. It never throws, whatever is thrown;
- `err`: the same as `error`, for the key under which `pino` logs an `Error` given as the fields of a record (e.g. `logger.error("Failed", error)`), which it would log whole otherwise (its message, stack and every property);
- `request`: its method and its path (without the query string and the fragment, nor the scheme, the authority and the userinfo of an absolute-form target);
- `response`: its status (`statusCode`).

```typescript
import { Logger, serializers } from "@binden/logger";

// The details of the errors, and the bodies, in development only
const logger = new Logger({
  level: "debug",
  error_details: process.env.NODE_ENV === "development",
  serializers: { body: (body: unknown): unknown => body },
});
logger.debug("The default serializers", {
  serializers: Object.keys(serializers),
});
```

### Methods

- `.fatal()`, `.error()`, `.warn()`, `.info()`, `.debug()`, `.trace()` - write a record with a message and optional fields

```typescript
import log from "@binden/logger";

try {
  JSON.parse("{");
} catch (error) {
  log.error("Something bad happened", { error });
}
```

- `.child(bindings, { level })` - a logger that adds `bindings` to every record, with its own level if given (an unknown level throws a `TypeError`)

```typescript
import log from "@binden/logger";

const child = log.child({ module: "cache" }, { level: "debug" });
child.debug("Cache miss", { key: "user:1" });
```

- `.level` - the level of the logger (it can be changed: an unknown level throws a `TypeError`), and `.isLevelEnabled(level)` - whether the records of a level are written (`false` for a level that is not a string)

```typescript
import log from "@binden/logger";

if (log.isLevelEnabled("debug")) {
  log.debug("An expensive record", {
    details: JSON.stringify(process.memoryUsage()),
  });
}
log.level = "warn";
```

- `.flush()` - write the buffered records (e.g. of an asynchronous destination) before the process exits

```typescript
import log from "@binden/logger";

await log.flush();
```

- `Logger.fromPino(logger)` - a logger that writes with an existing `pino` logger (e.g. `Logger.fromPino(pino({ level: "info" }))`), whose own options and serializers apply

`ILogger` is the interface that `binden` needs (the six methods and `child()`): any other logger that has them can be used.
