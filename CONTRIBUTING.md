# Contributing

Thank you for helping with binden. This repository holds `binden` and its official packages
(`@binden/logger`, `@binden/body`, `@binden/compression` and `@binden/multipart`), released
together with one version.

## Before you start

- Report a bug or propose a feature with an [issue](https://github.com/binden-js/binden/issues/new/choose).
  For a significant change, open an issue first, so that the problem and the solution can be
  discussed before the work starts.
- Never report a vulnerability in a public issue: see the [security policy](SECURITY.md).
- Everyone who takes part follows the [code of conduct](CODE_OF_CONDUCT.md).

## Set-up

The repository needs Node.js `>=24.14.1` and npm `>=11.11.0` (CI tests Node.js 24.14.1, the latest
24 and 26, on Linux, Windows and macOS).

```bash
git clone https://github.com/binden-js/binden.git
cd binden
npm ci # installs and builds every workspace, and sets up the Git hooks
```

The [README](README.md#development) lists the commands. The packages use each other through their
compiled `dist/`: run `npm run build` after changing a package that others depend on (`binden`
depends on `@binden/logger`, and the middlewares on `binden`).

## Changes

- **Tests.** Every change of behaviour comes with a test (`node:test`, in the `test/` directory of
  the package) that fails without it. The coverage stays at 100% of the lines, branches, functions
  and statements of every package (`npm run coverage`). A test is bounded (e.g. with
  `AbortSignal.timeout()`): a hang must fail, not block the runner.
- **Types.** The code is strict TypeScript (with `exactOptionalPropertyTypes`: an option is declared
  as `name?: T | undefined`). Every exported symbol has a JSDoc comment, which the
  [API documentation](https://binden-js.github.io/binden/) shows (`npm run docs:build` fails on a
  warning).
- **Options.** A public option is validated when it is given: an invalid one throws a `TypeError`
  (or a `RangeError` for a value out of its range) in the constructor.
- **Documentation.** A change of the API or of a behaviour updates the README of its package. The
  TypeScript examples of the READMEs are type checked (`npm run consumer:check`).
- **Style.** ESLint and Prettier check the code (`npm run eslint`, `npm run prettier`); the
  pre-commit hook fixes the staged files.
- **Published files.** `npm run pack:check` compares the files of every package with
  [`scripts/pack-files.json`](scripts/pack-files.json) (`node scripts/pack-check.mjs --update`
  rewrites it) and refuses tests, secrets and source maps with local paths. It copies
  `MIGRATION-4.md` and `PRODUCTION.md` into `packages/binden` first: `binden` publishes them.

Before opening a pull request, run everything that CI runs:

```bash
npm run ci:all
```

## Commits

The commits follow [Conventional Commits](https://conventionalcommits.org), checked by commitlint
(the commit hook and CI): they make the next version and its release notes.

- The type is one of `feat` (a minor release), `fix`, `perf`, `revert`, `build`, `dependencies` and
  `peerDependencies` (a patch release), or `docs`, `test`, `refactor`, `style`, `ci`, `chore`,
  `devDependencies` and `metadata` (no release). See [`commitlint.config.js`](commitlint.config.js).
- The subject says what changes, and names the package that it concerns, e.g.
  `fix: parse Accept-Encoding codings case-insensitively in binden`.
- The body explains why, in lines of at most 100 characters.
- A breaking change has a `!` after the type and a `BREAKING CHANGE:` footer that tells the users
  what they must change: it is a major release, and its footer goes to the release notes.

Each commit is one logical change, and builds and passes the tests on its own.

## Pull requests

- Fill in the template, and link the issue that the pull request resolves.
- CI must pass (the required checks of `main`, see
  [Repository settings](README.md#repository-settings)): the lint job (formatting, commits, ESLint,
  the tooling tests, the acceptance scenarios and the docs), the package job (the release
  rehearsal on the runtime of the releases, the packed files and the consumer check), the tests on
  every supported Node.js, on Windows and macOS, CodeQL and the dependency review.
- A maintainer ([`CODEOWNERS`](.github/CODEOWNERS)) reviews every pull request.

Merging into `main` releases the packages: see [Releases](README.md#releases).
