/* eslint-disable init-declarations */
import { deepEqual, ok, throws, rejects } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile, rm, mkdir, rmdir, stat } from "node:fs/promises";
import { IncomingMessage, Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, it } from "node:test";
import fastJSON from "fast-json-stringify";

import type { Stats } from "node:fs";

import {
  BindenResponse,
  BindenRequest,
  Cookie,
  ct_json,
  ct_text,
  ct_form,
  ct_html,
} from "../index.js";

const port = 18080;
const url = `http://localhost:${port}`;

describe("BindenResponse", () => {
  const filePath = `${tmpdir()}/__binden.test.file`;
  const dirPath = `${tmpdir()}/__binden.test.dir`;
  let msg: Buffer;
  let server: Server<typeof IncomingMessage, typeof BindenResponse>;
  let file_stats: Stats;
  let dir_stats: Stats;

  beforeEach(async () => {
    msg = Buffer.from(randomUUID());
    await mkdir(dirPath);
    await writeFile(filePath, msg);
    await new Promise<void>((resolve) => {
      server = createServer<typeof IncomingMessage, typeof BindenResponse>({
        ServerResponse: BindenResponse,
      }).listen(port, resolve);
    });
    dir_stats = await stat(dirPath);
    file_stats = await stat(filePath);
  });

  it("ServerResponse", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        try {
          deepEqual(response instanceof BindenResponse, true);
        } catch (error) {
          reject(error);
        } finally {
          response.end(resolve);
        }
      });
    });
    await fetch(url);
    await serverPromise;
  });

  it(".status()", async () => {
    const status = 401;
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        try {
          ok(response.status(status) instanceof BindenResponse);
          deepEqual(response.statusCode, status);
        } catch (error) {
          reject(error);
        } finally {
          response.end(resolve);
        }
      });
    });
    const response = await fetch(url);
    await serverPromise;

    deepEqual(response.status, status);
  });

  it(".status() (throws TypeError with unsupported code)", async () => {
    const status = 499;
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        try {
          throws(
            () => response.status(status),
            new TypeError(`Status code ${status} is invalid`),
          );
          deepEqual(response.statusCode, 200);
        } catch (error) {
          reject(error);
        } finally {
          response.end(resolve);
        }
      });
    });
    await fetch(url);
    await serverPromise;
  });

  it(".set()", async () => {
    const x = "X-Header";
    const y = "Y-Header";
    const z = "Z-Header";
    const headers = { [x]: 0, [y]: "0", [z]: ["0", "1"] };
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        try {
          ok(response.set(headers) instanceof BindenResponse);
        } catch (error) {
          reject(error);
        } finally {
          response.end(resolve);
        }
      });
    });
    const response = await fetch(url);
    await serverPromise;

    deepEqual(response.headers.get(x), headers[x].toString());
    deepEqual(response.headers.get(y), headers[y]);
    deepEqual(response.headers.get(z), headers[z].join(", "));
  });

  it(".send()", async () => {
    const cookie1 = new Cookie({ key: "__Secure-K1", value: "V1" });
    const cookie2 = new Cookie({ key: "__Host-K2", value: "V2" });
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        response.setHeader("Set-Cookie", [cookie1.toString()]);
        response.cookies.add(cookie2);
        response.send().then(resolve).catch(reject);
      });
    });
    const response = await fetch(url);
    await serverPromise;
    await response.text();

    deepEqual(response.headers.get("Content-Type"), null);
    deepEqual(
      response.headers.get("Set-Cookie"),
      [cookie1, cookie2].map((c) => c.toString()).join(", "),
    );
    ok(response.ok);
  });

  it(".send() (`writableEnded === true`)", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        response.end(() => {
          try {
            deepEqual(response.writableEnded, true);
            response.send().then(resolve).catch(reject);
          } catch (error) {
            reject(error);
          }
        });
      });
    });
    const response = await fetch(url);
    await serverPromise;
    await response.text();

    deepEqual(response.headers.get("Content-Type"), null);
    ok(response.ok);
  });

  it(".send() (with encoding)", async () => {
    const cookie1 = new Cookie({ key: "__Secure-K1", value: "V1" });
    const cookie2 = new Cookie({ key: "__Host-K2", value: "V2" });
    const string = "Hello World!";
    const encoding = "base64";
    const encoded = Buffer.from(string).toString(encoding);
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        response.setHeader("Set-Cookie", cookie1.toString());
        response.cookies.add(cookie2);
        response.send(encoded, encoding).then(resolve).catch(reject);
      });
    });
    const response = await fetch(url);
    await serverPromise;
    const data = await response.text();

    deepEqual(response.headers.get("Content-Type"), ct_text);
    deepEqual(
      response.headers.get("Set-Cookie"),
      [cookie1, cookie2].map((c) => c.toString()).join(", "),
    );
    deepEqual(data, string);
  });

  it(".send() (Buffer)", async () => {
    const cookie1 = new Cookie({ key: "__Secure-K1", value: "V1" });
    const cookie2 = new Cookie({ key: "__Host-K2", value: "V2" });
    const string = "Hello World!";
    const buffer = Buffer.from(string);

    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        response.cookies.add(cookie1).add(cookie2);
        response.send(buffer).then(resolve).catch(reject);
      });
    });
    const response = await fetch(url);
    await serverPromise;

    const data = Buffer.from(await response.arrayBuffer());

    deepEqual(response.headers.get("Content-Type"), ct_text);
    deepEqual(
      response.headers.get("Set-Cookie"),
      [cookie1, cookie2].map((c) => c.toString()).join(", "),
    );
    deepEqual(data, buffer);
  });

  it(".send() (number)", async () => {
    const number = 1;
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        response.send(number).then(resolve).catch(reject);
      });
    });
    const response = await fetch(url);
    await serverPromise;
    const data = await response.text();

    deepEqual(response.headers.get("Content-Type"), ct_text);
    deepEqual(data, number.toString());
  });

  it(".send() (bigint)", async () => {
    const bigint = 1n;
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        response.send(bigint).then(resolve).catch(reject);
      });
    });
    const response = await fetch(url);
    await serverPromise;
    const data = await response.text();

    deepEqual(response.headers.get("Content-Type"), ct_text);
    deepEqual(data, bigint.toString());
  });

  it(".json()", async () => {
    const json = { currency: "💶" };
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        response.json(json).then(resolve).catch(reject);
      });
    });
    const response = await fetch(url);
    await serverPromise;
    const data = (await response.json()) as unknown;

    deepEqual(response.headers.get("Content-Type"), ct_json);
    deepEqual(data, json);
  });

  it(".json() (an array)", async () => {
    const json = [1, "2", { currency: "💶" }];
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        response.json(json).then(resolve).catch(reject);
      });
    });
    const response = await fetch(url);
    await serverPromise;
    const data = (await response.json()) as unknown;

    deepEqual(response.headers.get("Content-Type"), ct_json);
    deepEqual(data, json);
  });

  it(".json() (with a custom `stringify`)", async () => {
    const json = { currency: "💶", value: 120 };
    const stringify = fastJSON({
      title: "Example Schema",
      type: "object",
      properties: {
        currency: {
          type: "string",
        },
        value: {
          type: "integer",
        },
      },
      required: ["currency", "value"],
      additionalProperties: false,
    });
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        response.json(json, stringify).then(resolve).catch(reject);
      });
    });
    const response = await fetch(url);
    await serverPromise;
    const data = (await response.json()) as unknown;

    deepEqual(response.headers.get("Content-Type"), ct_json);
    deepEqual(data, json);
  });

  it(".text()", async () => {
    const text = "😀";
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        response.text(text).then(resolve).catch(reject);
      });
    });
    const response = await fetch(url);
    await serverPromise;
    const data = await response.text();

    deepEqual(response.headers.get("Content-Type"), ct_text);
    deepEqual(data, text);
  });

  it(".html()", async () => {
    const html = "<html></html>";
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        response.html(html).then(resolve).catch(reject);
      });
    });
    const response = await fetch(url);
    await serverPromise;
    const data = await response.text();

    deepEqual(response.headers.get("Content-Type"), ct_html);
    deepEqual(data, html);
  });

  it(".form()", async () => {
    const form = new URLSearchParams();
    form.append("1", "2");
    form.set("0", "1");
    form.append("1", "3");
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        response.form(form).then(resolve).catch(reject);
      });
    });
    const response = await fetch(url);
    await serverPromise;
    const data = await response.text();

    deepEqual(response.headers.get("Content-Type"), ct_form);
    deepEqual(new URLSearchParams(data), form);
  });

  it(".sendFile()", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        response
          .sendFile(filePath, file_stats)
          .catch(reject)
          .finally(() => response.end(resolve));
      });
    });
    const response = await fetch(url);
    deepEqual(response.status, 200);
    await serverPromise;
    const data = Buffer.from(await response.arrayBuffer());

    deepEqual(data, msg);
  });

  it(".sendFile() (304 response with `If-Modified-Since`)", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        response
          .sendFile(filePath, file_stats)
          .then(() => {
            server.once("request", (_request2, response2) => {
              response2.sendFile(filePath).then(resolve).catch(reject);
            });
          })
          .catch(reject);
      });
    });

    const response = await fetch(url);
    const lm = response.headers.get("Last-Modified");
    ok(lm);
    ok(!Number.isNaN(Date.parse(lm)));
    deepEqual(response.status, 200);

    const data = Buffer.from(await response.arrayBuffer());
    deepEqual(data, msg);

    const headers = { "If-Modified-Since": lm };
    const response2 = await fetch(url, { headers });
    deepEqual(response2.status, 304);

    const data2 = await response2.text();
    deepEqual(data2, "");

    await serverPromise;
  });

  it(".sendFile() (304 response with `If-Modified-Since` HEAD)", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        response
          .sendFile(filePath, file_stats)
          .then(() => {
            server.once("request", (_request2, response2) => {
              response2.sendFile(filePath).then(resolve).catch(reject);
            });
          })
          .catch(reject);
      });
    });

    const response = await fetch(url, { method: "HEAD" });
    const lm = response.headers.get("Last-Modified");
    ok(lm);
    ok(!Number.isNaN(Date.parse(lm)));
    deepEqual(response.status, 200);

    const data = await response.text();
    deepEqual(data, "");

    const headers = { "If-Modified-Since": lm };
    const response2 = await fetch(url, { headers });
    deepEqual(response2.status, 304);

    const data2 = await response2.text();
    deepEqual(data2, "");

    await serverPromise;
  });

  it(".sendFile() (416 response with invalid `Range`)", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        response
          .sendFile(filePath, file_stats)
          .catch(reject)
          .finally(() => response.end(resolve));
      });
    });

    const range = `bytes=${msg.byteLength}-`;
    const response = await fetch(url, { headers: { Range: range } });
    deepEqual(response.status, 416);
    const cr = response.headers.get("Content-Range");
    deepEqual(cr, `bytes */${msg.byteLength}`);

    await serverPromise;
    const data = await response.text();
    deepEqual(data, "");
  });

  it(".sendFile() (Partial response with `Range`)", async () => {
    const start = 10;
    const end = 20;
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        response
          .sendFile(filePath, file_stats)
          .catch(reject)
          .finally(() => response.end(resolve));
      });
    });
    const headers = { Range: `bytes= ${start} - ${end} ` };
    const response = await fetch(url, { headers });
    const cr = response.headers.get("Content-Range");
    deepEqual(cr, `bytes ${start}-${end}/${msg.byteLength}`);
    deepEqual(response.status, 206);

    await serverPromise;
    const data = Buffer.from(await response.arrayBuffer());
    deepEqual(data, msg.subarray(start, end + 1));
  });

  it(".sendFile() (Full response with invalid `If-Range`)", async () => {
    const start = 10;
    const end = 20;
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        response
          .sendFile(filePath, file_stats)
          .catch(reject)
          .finally(() => response.end(resolve));
      });
    });
    const headers = {
      Range: `bytes= ${start} - ${end} `,
      "If-Range": `${new Date(file_stats.mtimeMs - 10000).toUTCString()}`,
    };
    const response = await fetch(url, { headers });
    deepEqual(response.headers.get("Content-Range"), null);
    deepEqual(response.status, 200);

    await serverPromise;
    const data = Buffer.from(await response.arrayBuffer());
    deepEqual(data, msg);
  });

  it(".sendFile() (Partial response with suffix length)", async () => {
    const end = 20;
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        response
          .sendFile(filePath, file_stats)
          .catch(reject)
          .finally(() => response.end(resolve));
      });
    });
    const headers = { Range: `bytes=  - ${end} ` };
    const response = await fetch(url, { headers });
    await serverPromise;
    const data = Buffer.from(await response.arrayBuffer());
    const cr = response.headers.get("Content-Range");
    deepEqual(
      cr,
      `bytes ${msg.byteLength - end}-${msg.byteLength - 1}/${msg.byteLength}`,
    );
    deepEqual(response.status, 206);
    deepEqual(data, msg.subarray(msg.byteLength - end));
  });

  it(".sendFile() (`this.req instanceof BindenRequest`)", async () => {
    const newServer = createServer({
      ServerResponse: BindenResponse,
      IncomingMessage: BindenRequest,
    });

    await new Promise<void>((resolve) => {
      newServer.listen(port + 1, resolve);
    });

    const end = 100;
    const serverPromise = new Promise<void>((resolve, reject) => {
      newServer.once("request", (_request, response) => {
        response
          .sendFile(filePath)
          .catch(reject)
          .finally(() => response.end(resolve));
      });
    });
    const headers = { Range: `bytes=  - ${end} ` };
    const response = await fetch(`http://localhost:${port + 1}`, { headers });
    await serverPromise;
    const data = Buffer.from(await response.arrayBuffer());
    deepEqual(response.headers.get("Content-Range"), null);
    deepEqual(response.status, 200);
    deepEqual(data, msg.subarray(msg.byteLength - end));
    await new Promise<void>((resolve, reject) => {
      newServer.closeIdleConnections();
      newServer.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  });

  it(".sendFile() (with `URL`)", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        response
          .sendFile(filePath, file_stats)
          .catch(reject)
          .finally(() => response.end(resolve));
      });
    });
    const response = await fetch(url);
    await serverPromise;
    const data = await response.text();
    deepEqual(data, msg.toString());
  });

  it(".sendFile() (with invalid protocol)", async () => {
    const path = new URL("https:/www.example.com/");
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        rejects(
          () => response.sendFile(path, file_stats),
          new TypeError(`Protocol ${path.protocol} is not supported`),
        )
          .catch(reject)
          .finally(() => response.end(resolve));
      });
    });
    await fetch(url);
    await serverPromise;
  });

  it(".sendFile() (not a regular file)", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        rejects(
          () => response.sendFile(dirPath, dir_stats),
          new Error(`Provided path does not correspond to a regular file`),
        )
          .catch(reject)
          .finally(() => response.end(resolve));
      });
    });
    await fetch(url);
    await serverPromise;
  });

  afterEach(async () => {
    await rmdir(dirPath);
    await rm(filePath);
    await new Promise<void>((resolve, reject) => {
      server.closeIdleConnections();
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
