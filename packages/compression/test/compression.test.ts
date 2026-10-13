/* eslint-disable init-declarations, sort-imports */
import { deepStrictEqual, ok } from "node:assert";
import { randomBytes, randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  type InputType,
  brotliDecompress as brotliDecompressAsync,
  gunzip as gunzipAsync,
  inflate as inflateAsync,
} from "node:zlib";

import { Binden, BindenError, Context, Middleware } from "binden";
import { request } from "undici";

import {
  Compression,
  DefaultCompression,
  type IComressFormats,
} from "../index.js";

function brotliDecompress(data: InputType): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    brotliDecompressAsync(data, (error, result) => {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
}

function gunzip(data: InputType): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    gunzipAsync(data, (error, result) => {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
}

function inflate(data: InputType): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    inflateAsync(data, (error, result) => {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
}

const port = 8080;
const url = new URL(`http://localhost:${port}`);

class TestMiddleware extends Middleware {
  readonly #data: Buffer | string | undefined;
  public constructor(data?: Buffer | string) {
    super();
    this.#data = data;
  }
  public run(ct: unknown): Promise<void> {
    ok(ct instanceof Context);
    return ct.send(this.#data);
  }
}

describe("Compression", () => {
  let app: Binden;
  let server: Server;

  beforeEach(async () => {
    await new Promise<void>((resolve) => {
      app = new Binden();
      server = app.createServer().listen(port, resolve);
    });
  });

  it("constructor (with default options)", async () => {
    const expected = "Hello World";
    const format = "deflate";
    app.use(new Compression(), new TestMiddleware(expected));

    const headers = { "Accept-Encoding": format };
    const response = await request(url, { headers });

    deepStrictEqual(response.headers["content-encoding"], format);
    deepStrictEqual(response.statusCode, 200);

    const body = await response.body.arrayBuffer();
    const actual = (await inflate(body)).toString();

    deepStrictEqual(actual, expected);
  });

  it("auto (x-gzip)", async () => {
    const expected = "Hello World";
    app.use(new Compression({ format: "auto" }), new TestMiddleware(expected));

    const headers = { "Accept-Encoding": "x-gzip" };
    const response = await request(url, { headers });

    deepStrictEqual(response.headers["content-encoding"], "gzip");
    deepStrictEqual(response.statusCode, 200);

    const body = await response.body.arrayBuffer();
    const actual = (await gunzip(body)).toString();

    deepStrictEqual(actual, expected);
  });

  it("auto (gzip)", async () => {
    const expected = "Hello World";
    const format = "gzip";
    app.use(new Compression({ format: "auto" }), new TestMiddleware(expected));

    const headers = { "Accept-Encoding": format };
    const response = await request(url, { headers });

    deepStrictEqual(response.headers["content-encoding"], format);
    deepStrictEqual(response.statusCode, 200);

    const body = await response.body.arrayBuffer();
    const actual = (await gunzip(body)).toString();

    deepStrictEqual(actual, expected);
  });

  it("auto (br)", async () => {
    const expected = "Hello World";
    const format = "br";
    app.use(new Compression({ format: "auto" }), new TestMiddleware(expected));

    const headers = { "Accept-Encoding": format };
    const response = await request(url, { headers });

    deepStrictEqual(response.headers["content-encoding"], format);
    deepStrictEqual(response.statusCode, 200);

    const body = await response.body.arrayBuffer();
    const actual = (await brotliDecompress(body)).toString();

    deepStrictEqual(actual, expected);
  });

  it("auto (identity)", async () => {
    const expected = "Hello World";
    const format = "* ;q= 0.6, identity ;q= 0.7";
    app.use(new Compression({ format: "auto" }), new TestMiddleware(expected));

    const headers = { "Accept-Encoding": format };
    const response = await request(url, { headers });

    ok(typeof response.headers["content-encoding"] === "undefined");
    deepStrictEqual(response.statusCode, 200);

    const body = await response.body.arrayBuffer();
    const actual = Buffer.from(body).toString();

    deepStrictEqual(actual, expected);
  });

  it("auto (*)", async () => {
    const expected = "Hello World";
    const format = "* ;q= 0.8, identity ;q= 0.7";
    app.use(new Compression({ format: "auto" }), new TestMiddleware(expected));

    const headers = { "Accept-Encoding": format };
    const response = await request(url, { headers });

    deepStrictEqual(response.headers["content-encoding"], DefaultCompression);
    deepStrictEqual(response.statusCode, 200);

    const body = await response.body.arrayBuffer();
    const actual = (await brotliDecompress(body)).toString();

    deepStrictEqual(actual, expected);
  });

  it("auto (Default compression when no `Accept-Encoding` header is present)", async () => {
    const expected = "Hello World";
    app.use(new Compression({ format: "auto" }), new TestMiddleware(expected));

    const response = await request(url);

    deepStrictEqual(response.headers["content-encoding"], DefaultCompression);
    deepStrictEqual(response.statusCode, 200);

    const body = await response.body.arrayBuffer();
    const actual = (await brotliDecompress(body)).toString();

    deepStrictEqual(actual, expected);
  });

  it("auto (empty `Accept-Encoding` asks for no coding)", async () => {
    const expected = "Hello World";
    app.use(new Compression({ format: "auto" }), new TestMiddleware(expected));

    const headers = { "Accept-Encoding": "" };
    const response = await request(url, { headers });

    ok(typeof response.headers["content-encoding"] === "undefined");
    deepStrictEqual(response.headers.vary, "Accept-Encoding");
    deepStrictEqual(await response.body.text(), expected);
  });

  it("auto (codings refused with `q=0`)", async () => {
    const expected = "Hello World";
    app.use(new Compression({ format: "auto" }), new TestMiddleware(expected));

    const headers = { "Accept-Encoding": "gzip;q=0, br;q=0, deflate;q=0" };
    const response = await request(url, { headers });

    ok(typeof response.headers["content-encoding"] === "undefined");
    deepStrictEqual(await response.body.text(), expected);
  });

  it("auto (`*` skips codings refused with `q=0`)", async () => {
    const expected = "Hello World";
    app.use(new Compression({ format: "auto" }), new TestMiddleware(expected));

    const headers = { "Accept-Encoding": "br;q=0, *" };
    const response = await request(url, { headers });

    deepStrictEqual(response.headers["content-encoding"], "gzip");

    const body = await response.body.arrayBuffer();
    const actual = (await gunzip(Buffer.from(body))).toString();

    deepStrictEqual(actual, expected);
  });

  it("auto (`*` with every coding refused)", async () => {
    const expected = "Hello World";
    app.use(new Compression({ format: "auto" }), new TestMiddleware(expected));

    const headers = { "Accept-Encoding": "br;q=0, gzip;q=0, deflate;q=0, *" };
    const response = await request(url, { headers });

    ok(typeof response.headers["content-encoding"] === "undefined");
    deepStrictEqual(await response.body.text(), expected);
  });

  it("auto (adds `Accept-Encoding` to the existing `Vary`)", async () => {
    const expected = "Hello World";
    app.use(
      (ct: Context) => {
        ct.response.setHeader("Vary", "Origin");
      },
      new Compression({ format: "auto" }),
      new TestMiddleware(expected),
    );

    const headers = { "Accept-Encoding": "gzip" };
    const response = await request(url, { headers });

    deepStrictEqual(response.headers.vary, "Origin, Accept-Encoding");
    deepStrictEqual(response.headers["content-encoding"], "gzip");
  });

  it("auto (keeps a `Vary` that already covers `Accept-Encoding`)", async () => {
    const expected = "Hello World";
    app.use(
      (ct: Context) => {
        ct.response.setHeader("Vary", ["Origin", "accept-encoding"]);
      },
      new Compression({ format: "auto" }),
      new TestMiddleware(expected),
    );

    const headers = { "Accept-Encoding": "gzip" };
    const response = await request(url, { headers });

    deepStrictEqual(response.headers.vary, ["Origin", "accept-encoding"]);
  });

  it("does not add `Vary` for a fixed format", async () => {
    const expected = "Hello World";
    app.use(new Compression({ format: "gzip" }), new TestMiddleware(expected));

    const response = await request(url);

    ok(typeof response.headers.vary === "undefined");
    deepStrictEqual(response.headers["content-encoding"], "gzip");
  });

  it("auto (unsupported)", async () => {
    const expected = "Hello World";
    const format = "compress";
    app.use(new Compression({ format: "auto" }), new TestMiddleware(expected));

    const headers = { "Accept-Encoding": format };
    const response = await request(url, { headers });

    ok(typeof response.headers["content-encoding"] === "undefined");
    deepStrictEqual(response.statusCode, 200);

    const body = await response.body.arrayBuffer();
    const actual = Buffer.from(body).toString();

    deepStrictEqual(actual, expected);
  });

  it("gzip", async () => {
    const expected = "Hello World";
    const format = "gzip";
    app.use(new Compression({ format }), new TestMiddleware(expected));

    const response = await request(url);

    deepStrictEqual(response.headers["content-encoding"], format);
    deepStrictEqual(response.statusCode, 200);

    const raw = await response.body.arrayBuffer();
    const actual = (await gunzip(raw)).toString();

    deepStrictEqual(actual, expected);
  });

  it("br", async () => {
    const expected = "Hello World";
    const format = "br";
    app.use(new Compression({ format }), new TestMiddleware(expected));

    const response = await request(url);

    deepStrictEqual(response.headers["content-encoding"], format);
    deepStrictEqual(response.statusCode, 200);

    const raw = await response.body.arrayBuffer();
    const actual = (await brotliDecompress(raw)).toString();

    deepStrictEqual(actual, expected);
  });

  it("deflate", async () => {
    const expected = "Hello World";
    const format = "deflate";
    app.use(new Compression({ format }), new TestMiddleware(expected));

    const response = await request(url);

    deepStrictEqual(response.headers["content-encoding"], format);
    deepStrictEqual(response.statusCode, 200);

    const raw = await response.body.arrayBuffer();
    const actual = (await inflate(raw)).toString();

    deepStrictEqual(actual, expected);
  });

  it("Multiple compressions", async () => {
    const expected = "Hello World";
    const formats: readonly IComressFormats[] = ["gzip", "br", "deflate"];
    app.use(
      ...formats.map((format) => new Compression({ format })),
      new TestMiddleware(expected),
    );

    const response = await request(url);

    deepStrictEqual(
      response.headers["content-encoding"],
      [...formats].reverse(),
    );
    deepStrictEqual(response.statusCode, 200);

    const body = await response.body.arrayBuffer();
    const gzip = await gunzip(Buffer.from(body));
    const br = await brotliDecompress(gzip);
    const actual = (await inflate(br)).toString();

    deepStrictEqual(actual, expected);
  });

  it(
    "sendFile (drops the `Content-Length` of the uncompressed file)",
    { timeout: 10_000 },
    async () => {
      const expected = randomBytes(1024).toString("hex");
      const path = join(tmpdir(), `binden-compression-${randomUUID()}.txt`);
      await writeFile(path, expected);

      try {
        app.use(new Compression({ format: "gzip" }), (ct: Context) =>
          ct.sendFile(path),
        );

        const response = await request(url);

        deepStrictEqual(response.statusCode, 200);
        deepStrictEqual(response.headers["content-encoding"], "gzip");
        ok(typeof response.headers["content-length"] === "undefined");

        const body = await response.body.arrayBuffer();
        const actual = (await gunzip(Buffer.from(body))).toString();

        deepStrictEqual(actual, expected);
      } finally {
        await rm(path);
      }
    },
  );

  it("does not encode error responses of the following middlewares", async () => {
    const message = "invalid request";
    app.use(new Compression({ format: "gzip" }), () => {
      throw new BindenError(400, { expose: true, message });
    });

    const response = await request(url);

    deepStrictEqual(response.statusCode, 400);
    ok(typeof response.headers["content-encoding"] === "undefined");
    deepStrictEqual(await response.body.text(), message);
  });

  it("does not compress when the headers have already been sent", async () => {
    const expected = "Hello World";
    app.use(new Compression({ format: "gzip" }), (ct: Context) => {
      ct.response.flushHeaders();
      ct.response.write("Hello ");
      return ct.send("World");
    });

    const response = await request(url);

    deepStrictEqual(response.statusCode, 200);
    ok(typeof response.headers["content-encoding"] === "undefined");
    deepStrictEqual(await response.body.text(), expected);
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.closeIdleConnections();
      setTimeout(() => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }, 5);
    });
  });
});
