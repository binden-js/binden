# @binden/logger [![CI Status](https://github.com/binden-js/binden/actions/workflows/ci.yml/badge.svg)](https://github.com/binden-js/binden/actions/workflows/ci.yml) [![version](https://img.shields.io/npm/v/@binden/logger?style=plastic)](https://www.npmjs.com/package/@binden/logger) [![Coverage Status](https://coveralls.io/repos/github/binden-js/binden/badge.svg?branch=main)](https://coveralls.io/github/binden-js/binden?branch=main) [![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://github.com/prettier/prettier) [![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](https://github.com/binden-js/binden/blob/main/CODE_OF_CONDUCT.md) [![semantic-release](https://img.shields.io/badge/semantic--release-conventional--commits-e10079.svg?logo=semantic-release)](https://github.com/semantic-release/semantic-release) [![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg)](https://conventionalcommits.org) ![node version](https://img.shields.io/node/v/@binden/logger) ![npm downloads](https://img.shields.io/npm/dt/@binden/logger) [![License](https://img.shields.io/npm/l/@binden/logger)](https://github.com/binden-js/binden/blob/main/packages/logger/LICENSE)

A simple logger (based on [`pino`](https://github.com/pinojs/pino)).

By default, the logging level is equal to the value of the `BINDEN_LOG_LEVEL` environmental variable.

```bash
BINDEN_LOG_LEVEL=trace
```

## Installation

```bash
npm install @binden/logger
```

## Usage

```javascript
import { Logger } from "@binden/logger";
const logger = new Logger({ level: Logger.getLevel("OTHER_ENV_NAME") });
```

or using the default import

```javascript
import log from "@binden/logger";
```

- `.fatal()`

```javascript
log.fatal("Bad error. Exiting...", { id: 1, someinfo: { a: 2 } });
```

- `.error()`

```javascript
try {
  doSomething();
} catch (error) {
  log.error("Something bad happened in the `doSomething`", { error });
}
```

- `.warn()`

```javascript
if (connection) {
  workWithConnection();
} else {
  log.warn("The connection has not been established", { reason });
}
```

- `.info()`

```javascript
server.on("listening", (port) => {
  log.info(`The server is listening`, { port });
});
```

- `.debug()`

```javascript
websocket.on("message", (message) => {
  log.debug("Received a message", { message });
});
```

- `.trace()`

```javascript
log.trace("Array length", { length: arr.length });
```
