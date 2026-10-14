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

Requires Node.js `>=24.14.1` and npm `>=11.11.0`, as the packages do.

```bash
npm install               # installs all workspaces and builds them (`prepare`)
npm run build             # type checks and compiles every workspace (including tests)
npm test                  # node:test (via tsx) in every workspace
npm run coverage          # tests with c8 coverage (coverage/lcov.info)
npm run eslint            # type-aware ESLint for the whole repository
npm run test:tooling      # the tests of the release scripts and the tooling (scripts/*.test.mjs)
npm run docs:build        # TypeDoc for all packages (docs/)
npm run pack:check        # the files that every package publishes (scripts/pack-files.json)
npm run consumer:check    # the packed packages and the README examples in a fresh project
npm run release:rehearsal # the next version, its release notes and its archives, without releasing
npm run ci:all            # everything CI runs
```

Commands for a single package: `npm test -w packages/binden`.

`npm run pack:check` and `npm run consumer:check` pack the workspaces of the working tree. CI checks
the archives of the release rehearsal instead, the way the release job makes them (from the
commit, with the next version and its `gitHead`), without packing them again:

```bash
npm run release:rehearsal -- <dir>                 # keeps the archives and their manifest in <dir>
node scripts/pack-check.mjs --tarballs <dir>
node scripts/consumer-check.mjs --tarballs <dir>
```

`npm run consumer:check` runs a consumer of the packed packages against a real server, but only
type checks the TypeScript examples of the READMEs: the placeholders that they use (`app`,
`context`, …) are declared, and their behaviour is not tested.

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

Dependabot does not propose these versions (TypeScript 7 and later, `@types/node` 25 and later, and
the preset 10 and later: see `ignore` in [`.github/dependabot.yml`](.github/dependabot.yml)).

### Audit

CI checks the registry signatures (and provenance attestations) of every installed package
(`npm audit signatures`), and fails on any advisory of high severity or above in the dependencies
of the published packages (`npm audit --omit=dev --audit-level=high`): there is none.

The full `npm audit` (2026-10-14) reports 13 vulnerable packages (2 moderate, 11 high). All of them
are development dependencies of the release tooling, none is in the published packages, and each
one is accepted:

- `braces` 3.0.3 (high:
  [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)) has no fixed version.
  Through `micromatch` 4.0.8, semantic-release and its commit analyzer only expand the patterns of
  `.releaserc.json` (the release branch and the release rules), never a pattern from outside of the
  repository, and the advisory needs a deeply nested pattern.
- The other ones are bundled with `npm` 11.21.0, which is never run: `brace-expansion` 5.0.9 (high:
  GHSA-q2hr-2g5m-vwhr, GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p), `http-cache-semantics` 4.2.0
  (high: GHSA-ch52-4w7c-c8xp), `undici` 6.28.0 (high: GHSA-3wwx-pv8p-q78v, GHSA-r53p-7pc4-xj5r,
  GHSA-rfgv-xxqx-mfg5), `ip-address` 10.5.0 (moderate: GHSA-rpw4-54j3-4h4q, GHSA-2vr4-cq9g-pvrc,
  GHSA-j6r3-76f7-8jcv, GHSA-h3mg-xc3c-68pw) and `postcss-selector-parser` 7.1.4 (moderate:
  GHSA-rj75-hqrm-r3gf). `npm` is a dependency of `@semantic-release/npm`, which semantic-release
  always installs; 11.21.0 is the latest npm 11, the version that `@semantic-release/npm` supports,
  and the bundled dependencies of npm cannot be updated separately. This repository does not use
  the `@semantic-release/npm` plugin: the release publishes with the npm of its runtime (11.13.0,
  with Node.js 24.16.0).
- The 7 other packages (`micromatch`, `semantic-release`, `@semantic-release/exec`,
  `@semantic-release/commit-analyzer`, `@semantic-release/release-notes-generator`,
  `@semantic-release/github` and `@semantic-release/npm`) are reported only because they depend on
  `braces` or on `npm`.

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
on every push to `main` (see [`.releaserc.json`](.releaserc.json)), in the `release` job of the CI
workflow. The job runs in the `release` environment (the one that the npm trusted publisher of the
packages expects), one publication at a time (with the `recover` job), on Node.js 24.16.0 with its
npm 11.13.0 (both checked): the `recover` job uses the same runtime, so that both pack the same
archives, bit for bit, from the same commit.

1. the next version is derived from [Conventional Commits](https://conventionalcommits.org) since
   the last `v*` tag, and [`scripts/release.mjs`](scripts/release.mjs) `verify` checks that no
   workspace is published at it yet (only a 404 of the registry means "not published": any other
   error stops the release);
2. `scripts/release.mjs version` sets that version in **every** workspace (and the internal
   dependency ranges to `^<version>`), with the commit as `gitHead`;
3. `scripts/release.mjs pack` packs every workspace once, checks the name, the version, the
   `gitHead` and the files ([`scripts/pack-files.json`](scripts/pack-files.json)) inside each
   archive, and lists the archives (name, version, commit, `sha512` integrity, file) in
   `release-manifest.json`;
4. the `v<version>` tag is pushed;
5. `scripts/release.mjs publish` checks the integrity and the content of the archives, then the
   registry for **all** the packages, and only then publishes these archives
   (`npm publish <tgz>`, with provenance) in dependency order;
6. a [GitHub Release](https://github.com/binden-js/binden/releases) with the release notes is
   created: they are the changelog (see [`CHANGELOG.md`](CHANGELOG.md)).

Nothing is committed back to `main`, as
[recommended by semantic-release](https://semantic-release.gitbook.io/semantic-release/support/faq):
a release commit would have to bypass the branch protection of `main`. The versions in the
repository therefore stay at `0.0.0-development` (and the internal ranges at `^0.0.0-development`);
the published version is set only in the checkout of the release job. Versions are strict
[SemVer 2.0.0](https://semver.org) without build metadata (which npm drops).

`npm run release:check` verifies that all workspaces share one version. Every pull request rehearses
the release (`npm run release:rehearsal`): semantic-release computes the next version and its notes
in a clone, where `scripts/release.mjs` runs `verify`, `version`, `pack` and `publish --dry-run`
(the registry check and `npm publish --dry-run` of every archive). Nothing is tagged or published.

### Recovering a release

When a release fails after its tag was pushed (for example, some packages were published, but not
all of them), the next release would start after that tag: recover it instead, by running the CI
workflow manually (Actions → CI → Run workflow) with its version. The `recover` job:

1. runs nothing of the repository (not even `npm ci`) before it has checked that the version is a
   SemVer version, that its tag exists, and that the commit of the tag is on `main`;
2. checks out that commit, and packs the archives again with `scripts/release.mjs version` and
   `pack` (the same archives as the release job);
3. publishes with `scripts/release.mjs publish --skip-existing`: the registry is checked for all the
   packages first, a version that is already published is skipped only when it is the same archive
   (its `gitHead` and `dist.integrity` on npm), and any other difference, or any registry error
   other than a 404, publishes nothing. The missing packages are published with provenance;
4. creates the GitHub Release when the GitHub API answers 404 for it (any other answer fails the
   job), with notes generated by GitHub.

The same can be done by hand from a checkout of the tag (packages published from outside of CI have
no provenance). With another runtime than Node.js 24.16.0 and npm 11.13.0, the archives may differ
from the published ones, and `publish` then refuses to publish anything:

```bash
git checkout v<version>
npm ci
node scripts/release.mjs version <version>
node scripts/release.mjs pack <dir>
node scripts/release.mjs publish <dir> --skip-existing
```

The `CHANGELOG.md` files inside `packages/*` describe the history before the packages were merged
into this repository.
