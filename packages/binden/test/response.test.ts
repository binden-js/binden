/* eslint-disable init-declarations */
import { deepStrictEqual, ok, throws, rejects } from "node:assert";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { writeFile, rm, mkdir, mkdtemp, stat } from "node:fs/promises";
import { IncomingMessage, Server, createServer, get } from "node:http";
import { type AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastJSON from "fast-json-stringify";
import fetch from "node-fetch";
import { createReadStream, type Stats } from "node:fs";
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

/** The port of a listening server */
function portOf(server: { address(): unknown }): number {
  return (server.address() as AddressInfo).port;
}

let url = "";

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

/**
 * The error codes of a `send()` to a client that went away: a write fails
 * (`ECANCELED` when the socket is closed while it is pending, `ECONNABORTED` on
 * Windows), or the response is closed before it finishes
 */
const gone = new Set([
  "ECANCELED",
  "ECONNABORTED",
  "ECONNRESET",
  "EPIPE",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

/** The error code of a settled `send()` (`null` when it has resolved) */
function settle(promise: Promise<void>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => (error as { code?: unknown }).code,
  );
}

/** The status line, the headers and the body of a raw response */
interface IRawResponse {
  status: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * Sends a raw request to `url` on a connection that the server closes after its
 * response, and reads the response as it is on the wire
 */
async function exchange(method = "GET", headers = ""): Promise<IRawResponse> {
  const { hostname, port } = new URL(url);
  const socket = new Socket();
  socket.setEncoding("latin1");
  let data = "";
  socket.on("data", (chunk: string) => {
    data += chunk;
  });
  socket.connect(Number(port), hostname);
  socket.write(
    `${method} / HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n${headers}\r\n`,
  );
  await once(socket, "close");
  const [head = "", ...rest] = data.split("\r\n\r\n");
  const [status = "", ...lines] = head.split("\r\n");
  return {
    status,
    headers: Object.fromEntries(
      lines.map((line) => {
        const index = line.indexOf(":");
        return [
          line.slice(0, index).toLowerCase(),
          line.slice(index + 1).trim(),
        ];
      }),
    ),
    body: rest.join("\r\n\r\n"),
  };
}

suite("BindenResponse", () => {
  // A new directory for every test
  let root: string;
  let filePath: string;
  let dirPath: string;
  let msg: Buffer;
  let server: Server<typeof IncomingMessage, typeof BindenResponse>;
  let file_stats: Stats;
  let dir_stats: Stats;

  beforeEach(async () => {
    msg = Buffer.from(randomUUID());
    root = await mkdtemp(join(tmpdir(), "binden-response-"));
    filePath = join(root, "file");
    dirPath = join(root, "dir");
    await mkdir(dirPath);
    await writeFile(filePath, msg);
    await new Promise<void>((resolve) => {
      server = createServer<typeof IncomingMessage, typeof BindenResponse>({
        ServerResponse: BindenResponse,
      }).listen(0, () => {
        url = `http://localhost:${portOf(server)}`;
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
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        try {
          for (const status of [99, 600, 200.5, Number.NaN, "200"]) {
            throws(
              () => response.status(status as number),
              new TypeError(`Status code ${status} is invalid`),
            );
          }
          deepStrictEqual(response.statusCode, 200);
          // Any status code from 100 to 599, registered or not
          for (const status of [100, 430, 499, 599]) {
            deepStrictEqual(response.status(status).statusCode, status);
          }
          response.status(200);
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

  test(".set() (own properties only)", async () => {
    // E.g. a polluted `Object.prototype`
    const headers = Object.assign(
      Object.create({ "X-Inherited": "1" }) as Record<string, string>,
      { "X-Own": "2" },
    );
    server.once("request", (_request, response) => {
      response.set(headers).end();
    });
    const response = await fetch(url);
    await response.text();

    deepStrictEqual(response.headers.get("X-Own"), "2");
    deepStrictEqual(response.headers.get("X-Inherited"), null);
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

  test(".send() (`writableEnded === true` releases a `Readable`)", async () => {
    const source = createReadStream(filePath);
    const settled = new Promise<unknown>((resolve) => {
      server.once("request", (_request, response) => {
        response.end(() => {
          resolve(settle(response.send(source)));
        });
      });
    });
    await (await fetch(url)).text();

    deepStrictEqual(await settled, null);
    // Its file is closed
    ok(source.destroyed);
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
    {
      // Windows takes a whole write while its send buffer has room: the chunk
      // is flushed to the connection at once
      skip: process.platform === "win32",
      timeout: 10_000,
    },
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
    ".send() (rejects a `Buffer` when the client goes away before the flush)",
    {
      // Windows takes a whole write while its send buffer has room
      skip: process.platform === "win32",
      timeout: 10_000,
    },
    async () => {
      const size = 64 * 1024 * 1024;
      const settled = new Promise<unknown>((resolve) => {
        server.once("request", (_request, response) => {
          resolve(settle(response.send(Buffer.alloc(size))));
        });
      });
      await abortAfterFirstChunk();

      // Node.js 24 emits `finish` although the write has failed
      const code = await settled;
      ok(gone.has(code as string), String(code));
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

  test(".send() (a `Readable` that fails before sending can be replied)", async () => {
    const check = async (
      source: Readable,
      length: number | null,
      error: string,
    ): Promise<void> => {
      const replied = new Promise<unknown>((resolve) => {
        server.once("request", (_request, response) => {
          if (length !== null) {
            response.setHeader("Content-Length", length);
          }
          resolve(
            settle(response.send(source)).then(async (code) => {
              const { started } = response;
              await response.status(500).send("replied");
              return { code, started };
            }),
          );
        });
      });
      const response = await fetch(url);

      deepStrictEqual(await response.text(), "replied");
      deepStrictEqual(await replied, { code: error, started: false });
    };

    // Closed (without an error) before its end
    const closed = new Readable({
      read(): void {
        this.destroy();
      },
    });
    await check(closed, null, "ERR_STREAM_PREMATURE_CLOSE");
    // More than its `Content-Length` at once
    await check(Readable.from(["abc"]), 2, "ERR_HTTP_CONTENT_LENGTH_MISMATCH");
  });

  test(".send() (a `Readable` that fails after a part of the body cuts the response)", async () => {
    const check = async (
      source: Readable,
      length: number | null,
      error: string,
    ): Promise<void> => {
      const settled = new Promise<unknown>((resolve) => {
        server.once("request", (_request, response) => {
          if (length !== null) {
            response.setHeader("Content-Length", length);
          }
          resolve(settle(response.send(source)));
        });
      });
      // The truncated body is not complete for the client (which may not
      // even get the headers)
      const complete = await new Promise<boolean>((resolve) => {
        get(url, (response) => {
          response.resume().once("close", () => {
            resolve(response.complete);
          });
        }).on("error", () => {
          resolve(false);
        });
      });

      deepStrictEqual(complete, false);
      deepStrictEqual(await settled, error);
    };

    let reads = 0;
    const closed = new Readable({
      read(): void {
        reads += 1;
        if (reads === 1) {
          this.push("partial-");
        } else {
          this.destroy();
        }
      },
    });
    await check(closed, null, "ERR_STREAM_PREMATURE_CLOSE");
    // Less than its `Content-Length`
    await check(Readable.from(["abc"]), 10, "ERR_HTTP_CONTENT_LENGTH_MISMATCH");
    // More than its `Content-Length` (the rest would be the next response)
    await check(
      Readable.from(["ab", "cde"]),
      4,
      "ERR_HTTP_CONTENT_LENGTH_MISMATCH",
    );
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

  test(".send() (frames the response by its final status)", async () => {
    const framing = ["content-length", "content-type", "transfer-encoding"];
    const check = async (
      method: string,
      reply: (response: BindenResponse) => Promise<void>,
      expected: Record<string, string>,
      body = "",
    ): Promise<void> => {
      const replied = new Promise<void>((resolve, reject) => {
        server.once("request", (_request, response) => {
          reply(response).then(resolve, reject);
        });
      });
      const response = await exchange(method);
      await replied;
      const { headers } = response;
      const sent = framing
        .filter((name) => name in headers)
        .map((name) => [name, headers[name]]);
      deepStrictEqual(
        { ...Object.fromEntries(sent), body: response.body },
        { ...expected, body },
        `${method} ${response.status}`,
      );
    };
    const text = { "content-type": ct_text };
    const stale = { "Content-Length": 99, "Transfer-Encoding": "chunked" };

    // Never a body, nor the length of one
    await check("GET", (r) => r.set(stale).status(204).send(), {});
    await check("GET", (r) => r.status(204).send("data"), {});
    await check("GET", (r) => r.set(stale).status(304).send(), {});
    // No content, framed as such
    await check("GET", (r) => r.set(stale).status(205).send("hello world"), {
      "content-length": "0",
    });
    // The length of the body, whatever was set before
    await check(
      "GET",
      (r) => r.set(stale).send("abc"),
      { ...text, "content-length": "3" },
      "abc",
    );
    await check(
      "GET",
      (r) => r.set(stale).status(404).send(Buffer.from("x")),
      { ...text, "content-length": "1" },
      "x",
    );
    await check("GET", (r) => r.set(stale).send(), { "content-length": "0" });
    // `HEAD`: the length of the body it would send, or the one it was given
    await check("HEAD", (r) => r.send("abc"), {
      ...text,
      "content-length": "3",
    });
    await check("HEAD", (r) => r.setHeader("Content-Length", 1234).send(), {
      "content-length": "1234",
    });
    // Sent headers are not changed: the body follows their framing
    await check(
      "GET",
      async (r) => {
        r.flushHeaders();
        await r.send("abc");
      },
      { "transfer-encoding": "chunked" },
      "3\r\nabc\r\n0\r\n\r\n",
    );
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
        // A stale length would leave the client waiting for its bytes
        response
          .setHeader("Content-Length", 99)
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
    deepStrictEqual(response.headers.get("Content-Length"), "0");

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
      newServer.listen(0, resolve);
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
      const response = await fetch(`http://localhost:${portOf(newServer)}`, {
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

  test(".sendFile() (RFC 9110, conditional and range requests)", async () => {
    const send = async (
      headers: Record<string, string>,
      { method = "GET", path = filePath, etag = "" } = {},
    ): Promise<[number, string | null, string]> => {
      const serverPromise = new Promise<void>((resolve, reject) => {
        server.once("request", (_request, response) => {
          if (etag) {
            response.setHeader("ETag", etag);
          }
          response.sendFile(path).then(resolve, reject);
        });
      });
      const response = await fetch(url, {
        method,
        headers,
        signal: AbortSignal.timeout(5000),
      });
      const body = await response.text();
      await serverPromise;
      return [response.status, response.headers.get("Content-Range"), body];
    };
    const whole = msg.toString();
    const size = msg.byteLength;
    const seconds = Math.floor(file_stats.mtime.getTime() / 1000) * 1000;
    const lm = new Date(seconds).toUTCString();
    const range = { Range: "bytes=0-1" };
    const partial = [206, `bytes 0-1/${size}`, whole.slice(0, 2)];

    // Several ranges: one when they overlap or touch, the whole file otherwise
    deepStrictEqual(await send({ Range: "bytes=0-1,2-3" }), [
      206,
      `bytes 0-3/${size}`,
      whole.slice(0, 4),
    ]);
    deepStrictEqual(await send({ Range: "bytes=2-3, 0-4" }), [
      206,
      `bytes 0-4/${size}`,
      whole.slice(0, 5),
    ]);
    deepStrictEqual(await send({ Range: "bytes=0-1,5-6" }), [200, null, whole]);
    // Satisfiable when any range is
    deepStrictEqual(await send({ Range: "bytes=99999-,0-1" }), partial);
    // To the end of the file
    deepStrictEqual(await send({ Range: "bytes=30-" }), [
      206,
      `bytes 30-${size - 1}/${size}`,
      whole.slice(30),
    ]);
    deepStrictEqual(await send({ Range: "bytes=-0" }), [
      416,
      `bytes */${size}`,
      "",
    ]);
    // Ranges apply to GET only
    deepStrictEqual(await send(range, { method: "POST" }), [200, null, whole]);

    // If-Range: exactly the Last-Modified, or a strong ETag
    deepStrictEqual(await send({ ...range, "If-Range": lm }), partial);
    const later = new Date(seconds + 1000).toUTCString();
    deepStrictEqual(await send({ ...range, "If-Range": later }), [
      200,
      null,
      whole,
    ]);
    deepStrictEqual(await send({ ...range, "If-Range": "garbage" }), [
      200,
      null,
      whole,
    ]);
    deepStrictEqual(await send({ ...range, "If-Range": `"abc"` }), [
      200,
      null,
      whole,
    ]);
    deepStrictEqual(
      await send({ ...range, "If-Range": `"abc"` }, { etag: `"abc"` }),
      partial,
    );
    deepStrictEqual(
      await send({ ...range, "If-Range": `W/"abc"` }, { etag: `W/"abc"` }),
      [200, null, whole],
    );

    // If-None-Match takes precedence over If-Modified-Since
    deepStrictEqual((await send({ "If-Modified-Since": lm }))[0], 304);
    deepStrictEqual(
      await send({ "If-Modified-Since": lm, "If-None-Match": `"x"` }),
      [200, null, whole],
    );
  });

  test(".sendFile() (an empty file)", async () => {
    const empty = join(dirPath, "empty");
    const check = async (
      headers: Record<string, string>,
      status: number,
      range: string | null,
    ): Promise<void> => {
      const serverPromise = new Promise<void>((resolve, reject) => {
        server.once("request", (_request, response) => {
          response.sendFile(empty).then(resolve, reject);
        });
      });
      const response = await fetch(url, { headers });
      await serverPromise;
      deepStrictEqual(response.status, status);
      deepStrictEqual(response.headers.get("Content-Range"), range);
      deepStrictEqual(await response.text(), "");
    };
    await writeFile(empty, "");
    try {
      // No byte range can be satisfied
      await check({ Range: "bytes=0-" }, 416, "bytes */0");
      await check({ Range: "bytes=-5" }, 416, "bytes */0");
      await check({}, 200, null);
    } finally {
      await rm(empty);
    }
  });

  test(".sendFile() (a modification date in the future)", async () => {
    const mtime = new Date(Date.now() + 3600 * 1000);
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response) => {
        const stats = {
          isFile: (): boolean => true,
          mtime,
          size: msg.byteLength,
        };
        response.sendFile(filePath, stats).then(resolve, reject);
      });
    });

    const response = await fetch(url);
    await serverPromise;

    const lm = Date.parse(response.headers.get("Last-Modified") ?? "");
    ok(lm <= Date.now(), `${lm}`);
    deepStrictEqual(await response.text(), msg.toString());
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
    await rm(root, { recursive: true, force: true });
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
