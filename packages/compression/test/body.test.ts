import { type Context, type IMiddleware } from "binden";
import {
  type IServed,
  dechunk,
  exchange,
  fetchRaw,
  serve,
  within,
} from "./helpers.js";
import { afterEach, suite, test } from "node:test";
import { Compression } from "../index.js";
import { Readable } from "node:stream";
import { deepStrictEqual } from "node:assert/strict";

suite("Compression of the bodies of send()", () => {
  const servers: IServed[] = [];

  const start = async (...middlewares: IMiddleware[]): Promise<IServed> => {
    const served = await serve({}, ...middlewares);
    servers.push(served);
    return served;
  };

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (served) => served.close()));
  });

  test("a stream shorter or longer than its length cuts a compressed response", async () => {
    for (const chunks of [
      ["x".repeat(2000)],
      ["x".repeat(3000), "y".repeat(3000)],
    ]) {
      const { promise: failed, resolve } = Promise.withResolvers<unknown>();
      const { url } = await start(
        new Compression({ format: "gzip" }),
        async (context: Context) => {
          context.response.type("text/plain").setHeader("Content-Length", 5000);
          await context.response.send(Readable.from(chunks)).catch(resolve);
        },
      );
      const { body } = await exchange(url);
      // Never a complete (chunked) body
      deepStrictEqual(dechunk(body).complete, false);
      deepStrictEqual(
        ((await within(failed)) as { code?: unknown }).code,
        "ERR_HTTP_CONTENT_LENGTH_MISMATCH",
      );
    }
  });

  test("a chunk written in an encoding is compressed as such", async () => {
    const { url } = await start(
      new Compression({ format: "gzip" }),
      (context: Context) => {
        context.response.type("text/plain");
        context.response.write("aGVsbG8=", "base64");
        context.response.end();
        context.done = true;
      },
    );
    const received = await fetchRaw(url, {
      headers: { "Accept-Encoding": "gzip" },
    });
    deepStrictEqual(
      [received.headers["content-encoding"], received.body],
      ["gzip", "hello"],
    );
  });

  test("`GET` and `HEAD` of an empty body get the same headers", async () => {
    const handlers: [string, (context: Context) => Promise<void>][] = [
      ["send()", async (c): Promise<void> => c.response.send()],
      ['send("")', async (c): Promise<void> => c.response.send("")],
      [
        "404 with a type",
        async (c): Promise<void> =>
          c.response.status(404).type("text/html").send(),
      ],
      ["304", async (c): Promise<void> => c.response.status(304).send("x")],
      ["204", async (c): Promise<void> => c.response.status(204).send("x")],
    ];
    const names = [
      "content-encoding",
      "content-length",
      "content-type",
      "transfer-encoding",
      "vary",
    ];
    for (const [name, handler] of handlers) {
      const { url } = await start(new Compression(), handler);
      const [get, head] = await Promise.all(
        ["GET", "HEAD"].map(async (method) =>
          fetchRaw(url, { method, headers: { "Accept-Encoding": "gzip, br" } }),
        ),
      );
      deepStrictEqual(
        names.map((header) => head.headers[header]),
        names.map((header) => get.headers[header]),
        name,
      );
    }
  });
});
