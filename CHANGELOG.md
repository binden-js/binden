# Changelog

### [1.0.4](https://github.com/b2broker/kauai/compare/v1.0.3...v1.0.4) (2021-08-16)

### Bug Fixes

- **KauaiResponse:** allow the `.json()` method to accept arrays ([8637ac8](https://github.com/b2broker/kauai/commit/8637ac8a527340eb411826000f7c33a5e81e2c0e))

### Performance Improvements

- **sendFile:** add partial request support ([b319879](https://github.com/b2broker/kauai/commit/b31987905e553393cf71d5a62930ecaa06d054a4))

### [1.0.3](https://github.com/b2broker/kauai/compare/v1.0.2...v1.0.3) (2021-08-04)

### Dependencies

- add `@kauai/logger` ([998056b](https://github.com/b2broker/kauai/commit/998056b3dc208ac2b84546bf3227af4cbf8f9a1b))
- remove `pino` ([753452c](https://github.com/b2broker/kauai/commit/753452cbeb68ebab380d161ec84fd83714c0c3b0))

### [1.0.2](https://github.com/b2broker/kauai/compare/v1.0.1...v1.0.2) (2021-07-31)

### Performance Improvements

- add `id` to the `KauaiRequest` class ([8b2048c](https://github.com/b2broker/kauai/commit/8b2048cdda85dba7d3b05824b074b41ded8a1b2e))

### [1.0.1](https://github.com/b2broker/kauai/compare/v1.0.0...v1.0.1) (2021-07-29)

### Performance Improvements

- **Headers:** add the `Authorization` header ([dc53f28](https://github.com/b2broker/kauai/commit/dc53f28a5bd7267f8eca3cdf640993afb5c34a45))

## 1.0.0 (2021-07-27)

### Features

- add `Kauai` ([dab27ab](https://github.com/b2broker/kauai/commit/dab27ab82e5995b2a062b69d4d1308abc48c9e28))
- **Headers:** add `If-Modified-Since` ([1a894b9](https://github.com/b2broker/kauai/commit/1a894b99806eb37ba21400aaa5fcbff49022425b))
- add `Context` ([ebfc75d](https://github.com/b2broker/kauai/commit/ebfc75da9037280b9f3ebfbb8c301fe5f6ddf30f))
- add `KauaiError` ([9498106](https://github.com/b2broker/kauai/commit/949810618e9f96b178376a8604d9c4e146d0a701))
- add `KauaiRequest` ([4986039](https://github.com/b2broker/kauai/commit/4986039f9050e3c2619a6ee73781958a457e8f3b))
- add `KauaiResponse` ([2313985](https://github.com/b2broker/kauai/commit/23139857603b301d40a4bb3502b4245384d127b0))
- add `Middleware` ([86e96fb](https://github.com/b2broker/kauai/commit/86e96fb548ce68de8294626eaf0f4ffbdfa7ab82))
- add `Router` ([55f2780](https://github.com/b2broker/kauai/commit/55f27806fdb7499b5174f8f44303aa4f31f00a97))
- **headers:** add `Forwarded` ([abe665c](https://github.com/b2broker/kauai/commit/abe665cdf00d0ad1957d6682e4e1dd824ddf0d02))
- **headers:** add Content-Range ([a0f68a0](https://github.com/b2broker/kauai/commit/a0f68a0d8621690229be04389ad6d921ce529fca))
- **headers:** add Cookie ([e78474e](https://github.com/b2broker/kauai/commit/e78474ef61dbdf62255a3b03f767d9c27542a110))
- **headers:** add Range ([2473776](https://github.com/b2broker/kauai/commit/247377654c233ce78f32437ffd91f646124439a0))
- **Headers:** add `Content-Encoding` ([82d1cc2](https://github.com/b2broker/kauai/commit/82d1cc25aa43cdeb1e1da288002923768a632ed4))
- **Headers:** add `Content-Type` ([f9fc897](https://github.com/b2broker/kauai/commit/f9fc8974c9d76eb09005169462edd8f7b3892bf9))
- **Headers:** add the `Accept-Encoding` header ([a26a658](https://github.com/b2broker/kauai/commit/a26a6589cc1d3dd504fc395ec8d905256d49c07f))
- **KauaiRequest:** parse the `Cookie` header ([4c4fb44](https://github.com/b2broker/kauai/commit/4c4fb4427555e1c311570d214ee9cbd81555582e))
- **KauaiRequest:** parse the `Forwarded` header ([bfb9080](https://github.com/b2broker/kauai/commit/bfb908069147a6b76d1fa565a3a0981e6b90d176))
- **KauaiRequest:** parse the `Range` header ([a555d7e](https://github.com/b2broker/kauai/commit/a555d7ebbecb81a6dc55ef117658a7f257f74e5a))
- add logger ([7157667](https://github.com/b2broker/kauai/commit/7157667f7506c2b6f393454294c5edbbf382e7d0))

### Metadata

- update `engines` ([9af3e3b](https://github.com/b2broker/kauai/commit/9af3e3b48f221d4b3811506620903e2f3f11751c))

### Dependencies

- add `pino` ([6a449ac](https://github.com/b2broker/kauai/commit/6a449ac25e64be022752ea4b7b5c9cdef91cb631))
- upgrade `pino` to `v6.12.0` ([eb8d21f](https://github.com/b2broker/kauai/commit/eb8d21f49a8367fdeee2f87a3613c98935750629))
- upgrade `pino` to `v6.13.0` ([13f7e8a](https://github.com/b2broker/kauai/commit/13f7e8a92d4445db662dd7c2250dffacd845394a))
