# binden [![CI Status](https://github.com/binden-js/binden/actions/workflows/ci.yml/badge.svg)](https://github.com/binden-js/binden/actions/workflows/ci.yml) [![Coverage Status](https://coveralls.io/repos/github/binden-js/binden/badge.svg?branch=main)](https://coveralls.io/github/binden-js/binden?branch=main) [![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://github.com/prettier/prettier) [![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](https://github.com/binden-js/binden/blob/main/CODE_OF_CONDUCT.md) [![semantic-release](https://img.shields.io/badge/semantic--release-conventional--commits-e10079.svg?logo=semantic-release)](https://github.com/semantic-release/semantic-release) [![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg)](https://conventionalcommits.org)

A simple HTTP server framework and its official packages. All packages live in this repository as
[npm workspaces](https://docs.npmjs.com/cli/using-npm/workspaces) and are released together with
the same version.

| Package                                       | Description                             | License |
| --------------------------------------------- | --------------------------------------- | ------- |
| [`binden`](packages/binden)                   | A simple HTTP server framework          | MIT     |
| [`@binden/logger`](packages/logger)           | A simple logger (based on `pino`)       | MIT     |
| [`@binden/body`](packages/body)               | Body parser middleware                  | MIT     |
| [`@binden/compression`](packages/compression) | Compression middleware                  | MIT     |
| [`@binden/multipart`](packages/multipart)     | `multipart/form-data` parser middleware | MIT     |

API documentation: <https://binden-js.github.io/binden/>

## Development

Requires Node.js `>=24.15.0` and npm `>=11.11.0`.

```bash
npm install            # installs all workspaces and builds them (`prepare`)
npm run build          # type checks and compiles every workspace (including tests)
npm test               # node:test (via tsx) in every workspace
npm run coverage       # tests with c8 coverage (coverage/lcov.info)
npm run eslint         # type-aware ESLint for the whole repository
npm run docs:build     # TypeDoc for all packages (docs/)
npm run consumer:check # the packed packages and the README examples in a fresh project
npm run ci:all         # everything CI runs
```

Commands for a single package: `npm test -w packages/binden`.

Packages consume each other through the compiled `dist/` (`@binden/body`, `@binden/compression` and
`@binden/multipart` import `binden`, which imports `@binden/logger`): run `npm run build` after
changing a package that others depend on.

## Dependencies

Dependencies are kept at their latest versions, except:

- **TypeScript 7.** The repository is built with TypeScript 6: typescript-eslint and TypeDoc support
  TypeScript up to 6.0 and need the JavaScript API of the compiler, which the native TypeScript 7
  does not provide yet. The packages work with TypeScript 7: `npm run consumer:check` type checks
  the packed packages and the README examples with it too.
- **`@types/node` 26.** The type definitions follow the oldest supported Node.js (24), so that an API
  added later cannot be used by accident (the tests run on Node.js 24 and 26).
- **`conventional-changelog-conventionalcommits` 10.** semantic-release 25 generates the release
  notes with `conventional-changelog-writer` 8, and the version 10 of the preset requires the
  version 9 of the writer (the release fails).

The published packages have no known vulnerabilities (`npm audit --omit=dev`). The advisories of the
development dependencies come from the release tooling: `braces` (through `micromatch`, used by
semantic-release) has no fixed version, and the other ones are bundled with npm 11.21.0, the latest
version that `@semantic-release/npm` supports (bundled dependencies cannot be updated separately).
They do not affect the published packages.

## Known issues

- With `@types/node` 26 and `skipLibCheck: false`, TypeScript reports
  `Namespace "worker_threads" has no exported member "TransferListItem"` in the types of
  [`thread-stream`](https://github.com/pinojs/thread-stream), which `pino` (used by
  `@binden/logger`) depends on. Enable `skipLibCheck` until `thread-stream` is updated
  ([pinojs/thread-stream#228](https://github.com/pinojs/thread-stream/issues/228)).
  `npm run consumer:check` type checks the packed packages with `@types/node` 24 (strict) and 26
  (with `skipLibCheck`).

## Releases

Releases are fully automated by [semantic-release](https://github.com/semantic-release/semantic-release)
on every push to `main` (see [`.releaserc.json`](.releaserc.json)):

- the next version is derived from [Conventional Commits](https://conventionalcommits.org) since the
  last `v*` tag;
- [`scripts/release.mjs`](scripts/release.mjs) sets that version in **every** workspace (and the
  internal dependency ranges to `^<version>`) and publishes all packages to npm in dependency order;
- the `v<version>` tag and a [GitHub Release](https://github.com/binden-js/binden/releases) with the
  release notes are created: they are the changelog (see [`CHANGELOG.md`](CHANGELOG.md)).

Nothing is committed back to `main`, as
[recommended by semantic-release](https://semantic-release.gitbook.io/semantic-release/support/faq):
a release commit would have to bypass the branch protection of `main`. The versions in the
repository therefore stay at `0.0.0-development` (and the internal ranges at `^0.0.0-development`);
the published version is set only in the checkout of the release job.

`npm run release:check` verifies that all workspaces share one version. If a release fails after
some packages were published, run `node scripts/release.mjs version <version>` and then
`node scripts/release.mjs publish --skip-existing` (without committing the result) to publish the
rest.

The `CHANGELOG.md` files inside `packages/*` describe the history before the packages were merged
into this repository.
