/* eslint-disable init-declarations */
import { deepStrictEqual, ok, throws, rejects } from "node:assert";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { writeFile, rm, mkdir, rmdir, stat } from "node:fs/promises";
import { IncomingMessage, Server, createServer, get } from "node:http";
import { type AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import fastJSON from "fast-json-stringify";
import fetch from "node-fetch";
import type { Stats } from "node:fs";
import { Readable } from "node:stream";
import { afterEach, beforeEach, suite, test } from "node:test";

import {
  BindenResponse,
  BindenRequest,
  Cookie,
  ct_json,
  ct_text,
  ct_form,
  ct_html,
} from "../index.js";

const port = 8080;
const url = `http://localhost:${port}`;

/** Requests `url` and goes away after the first chunk of the response body */
function abortAfterFirstChunk(): Promise<void> {
  return new Promise<void>((resolve) => {
    get(url, (response) => {
      response.once("data", () => {
        response.destroy();
        resolve();
      });
    }).on("error", () => {
      // The request is aborted on purpose
    });
  });
}

/** The error codes of a `send()` to a client that went away */
const gone = new Set(["EPIPE", "ECONNRESET", "ERR_STREAM_PREMATURE_CLOSE"]);

/** The error code of a settled `send()` (`null` when it has resolved) */
function settle(promise: Promise<void>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => (error as { code?: unknown }).code,
  );
}

suite("BindenResponse", () => {
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
      }).listen(port, () => {
        resolve();
      });
    });
    dir_stats = await stat(dirPath);
    file_stats = await stat(filePath);
  });

  test("ServerResponse", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        try {
          deepStrictEqual(response instanceof BindenResponse, true);
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

  test(".status()", async () => {
    const status = 401;
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        try {
          ok(response.status(status) instanceof BindenResponse);
          deepStrictEqual(response.statusCode, status);
        } catch (error) {
          reject(error);
        } finally {
          response.end(resolve);
        }
      });
    });
    const response = await fetch(url);
    await serverPromise;

    deepStrictEqual(response.status, status);
  });

  test(".status() (throws TypeError with unsupported code)", async () => {
    const status = 499;
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        try {
          throws(
            () => response.status(status),
            new TypeError(`Status code ${status} is invalid`),
          );
          deepStrictEqual(response.statusCode, 200);
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

  test(".set()", async () => {
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

    deepStrictEqual(response.headers.get(x), headers[x].toString());
    deepStrictEqual(response.headers.get(y), headers[y]);
    deepStrictEqual(response.headers.get(z), headers[z].join(", "));
  });

  test(".send()", async () => {
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

    deepStrictEqual(response.headers.get("Content-Type"), null);
    deepStrictEqual(
      response.headers.get("Set-Cookie"),
      [cookie1, cookie2].map((c) => c.toString()).join(", "),
    );
    ok(response.ok);
  });

  test(".send() (`writableEnded === true`)", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        response.end(() => {
          try {
            deepStrictEqual(response.writableEnded, true);
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

    deepStrictEqual(response.headers.get("Content-Type"), null);
    ok(response.ok);
  });

  test(".send() (with encoding)", async () => {
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

    deepStrictEqual(response.headers.get("Content-Type"), ct_text);
    deepStrictEqual(
      response.headers.get("Set-Cookie"),
      [cookie1, cookie2].map((c) => c.toString()).join(", "),
    );
    deepStrictEqual(data, string);
  });

  test(".send() (Buffer)", async () => {
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

    deepStrictEqual(response.headers.get("Content-Type"), ct_text);
    deepStrictEqual(
      response.headers.get("Set-Cookie"),
      [cookie1, cookie2].map((c) => c.toString()).join(", "),
    );
    deepStrictEqual(data, buffer);
  });

  test(
    ".send() (rejects when the response has been destroyed)",
    { timeout: 10_000 },
    async () => {
      const settled = new Promise<unknown>((resolve) => {
        server.once("request", (_request, response) => {
          response.destroy();
          resolve(settle(response.send("data")));
        });
      });
      get(url).on("error", () => {
        // The response is destroyed on purpose
      });

      deepStrictEqual(await settled, "ERR_STREAM_PREMATURE_CLOSE");
    },
  );

  test(".started", async () => {
    // Without a connection: nothing is actually sent
    const create = (): BindenResponse =>
      new BindenResponse(new IncomingMessage(new Socket()));

    const sent = create();
    ok(!sent.started);
    sent.send("data").catch(() => {
      // Never settles without a connection
    });
    ok(sent.started);

    const piped = create();
    Readable.from(["data"]).pipe(piped);
    ok(piped.started);

    // A `sendFile()` that fails before sending anything does not start it
    const failed = create();
    await rejects(() => failed.sendFile(dirPath, dir_stats));
    ok(!failed.started);
  });

  test(".send() (settles with the events of the response)", async () => {
    // Without a connection, `finish` never comes: the events are emitted here
    const create = (): BindenResponse =>
      new BindenResponse(new IncomingMessage(new Socket()));

    // Ended, but not flushed to the connection: the close is premature
    const ended = create();
    const sent = ended.send("data");
    ended.emit("close");
    deepStrictEqual(await settle(sent), "ERR_STREAM_PREMATURE_CLOSE");

    const finished = create();
    const finishing = finished.send("data");
    finished.emit("finish");
    deepStrictEqual(await settle(finishing), null);

    const failed = create();
    const failing = failed.send("data");
    failed.emit(
      "error",
      Object.assign(new Error("Failed"), { code: "EFAILED" }),
    );
    deepStrictEqual(await settle(failing), "EFAILED");

    const unknown = create();
    const unknownSent = unknown.send("data");
    unknown.emit("error");
    deepStrictEqual(await settle(unknownSent), "ERR_STREAM_PREMATURE_CLOSE");
    deepStrictEqual(unknown.listenerCount("close"), 0);
  });

  test(
    ".send() (resolves once the client has the whole `Content-Length`)",
    { timeout: 10_000 },
    async () => {
      // The source ends only after the client has the body (and has closed
      // the connection): that close is not premature
      const stream = new Readable({
        read(): void {
          // The data is pushed below
        },
      });
      stream.push("data");
      const timer = setTimeout(() => {
        stream.push(null);
      }, 500);
      const settled = new Promise<unknown>((resolve) => {
        server.once("request", (_request, response) => {
          response.setHeader("Content-Length", 4);
          resolve(settle(response.send(stream)));
        });
      });
      const body = await new Promise<string>((resolve) => {
        get(url, (response) => {
          let text = "";
          response
            .setEncoding("utf8")
            .on("data", (chunk: string) => {
              text += chunk;
            })
            .once("end", () => {
              resolve(text);
            });
        });
      });

      deepStrictEqual(body, "data");
      deepStrictEqual(await settled, null);
      ok(stream.destroyed);
      clearTimeout(timer);
    },
  );

  test(
    ".send() (rejects when the client goes away before the flush)",
    { timeout: 10_000 },
    async () => {
      // One chunk with the whole `Content-Length`: read at once, but not sent
      const size = 64 * 1024 * 1024;
      const stream = Readable.from([Buffer.alloc(size)]);
      const settled = new Promise<unknown>((resolve) => {
        server.once("request", (_request, response) => {
          response.setHeader("Content-Length", size);
          resolve(settle(response.send(stream)));
        });
      });
      await abortAfterFirstChunk();

      // The write fails (or the response closes) before the chunk is flushed
      const code = await settled;
      ok(gone.has(code as string), String(code));
      ok(stream.destroyed);
    },
  );

  test(
    ".send() (pauses a `Readable` while the client does not read)",
    { timeout: 10_000 },
    async () => {
      const chunk = Buffer.alloc(1024 * 1024);
      let left = 64;
      const stream = new Readable({
        read(): void {
          left -= 1;
          this.push(left >= 0 ? chunk : null);
        },
      });
      const settled = new Promise<unknown>((resolve) => {
        server.once("request", (_request, response) => {
          resolve(settle(response.send(stream)));
        });
      });
      const response = await new Promise<IncomingMessage>((resolve) => {
        get(url, resolve);
      });
      response.pause();
      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });

      // The connection is full: the source waits for `drain`
      deepStrictEqual(stream.readableFlowing, false);
      ok(left > 0);

      let received = 0;
      for await (const data of response) {
        received += (data as Buffer).byteLength;
      }
      deepStrictEqual(received, 64 * chunk.byteLength);
      deepStrictEqual(await settled, null);
    },
  );

  test(".send() (rejects a `Readable` of objects)", async () => {
    const stream = Readable.from([{ not: "a chunk" }]);
    const settled = new Promise<unknown>((resolve) => {
      server.once("request", (_request, response) => {
        resolve(settle(response.send(stream)));
        response.once("close", () => {
          // The test ends the connection below
        });
      });
    });
    const request = get(url).on("error", () => {
      // The connection is closed below
    });

    deepStrictEqual(await settled, "ERR_INVALID_ARG_TYPE");
    ok(stream.destroyed);
    request.destroy();
  });

  test(".send() (a `Readable` without its whole `Content-Length`)", async () => {
    // Without a connection: the events are emitted here
    const create = (method: string): BindenResponse =>
      new BindenResponse(
        Object.assign(new IncomingMessage(new Socket()), { method }),
      );
    const source = (): Readable => {
      const stream = new Readable({
        read(): void {
          // The data is pushed below
        },
      });
      stream.push("data");
      return stream;
    };

    const partial = create("GET");
    partial.setHeader("Content-Length", 8);
    const sent = partial.send(source());
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    partial.emit("close");
    deepStrictEqual(await settle(sent), "ERR_STREAM_PREMATURE_CLOSE");
  });

  test(".send() (`HEAD`: the headers of the body only)", async () => {
    // Node.js rejects any body of a response to `HEAD` with this option
    const strict = createServer(
      { ServerResponse: BindenResponse, rejectNonStandardBodyWrites: true },
      (_request, response) => {
        response.send("hello").catch(() => {
          // The test fails on the response instead
        });
      },
    ).listen(0);
    await once(strict, "listening");
    const { port: local } = strict.address() as AddressInfo;

    try {
      const response = await fetch(`http://localhost:${local}`, {
        method: "HEAD",
        signal: AbortSignal.timeout(5000),
      });

      deepStrictEqual(response.status, 200);
      deepStrictEqual(response.headers.get("Content-Length"), "5");
      deepStrictEqual(response.headers.get("Content-Type"), ct_text);
      deepStrictEqual(await response.text(), "");
    } finally {
      strict.closeAllConnections();
      strict.close();
    }
  });

  test(".send() (a `Readable` is not read without a body)", async () => {
    const check = async (method: string, status: number): Promise<void> => {
      let reads = 0;
      const source = new Readable({
        read(): void {
          reads += 1;
          this.push(null);
        },
      });
      const settled = new Promise<unknown>((resolve) => {
        server.once("request", (_request, response) => {
          resolve(settle(response.status(status).send(source)));
        });
      });

      const response = await fetch(url, { method });

      deepStrictEqual(response.status, status);
      deepStrictEqual(await response.text(), "");
      deepStrictEqual(await settled, null);
      deepStrictEqual(reads, 0, `${method} ${status}`);
      ok(source.destroyed);
    };

    // HEAD, 1xx, 204, 205 and 304 responses have no body
    await check("HEAD", 200);
    await check("GET", 204);
    await check("GET", 205);
    await check("GET", 304);
  });

  test(
    ".send() (destroys a `Readable` when the client goes away)",
    { timeout: 10_000 },
    async () => {
      const chunk = Buffer.alloc(64 * 1024);
      // A long source (256 MiB): the client goes away long before its end.
      // Bounded, so that a source that is not destroyed fails the test instead
      // of keeping it busy forever.
      let left = 4096;
      const stream = new Readable({
        read(): void {
          left -= 1;
          this.push(left > 0 ? chunk : null);
        },
      });
      const settled = new Promise<unknown>((resolve) => {
        server.once("request", (_request, response) => {
          resolve(settle(response.send(stream)));
        });
      });
      await abortAfterFirstChunk();

      const code = await settled;
      ok(gone.has(code as string), String(code));
      ok(stream.destroyed && !stream.readableEnded);
    },
  );

  test(".send() (number)", async () => {
    const number = 1;
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        response.send(number).then(resolve).catch(reject);
      });
    });
    const response = await fetch(url);
    await serverPromise;
    const data = await response.text();

    deepStrictEqual(response.headers.get("Content-Type"), ct_text);
    deepStrictEqual(data, number.toString());
  });

  test(".send() (bigint)", async () => {
    const bigint = 1n;
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        response.send(bigint).then(resolve).catch(reject);
      });
    });
    const response = await fetch(url);
    await serverPromise;
    const data = await response.text();

    deepStrictEqual(response.headers.get("Content-Type"), ct_text);
    deepStrictEqual(data, bigint.toString());
  });

  test(".json()", async () => {
    const json = { currency: "💶" };
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        response.json(json).then(resolve).catch(reject);
      });
    });
    const response = await fetch(url);
    await serverPromise;
    const data = await response.json();

    deepStrictEqual(response.headers.get("Content-Type"), ct_json);
    deepStrictEqual(data, json);
  });

  test(".json() (an array)", async () => {
    const json = [1, "2", { currency: "💶" }];
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        response.json(json).then(resolve).catch(reject);
      });
    });
    const response = await fetch(url);
    await serverPromise;
    const data = await response.json();

    deepStrictEqual(response.headers.get("Content-Type"), ct_json);
    deepStrictEqual(data, json);
  });

  test(".json() (with a custom `stringify`)", async () => {
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
    const data = await response.json();

    deepStrictEqual(response.headers.get("Content-Type"), ct_json);
    deepStrictEqual(data, json);
  });

  test(".text()", async () => {
    const text = "😀";
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        response.text(text).then(resolve).catch(reject);
      });
    });
    const response = await fetch(url);
    await serverPromise;
    const data = await response.text();

    deepStrictEqual(response.headers.get("Content-Type"), ct_text);
    deepStrictEqual(data, text);
  });

  test(".html()", async () => {
    const html = "<html></html>";
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        response.html(html).then(resolve).catch(reject);
      });
    });
    const response = await fetch(url);
    await serverPromise;
    const data = await response.text();

    deepStrictEqual(response.headers.get("Content-Type"), ct_html);
    deepStrictEqual(data, html);
  });

  test(".form()", async () => {
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

    deepStrictEqual(response.headers.get("Content-Type"), ct_form);
    deepStrictEqual(new URLSearchParams(data), form);
  });

  test(".sendFile()", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        response
          .sendFile(filePath, file_stats)
          .catch(reject)
          .finally(() => response.end(resolve));
      });
    });
    const response = await fetch(url);
    deepStrictEqual(response.status, 200);
    await serverPromise;
    const data = Buffer.from(await response.arrayBuffer());

    deepStrictEqual(data, msg);
  });

  test(".sendFile() (304 response with `If-Modified-Since`)", async () => {
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
    ok(lm !== null);
    ok(!Number.isNaN(Date.parse(lm)));
    deepStrictEqual(response.status, 200);

    const data = Buffer.from(await response.arrayBuffer());
    deepStrictEqual(data, msg);

    const headers = { "If-Modified-Since": lm };
    const response2 = await fetch(url, { headers });
    deepStrictEqual(response2.status, 304);

    const data2 = await response2.text();
    deepStrictEqual(data2, "");

    await serverPromise;
  });

  test(".sendFile() (304 response with `If-Modified-Since` HEAD)", async () => {
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
    ok(lm !== null);
    ok(!Number.isNaN(Date.parse(lm)));
    deepStrictEqual(response.status, 200);

    const data = await response.text();
    deepStrictEqual(data, "");

    const headers = { "If-Modified-Since": lm };
    const response2 = await fetch(url, { headers });
    deepStrictEqual(response2.status, 304);

    const data2 = await response2.text();
    deepStrictEqual(data2, "");

    await serverPromise;
  });

  test(".sendFile() (416 response with invalid `Range`)", async () => {
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
    deepStrictEqual(response.status, 416);
    const cr = response.headers.get("Content-Range");
    deepStrictEqual(cr, `bytes */${msg.byteLength}`);

    await serverPromise;
    const data = await response.text();
    deepStrictEqual(data, "");
  });

  test(".sendFile() (Partial response with `Range`)", async () => {
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
    deepStrictEqual(cr, `bytes ${start}-${end}/${msg.byteLength}`);
    deepStrictEqual(response.status, 206);

    await serverPromise;
    const data = Buffer.from(await response.arrayBuffer());
    deepStrictEqual(data, msg.subarray(start, end + 1));
  });

  test(".sendFile() (Full response with invalid `If-Range`)", async () => {
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
    deepStrictEqual(response.headers.get("Content-Range"), null);
    deepStrictEqual(response.status, 200);

    await serverPromise;
    const data = Buffer.from(await response.arrayBuffer());
    deepStrictEqual(data, msg);
  });

  test(".sendFile() (Partial response with suffix length)", async () => {
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
    deepStrictEqual(
      cr,
      `bytes ${msg.byteLength - end}-${msg.byteLength - 1}/${msg.byteLength}`,
    );
    deepStrictEqual(response.status, 206);
    deepStrictEqual(data, msg.subarray(msg.byteLength - end));
  });

  test(".sendFile() (`this.req instanceof BindenRequest`)", async () => {
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
    try {
      const response = await fetch(`http://localhost:${port + 1}`, {
        headers,
      });
      await serverPromise;
      const data = Buffer.from(await response.arrayBuffer());
      deepStrictEqual(response.headers.get("Content-Range"), null);
      deepStrictEqual(response.status, 200);
      deepStrictEqual(data, msg.subarray(msg.byteLength - end));
    } finally {
      // Also on a failure: a server left open keeps the test process alive
      newServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        newServer.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  });

  test(".sendFile() (HEAD)", async () => {
    const check = async (headers: Record<string, string>): Promise<void> => {
      const serverPromise = new Promise<void>((resolve, reject) => {
        server.once("request", (_request, response) => {
          response.sendFile(filePath).then(resolve, reject);
        });
      });

      const response = await fetch(url, { method: "HEAD", headers });
      await serverPromise;

      // The headers of the whole file, without a body
      deepStrictEqual(response.status, 200);
      deepStrictEqual(
        response.headers.get("Content-Length"),
        `${msg.byteLength}`,
      );
      deepStrictEqual(response.headers.get("Content-Range"), null);
      deepStrictEqual(await response.text(), "");
    };

    await check({});
    // A range applies to GET only
    await check({ Range: "bytes=0-9" });
  });

  test(".sendFile() (with `URL`)", async () => {
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
    deepStrictEqual(data, msg.toString());
  });

  test(".sendFile() (with invalid protocol)", async () => {
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

  test(".sendFile() (not a regular file)", async () => {
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
    server.closeAllConnections();
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
