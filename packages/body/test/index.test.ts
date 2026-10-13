/* eslint-disable init-declarations */
import { deepEqual, ok, fail, throws } from "node:assert/strict";
import { Server } from "node:http";
import {
  brotliCompress as brotliCompressAsync,
  gzip as gzipAsync,
  deflate as deflateAsync,
  InputType,
} from "node:zlib";
import AJV, { JTDDataType } from "ajv/dist/jtd.js";
import { errors, request } from "undici";
import { Binden, Context, ct_text, ct_json, ct_form } from "binden";

import { BodyParser, IParse } from "../index.js";

function brotliCompress(data: InputType): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    brotliCompressAsync(data, (error, result) => {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
}

function gzip(data: InputType): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    gzipAsync(data, (error, result) => {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
}

function deflate(data: InputType): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    deflateAsync(data, (error, result) => {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
}

const port = 8080;
const url = `http://localhost:${port}/`;

suite("BodyParser", () => {
  let app: Binden;
  let server: Server;

  setup((done) => {
    app = new Binden();
    server = app.createServer().listen(port, done);
  });

  test("constructor (with an invalid `parse` option)", () => {
    throws(
      () => new BodyParser({ parse: 2 as unknown as IParse }),
      new TypeError("`parse` is not a function"),
    );
  });

  test("text", async () => {
    const body = "Hello World";
    const assert = (ct: Context): Promise<void> => {
      deepEqual(ct.request.body, body);
      return ct.send();
    };

    app.use(new BodyParser(), assert);

    const headers = { "Content-Type": ct_text };
    const response = await request(url, { method: "POST", body, headers });
    ok(response.statusCode === 200);
    const text = await response.body.text();
    deepEqual(text, "");
  });

  test("Unsupported methods", async () => {
    const assert = (ct: Context): Promise<void> => {
      ok(typeof ct.request.body === "undefined");
      return ct.send();
    };

    app.use(new BodyParser(), assert);

    const { unsupported_methods } = BodyParser;
    // `CONNECT` is not supported, if any
    unsupported_methods.delete("CONNECT");

    for (const method of unsupported_methods) {
      const headers = { "Content-Type": ct_text };
      const response = await request(url, {
        method: method as "GET",
        headers,
      });
      ok(response.statusCode === 200);
      const text = await response.body.text();
      deepEqual(text, "");
    }
  });

  test("Destroyed socket", async () => {
    const promise = new Promise<void>((resolve) => {
      const destroy = (ct: Context): void => {
        ct.request.destroy();
        deepEqual(ct.request.destroyed, true);
      };
      const assert = (ct: Context): Promise<void> => {
        ok(typeof ct.request.body === "undefined");
        resolve();
        return ct.send();
      };

      app.use(destroy, new BodyParser(), assert);
    });

    const body = "Hello World";
    const headers = { "Content-Type": ct_text };
    try {
      await request(url, { method: "POST", body, headers });
      fail("Should throw an Error");
    } catch (error: unknown) {
      ok(error instanceof errors.SocketError);
      deepEqual(error.message, `other side closed`);
      deepEqual(error.code, `UND_ERR_SOCKET`);
    }
    await promise;
  });

  test("JSON", async () => {
    const expected = { message: "Hello World" };
    const assert = (ct: Context): Promise<void> => {
      deepEqual(ct.request.body, expected);
      return ct.send();
    };

    app.use(new BodyParser(), assert);

    const headers = { "Content-Type": ct_json };
    const body = JSON.stringify(expected);
    const response = await request(url, { method: "POST", body, headers });
    ok(response.statusCode === 200);
    const text = await response.body.text();
    deepEqual(text, "");
  });

  test("JSON (with a custom `parse`)", async () => {
    const ajv = new AJV();
    const schema = {
      properties: {
        username: { type: "string" },
        password: { type: "string" },
      },
      additionalProperties: false,
    };
    const parse: IParse<JTDDataType<typeof schema>> =
      ajv.compileParser<JTDDataType<typeof schema>>(schema);
    const body_parser = new BodyParser({ parse });

    const expected = { username: "someusername", password: "somepassword" };
    const assert = (ct: Context): Promise<void> => {
      deepEqual(ct.request.body, expected);
      return ct.send();
    };

    app.use(body_parser, assert);

    const headers = { "Content-Type": ct_json };
    const body = JSON.stringify(expected);
    const response = await request(url, { method: "POST", body, headers });
    ok(response.statusCode === 200);
    const text = await response.body.text();
    deepEqual(text, "");
  });

  test("JSON (invalid)", async () => {
    app.use(new BodyParser());

    const headers = { "Content-Type": ct_json };
    const body = "Not a JSON";
    const response = await request(url, { method: "POST", body, headers });
    deepEqual(response.statusCode, 415);
    const text = await response.body.text();
    deepEqual(text, "");
  });

  test("form", async () => {
    const body = new URLSearchParams({ message: "Hello World" });
    const assert = (ct: Context): Promise<void> => {
      deepEqual(ct.request.body, body);
      return ct.send();
    };

    app.use(new BodyParser(), assert);

    const headers = { "Content-Type": ct_form };
    const response = await request(url, {
      method: "POST",
      headers,
      body: body.toString(),
    });
    ok(response.statusCode === 200);
    const text = await response.body.text();
    deepEqual(text, "");
  });

  test("encoding", async () => {
    const expected = { message: "Hello World" };
    const assert = (ct: Context): Promise<void> => {
      deepEqual(ct.request.body, expected);
      return ct.send();
    };

    app.use(new BodyParser(), assert);

    const brotli = await brotliCompress(JSON.stringify(expected));
    const doubleGzip = await gzip(await gzip(brotli));
    const body = await deflate(doubleGzip);

    const ce = "br, x-gzip, gzip, deflate";
    const headers = { "Content-Encoding": ce, "Content-Type": ct_json };
    const response = await request(url, { method: "POST", body, headers });
    ok(response.statusCode);
    const text = await response.body.text();
    deepEqual(text, "");
  });

  test("Missing `Content-Type`", async () => {
    const body = "Hello World";
    const assert = (ct: Context): Promise<void> => {
      ok(typeof ct.request.body === "undefined");
      return ct.send();
    };

    app.use(new BodyParser(), assert);

    const headers = { "Content-Type": "" };

    const response = await request(url, { method: "POST", body, headers });
    deepEqual(response.statusCode, 200);
    const text = await response.body.text();
    deepEqual(text, "");
  });

  test("Unsupported `Content-Type`", async () => {
    const body = "Hello World";
    const assert = (ct: Context): Promise<void> => {
      ok(typeof ct.request.body === "undefined");
      return ct.send();
    };

    app.use(new BodyParser(), assert);

    const headers = { "Content-Type": "__unsupported__" };
    const response = await request(url, { method: "POST", body, headers });
    deepEqual(response.statusCode, 200);
    const text = await response.body.text();
    deepEqual(text, "");
  });

  test("Unsupported `Content-Encoding`", async () => {
    const body = "Hello World";

    app.use(new BodyParser());

    const headers = { "Content-Type": ct_json, "Content-Encoding": "compress" };
    const response = await request(url, { method: "POST", body, headers });
    deepEqual(response.statusCode, 415);
    const text = await response.body.text();
    deepEqual(text, "");
  });

  test("Decompressions errors", async () => {
    const body = "Hello World";

    app.use(new BodyParser());

    const headers = { "Content-Type": ct_text, "Content-Encoding": "br" };
    const response = await request(url, { method: "POST", body, headers });
    deepEqual(response.statusCode, 415);
    const text = await response.body.text();
    deepEqual(text, "");
  });

  teardown((done) => {
    server.closeIdleConnections();
    server.close(done);
  });
});
