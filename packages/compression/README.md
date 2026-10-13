# @binden/compression [![CI Status](https://github.com/binden-js/binden/actions/workflows/ci.yml/badge.svg)](https://github.com/binden-js/binden/actions/workflows/ci.yml) [![version](https://img.shields.io/npm/v/@binden/compression?style=plastic)](https://www.npmjs.com/package/@binden/compression) [![Coverage Status](https://coveralls.io/repos/github/binden-js/binden/badge.svg?branch=main)](https://coveralls.io/github/binden-js/binden?branch=main) [![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://github.com/prettier/prettier) [![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](https://github.com/binden-js/binden/blob/main/CODE_OF_CONDUCT.md) [![semantic-release](https://img.shields.io/badge/semantic--release-conventional--commits-e10079.svg?logo=semantic-release)](https://github.com/semantic-release/semantic-release) [![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg)](https://conventionalcommits.org) ![node version](https://img.shields.io/node/v/@binden/compression) ![npm downloads](https://img.shields.io/npm/dt/@binden/compression) [![License](https://img.shields.io/npm/l/@binden/compression)](https://github.com/binden-js/binden/blob/main/packages/compression/LICENSE)

[Binden](https://github.com/binden-js/binden) compression middleware (supports `br`, `gzip` and `deflate`).

## Installation

```bash
npm install @binden/compression
```

## Usage

```typescript
import Compression from "@binden/compression";

app.use(Compression);
```
