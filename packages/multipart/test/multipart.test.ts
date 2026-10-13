/* eslint-disable init-declarations, @typescript-eslint/no-floating-promises, sort-imports */
import { deepEqual, ok } from "node:assert/strict";
import { request, Server } from "node:http";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Binden, Context } from "binden";
import multipart, { Multipart } from "../index.js";

const port = 8080;
const url = `http://localhost:${port}/`;

describe("Multipart", () => {
  let app: Binden;
  let server: Server;

  beforeEach(async () => {
    app = new Binden();
    await new Promise<void>((resolve) => {
      server = app.createServer().listen(port, resolve);
    });
  });

  it("Skips when method is `GET`", async () => {
    const message = { success: true };
    const assert = async (ct: Context): Promise<void> => {
      ok(ct.request.method === "GET");
      ok(typeof ct.request.body === "undefined");
      await ct.json(message);
    };

    app.use(new Multipart(), assert);

    const response = await fetch(url);
    const data = (await response.json()) as unknown;
    deepEqual(response.status, 200);
    deepEqual(data, message);
  });

  it("Skips when method is `HEAD`", async () => {
    const assert = async (ct: Context): Promise<void> => {
      ok(ct.request.method === "HEAD");
      ok(typeof ct.request.body === "undefined");
      await ct.send();
    };

    app.use(new Multipart(), assert);

    const response = await fetch(url, { method: "HEAD" });
    const data = (await response.text()) as unknown;
    deepEqual(response.status, 200);
    deepEqual(data, "");
  });

  it("Skips when no `Content-Type` header is present", async () => {
    const body = "Hello World";
    const assert = async (ct: Context): Promise<void> => {
      ok(typeof ct.request.headers["content-type"] === "undefined");
      ok(typeof ct.request.body === "undefined");
      await ct.send();
    };

    app.use(multipart(), assert);

    await new Promise<void>((resolve, reject) => {
      request(url, { method: "POST" })
        .on("response", (response) => {
          const chunks: Buffer[] = [];
          response
            .on("data", (chunk: Buffer) => {
              chunks.push(chunk);
            })
            .on("error", reject)
            .on("end", () => {
              try {
                deepEqual(Buffer.concat(chunks).toString(), "");
                ok(response.statusCode === 200);
                resolve();
              } catch (error) {
                reject(error as Error);
              }
            });
        })
        .on("error", reject)
        .end(body);
    });
  });

  it("Skips when `Content-Type` is not `multipart/form-data`", async () => {
    const body = "Hello World";
    const ct = "image/jpeg";
    const assert = async (context: Context): Promise<void> => {
      deepEqual(context.request.headers["content-type"], ct);
      ok(typeof context.request.body === "undefined");
      await context.send();
    };

    app.use(multipart(), assert);

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": ct },
      body,
    });
    const data = (await response.text()) as unknown;
    deepEqual(response.status, 200);
    deepEqual(data, "");
  });

  it("Skips when `multipart/form-data` is missing `boundary`", async () => {
    const body = "Hello World";
    const form_data = "multipart/form-data";
    const assert = async (ct: Context): Promise<void> => {
      deepEqual(ct.request.headers["content-type"], form_data);
      ok(typeof ct.request.body === "undefined");
      await ct.send();
    };

    app.use(multipart(), assert);

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": form_data },
      body,
    });
    const data = (await response.text()) as unknown;
    deepEqual(response.status, 200);
    deepEqual(data, "");
  });

  it("Parses body as `FormData`", async () => {
    const msg = { success: true };
    const body = new FormData();
    body.append("name1", "value11");
    body.append("name1", "value12");
    body.append("name2", "value2");
    const file11 = new File(
      [JSON.stringify({ hello: "world" })],
      "file11.json",
      { type: "application/json" },
    );
    const file12 = new File(["<html></html>"], "file12.html", {
      type: "plain/html",
    });
    const file2 = new File(["Hello World"], "file2.txt", {
      type: "plain/txt",
    });
    body.append("file1", file11);
    body.append("file1", file12);
    body.append("file2", file2);

    const assert = async (context: Context): Promise<void> => {
      deepEqual(context.request.content_type?.type, "multipart/form-data");
      ok(context.request.content_type.boundary !== null);
      const { body: actual } = context.request;
      ok(actual instanceof FormData);
      deepEqual(actual, body);
      for (const key in actual.keys()) {
        deepEqual(actual.getAll(key), body.getAll(key));
      }
      const [actual_file11, actual_file12] = actual.getAll("file1") as File[];
      deepEqual(actual_file11.name, file11.name);
      deepEqual(actual_file11.size, file11.size);
      deepEqual(actual_file11.type, file11.type);
      deepEqual(actual_file12.name, file12.name);
      deepEqual(actual_file12.type, file12.type);
      deepEqual(actual_file12.size, file12.size);
      const [files2] = actual.getAll("file2") as File[];
      deepEqual(files2.name, file2.name);
      deepEqual(files2.type, file2.type);
      deepEqual(files2.size, file2.size);
      await context.json(msg);
    };

    app.use(multipart(), assert);

    const response = await fetch(url, { method: "POST", body });
    const data = (await response.json()) as unknown;
    deepEqual(response.status, 200);
    deepEqual(data, msg);
  });

  it("Replies with 415 error when request body is not a valid FormData", async () => {
    const ct = "multipart/form-data; boundary=----formdata-undici-064882379910";

    app.use(multipart());

    const response = await fetch(url, {
      method: "POST",
      body: "Hello World",
      headers: { "Content-Type": ct },
    });
    const data = await response.text();
    deepEqual(response.status, 415);
    deepEqual(data, "");
  });

  it("Replies with 415 error when FormData reaches the `fields` limit (by default)", async () => {
    const body = new FormData();
    body.append("k1", "v1");
    body.append("k2", "v2");

    app.use(multipart({ limits: { fields: 1 } }));

    const response = await fetch(url, { method: "POST", body });
    await response.text();
    deepEqual(response.status, 415);
  });

  it("Passes an incomplete FormData when it reaches the `fields` limit (`throw_limits = true`)", async () => {
    const body = new FormData();
    body.append("k1", "v1");
    body.append("k2", "v2");

    const assert = (context: Context): Promise<void> => {
      ok(context.request.body instanceof FormData);
      deepEqual(context.request.body.getAll("k1"), ["v1"]);
      ok(context.request.body.get("k2") === null);
      return context.send();
    };

    app.use(
      new Multipart({ config: { limits: { fields: 1 } }, throw_limits: false }),
      assert,
    );

    const response = await fetch(url, { method: "POST", body });
    await response.text();
    deepEqual(response.status, 200);
  });

  it("Replies with 415 error when FormData reaches the `files` limit (by default)", async () => {
    const body = new FormData();
    body.append("file1", new File([Buffer.allocUnsafe(50)], "file1.txt"));
    body.append("file2", new File([Buffer.allocUnsafe(150)], "file2.txt"));

    app.use(multipart({ limits: { files: 1 } }));

    const response = await fetch(url, { method: "POST", body });
    await response.text();
    deepEqual(response.status, 415);
  });

  it("Passes an incomplete FormData when it reaches the `files` limit (`throw_limits = true`)", async () => {
    const body = new FormData();
    const file1 = new File([Buffer.allocUnsafe(50)], "file1.txt", {
      type: "application/octet-stream",
    });
    const file2 = new File([Buffer.allocUnsafe(150)], "file2.txt", {
      type: "application/octet-stream",
    });
    body.append("file1", file1);
    body.append("file2", file2);

    const assert = (context: Context): Promise<void> => {
      ok(context.request.body instanceof FormData);

      const actual_file1 = context.request.body.get("file1");
      const actual_file2 = context.request.body.get("file2");

      ok(actual_file1 instanceof File);
      ok(actual_file2 === null);

      deepEqual(actual_file1.name, file1.name);
      deepEqual(actual_file1.size, file1.size);
      deepEqual(actual_file1.type, file1.type);

      return context.send();
    };

    app.use(
      new Multipart({ config: { limits: { files: 1 } }, throw_limits: false }),
      assert,
    );

    const response = await fetch(url, { method: "POST", body });
    await response.text();
    deepEqual(response.status, 200);
  });

  it("Replies with 415 error when FormData reaches the `fileSize` limit (by default)", async () => {
    const body = new FormData();
    body.append("file1", new File([Buffer.allocUnsafe(50)], "file1.txt"));
    body.append("file2", new File([Buffer.allocUnsafe(150)], "file2.txt"));

    app.use(multipart({ limits: { fileSize: 100 } }));

    const response = await fetch(url, { method: "POST", body });
    await response.text();
    deepEqual(response.status, 415);
  });

  it("Passes an incomplete FormData when it reaches the `fileSize` limit (`throw_limits = true`)", async () => {
    const body = new FormData();
    const file1 = new File([Buffer.allocUnsafe(50)], "file1.txt", {
      type: "application/octet-stream",
    });
    const file2 = new File([Buffer.allocUnsafe(150)], "file2.txt", {
      type: "application/octet-stream",
    });
    body.append("file1", file1);
    body.append("file2", file2);

    const assert = (context: Context): Promise<void> => {
      ok(context.request.body instanceof FormData);

      const actual_file1 = context.request.body.get("file1");
      const actual_file2 = context.request.body.get("file2");

      ok(actual_file1 instanceof File);
      ok(actual_file2 instanceof File);

      deepEqual(actual_file1.name, file1.name);
      deepEqual(actual_file1.size, file1.size);
      deepEqual(actual_file1.type, file1.type);

      deepEqual(actual_file2.name, file2.name);
      deepEqual(actual_file2.size, 100);
      deepEqual(actual_file2.type, file2.type);

      return context.send();
    };

    app.use(
      new Multipart({
        config: { limits: { fileSize: 100 } },
        throw_limits: false,
      }),
      assert,
    );

    const response = await fetch(url, { method: "POST", body });
    await response.text();
    deepEqual(response.status, 200);
  });

  it("Replies with 415 error when FormData reaches the `parts` limit (by default)", async () => {
    const body = new FormData();
    const file = new File(["123"], "file.txt", {
      type: "plain/txt",
    });
    body.append("file", file);
    body.append("k1", "v1");
    body.append("k2", "v2");

    app.use(multipart({ limits: { parts: 2 } }));

    const response = await fetch(url, { method: "POST", body });
    await response.text();
    deepEqual(response.status, 415);
  });

  it("Passes an incomplete FormData when it reaches the `parts` limit (`throw_limits = true`)", async () => {
    const body = new FormData();
    const file = new File(["123"], "file.txt", {
      type: "plain/txt",
    });
    body.append("file", file);
    body.append("k1", "v1");
    body.append("k2", "v2");

    const assert = (context: Context): Promise<void> => {
      ok(context.request.body instanceof FormData);

      const actual_file = context.request.body.get("file");
      ok(actual_file instanceof File);
      deepEqual(actual_file.name, file.name);
      deepEqual(actual_file.size, file.size);
      deepEqual(actual_file.type, file.type);
      deepEqual(context.request.body.get("k1"), "v1");
      deepEqual(context.request.body.get("k2"), null);

      return context.send();
    };

    app.use(
      new Multipart({ config: { limits: { parts: 2 } }, throw_limits: false }),
      assert,
    );

    const response = await fetch(url, { method: "POST", body });
    await response.text();
    deepEqual(response.status, 200);
  });

  afterEach(async () => {
    server.closeIdleConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  });
});
