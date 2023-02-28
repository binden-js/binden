# Changelog

## [1.2.0](https://github.com/binden-js/binden/compare/v1.1.7...v1.2.0) (2023-02-28)

### Features

- allow to use functions as middlewares ([10333cb](https://github.com/binden-js/binden/commit/10333cbc0aad25a833ef7d4903dc4c537e0c1efa))

### Dependencies

- bump `@binden/logger` from `1.0.6` to `1.0.7` ([6a7611b](https://github.com/binden-js/binden/commit/6a7611b7e9bc06a475544bce578b72904b1ebd66))

## [1.1.7](https://github.com/binden-js/binden/compare/v1.1.6...v1.1.7) (2023-02-12)

### Bug Fixes

- **Context:** allow to pass a custom `stringify` function to `.json()` ([f9317b9](https://github.com/binden-js/binden/commit/f9317b9c217c08c9d2db8cf623d7da5179a10463))

## [1.1.6](https://github.com/binden-js/binden/compare/v1.1.5...v1.1.6) (2023-02-12)

### Performance Improvements

- **BindenResponse:** allow to pass a custom `Stats` to `.sendFile()` ([c3a9a8e](https://github.com/binden-js/binden/commit/c3a9a8e042e3c6937751bb2f8a7b3d67ceb6e361))
- **BindenResponse:** allow to pass a custom `stringify` function to `.json()` ([e90a580](https://github.com/binden-js/binden/commit/e90a5803ea5175e44013da667b555b1d8fe07f24))

### Dependencies

- bump `binden/logger` from `1.0.5` to `1.0.6` ([9333718](https://github.com/binden-js/binden/commit/93337181f98f7367d574c1889e09481022d8849e))

## [1.1.5](https://github.com/binden-js/binden/compare/v1.1.4...v1.1.5) (2022-11-08)

### Dependencies

- bump @binden/logger from 1.0.4 to 1.0.5 ([236f61c](https://github.com/binden-js/binden/commit/236f61cddfe8fb6e79eec4d269a0f78aca52cc8b))

## [1.1.4](https://github.com/binden-js/binden/compare/v1.1.3...v1.1.4) (2022-10-09)

### Dependencies

- bump @binden/logger from 1.0.3 to 1.0.4 ([0a459d1](https://github.com/binden-js/binden/commit/0a459d1baeb7799b1a2d4cabc3e8eb885d98dd6a))

## [1.1.3](https://github.com/binden-js/binden/compare/v1.1.2...v1.1.3) (2022-09-19)

### Performance Improvements

- add generics to the `BindenResponse` class ([8315288](https://github.com/binden-js/binden/commit/8315288246d57a97dfecf20f120ac1b8c01adeba))

## [1.1.2](https://github.com/binden-js/binden/compare/v1.1.1...v1.1.2) (2022-09-06)

### Dependencies

- bump @binden/logger from 1.0.2 to 1.0.3 ([3c5c20b](https://github.com/binden-js/binden/commit/3c5c20bdc12dade5237ab22de5e54407a8ceb79c))

## [1.1.1](https://github.com/binden-js/binden/compare/v1.1.0...v1.1.1) (2022-08-30)

### Dependencies

- bump @binden/logger from 1.0.0 to 1.0.2 ([e026a4f](https://github.com/binden-js/binden/commit/e026a4f45d373bb065ee9060414f9853c1932313))

## [1.1.0](https://github.com/binden-js/binden/compare/v1.0.0...v1.1.0) (2022-08-19)

### Features

- **BindenError:** add the `cause` option ([986a52c](https://github.com/binden-js/binden/commit/986a52cf797568a3ef9aca6cc9aefcf74e8d2bd7))

## 1.0.0 (2022-08-16)

### ⚠ BREAKING CHANGES

- rename `Kauai` to `Binden`
- drop Node.js `<18.7.0` support

### Features

- add `Context` ([ebfc75d](https://github.com/binden-js/binden/commit/ebfc75da9037280b9f3ebfbb8c301fe5f6ddf30f))
- add `Kauai` ([dab27ab](https://github.com/binden-js/binden/commit/dab27ab82e5995b2a062b69d4d1308abc48c9e28))
- add `KauaiError` ([9498106](https://github.com/binden-js/binden/commit/949810618e9f96b178376a8604d9c4e146d0a701))
- add `KauaiRequest` ([4986039](https://github.com/binden-js/binden/commit/4986039f9050e3c2619a6ee73781958a457e8f3b))
- add `KauaiResponse` ([2313985](https://github.com/binden-js/binden/commit/23139857603b301d40a4bb3502b4245384d127b0))
- add `Middleware` ([86e96fb](https://github.com/binden-js/binden/commit/86e96fb548ce68de8294626eaf0f4ffbdfa7ab82))
- add `Router` ([55f2780](https://github.com/binden-js/binden/commit/55f27806fdb7499b5174f8f44303aa4f31f00a97))
- add logger ([7157667](https://github.com/binden-js/binden/commit/7157667f7506c2b6f393454294c5edbbf382e7d0))
- **Headers:** add `Content-Encoding` ([82d1cc2](https://github.com/binden-js/binden/commit/82d1cc25aa43cdeb1e1da288002923768a632ed4))
- **Headers:** add `Content-Type` ([f9fc897](https://github.com/binden-js/binden/commit/f9fc8974c9d76eb09005169462edd8f7b3892bf9))
- **headers:** add `Forwarded` ([abe665c](https://github.com/binden-js/binden/commit/abe665cdf00d0ad1957d6682e4e1dd824ddf0d02))
- **Headers:** add `If-Modified-Since` ([1a894b9](https://github.com/binden-js/binden/commit/1a894b99806eb37ba21400aaa5fcbff49022425b))
- **headers:** add Content-Range ([a0f68a0](https://github.com/binden-js/binden/commit/a0f68a0d8621690229be04389ad6d921ce529fca))
- **headers:** add Cookie ([e78474e](https://github.com/binden-js/binden/commit/e78474ef61dbdf62255a3b03f767d9c27542a110))
- **headers:** add Range ([2473776](https://github.com/binden-js/binden/commit/247377654c233ce78f32437ffd91f646124439a0))
- **Headers:** add the `Accept-Encoding` header ([a26a658](https://github.com/binden-js/binden/commit/a26a6589cc1d3dd504fc395ec8d905256d49c07f))
- **KauaiRequest:** parse the `Cookie` header ([4c4fb44](https://github.com/binden-js/binden/commit/4c4fb4427555e1c311570d214ee9cbd81555582e))
- **KauaiRequest:** parse the `Forwarded` header ([bfb9080](https://github.com/binden-js/binden/commit/bfb908069147a6b76d1fa565a3a0981e6b90d176))
- **KauaiRequest:** parse the `Range` header ([a555d7e](https://github.com/binden-js/binden/commit/a555d7ebbecb81a6dc55ef117658a7f257f74e5a))

### Bug Fixes

- **KauaiResponse:** allow the `.json()` method to accept arrays ([8637ac8](https://github.com/binden-js/binden/commit/8637ac8a527340eb411826000f7c33a5e81e2c0e))

### Performance Improvements

- add `id` to the `KauaiRequest` class ([8b2048c](https://github.com/binden-js/binden/commit/8b2048cdda85dba7d3b05824b074b41ded8a1b2e))
- **Context:** add the `.setHeader()` method ([4e48d2e](https://github.com/binden-js/binden/commit/4e48d2e2cde9dd0deb7c9805a2feea962d78a7db))
- drop Node.js `<18.7.0` support ([7cb854e](https://github.com/binden-js/binden/commit/7cb854ee216e7b02a3d4cf942afc05a93cbfbf8b))
- **Headers:** add the `Authorization` header ([dc53f28](https://github.com/binden-js/binden/commit/dc53f28a5bd7267f8eca3cdf640993afb5c34a45))
- **sendFile:** add partial request support ([b319879](https://github.com/binden-js/binden/commit/b31987905e553393cf71d5a62930ecaa06d054a4))

### Dependencies

- add `@binden/logger` ([e38d95f](https://github.com/binden-js/binden/commit/e38d95f95eb2e85f2c0a40ce65d50bbd610d543c))
- add `@kauai/logger` ([998056b](https://github.com/binden-js/binden/commit/998056b3dc208ac2b84546bf3227af4cbf8f9a1b))
- add `pino` ([6a449ac](https://github.com/binden-js/binden/commit/6a449ac25e64be022752ea4b7b5c9cdef91cb631))
- remove `pino` ([753452c](https://github.com/binden-js/binden/commit/753452cbeb68ebab380d161ec84fd83714c0c3b0))
- upgrade `@kauai/logger` to `v1.0.1` ([5d500df](https://github.com/binden-js/binden/commit/5d500df1aeec5b3303a163ec6b5ff3bf945014b2))
- upgrade `pino` to `v6.12.0` ([eb8d21f](https://github.com/binden-js/binden/commit/eb8d21f49a8367fdeee2f87a3613c98935750629))
- upgrade `pino` to `v6.13.0` ([13f7e8a](https://github.com/binden-js/binden/commit/13f7e8a92d4445db662dd7c2250dffacd845394a))

### Miscellaneous Chores

- rename `Kauai` to `Binden` ([17b83ed](https://github.com/binden-js/binden/commit/17b83ed23df79a1baf934742af9677a1c440651d))
