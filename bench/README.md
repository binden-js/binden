# Benchmarks

A small benchmark of binden, without dependencies: `index.mjs` forks a server
(`server.mjs`, the built packages of the workspaces) and sends the requests of
every scenario over keep-alive connections of `node:http`, then prints the
requests per second and the latencies (p50 and p99).

| Scenario      | Request                                                                           |
| ------------- | --------------------------------------------------------------------------------- |
| `hello`       | `GET /hello`: `context.text()`                                                    |
| `json`        | `GET /json`: `context.json()`                                                     |
| `params`      | `GET /users/42/posts/hello%20world`: a `route()` with two parameters              |
| `body`        | `POST /echo` with 1 KiB of JSON: `@binden/body`, then `context.json()`            |
| `compression` | `GET /large` (16 KiB of text, `Accept-Encoding: br, gzip`): `@binden/compression` |

```bash
npm run bench
npm run bench -- --duration 10 --connections 64 --scenario json --scenario body
```

`npm run bench` builds the packages first. The client and the server share the
machine (the loopback interface): compare the results of one machine, one
Node.js version and one load, not absolute numbers. The benchmark is not run in
CI.
