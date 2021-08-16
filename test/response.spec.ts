import { deepStrictEqual, ok, throws, rejects } from "assert";
import { randomUUID } from "crypto";
import { writeFile, rm, mkdir, rmdir, stat } from "fs/promises";
import { Server, createServer } from "http";
import { pathToFileURL } from "url";
import fetch from "node-fetch";

import {
  KauaiResponse,
  KauaiRequest,
  Cookie,
  ct_json,
  ct_text,
  ct_form,
  ct_html,
} from "../index.js";

const port = 8080;
const url = `http://localhost:${port}`;

suite("KauaiResponse", () => {
  let server: Server;

  setup((done) => {
    server = createServer({ ServerResponse: KauaiResponse }).listen(port, done);
  });

  test("ServerResponse", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response: KauaiResponse) => {
        try {
          deepStrictEqual(response instanceof KauaiResponse, true);
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
      server.once("request", (_request, response: KauaiResponse) => {
        try {
          ok(response.status(status) instanceof KauaiResponse);
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
      server.once("request", (_request, response: KauaiResponse) => {
        try {
          throws(
            () => response.status(status),
            new TypeError(`Status code ${status} is invalid`)
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
      server.once("request", (_request, response: KauaiResponse) => {
        try {
          ok(response.set(headers) instanceof KauaiResponse);
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
      server.once("request", (_request, response: KauaiResponse) => {
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
      [cookie1, cookie2].map((c) => c.toString()).join(", ")
    );
    ok(response.ok);
  });

  test(".send() (`writableEnded === true`)", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response: KauaiResponse) => {
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
    const msg = "Hello World!";
    const encoding = "base64";
    const encoded = Buffer.from(msg).toString(encoding);
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response: KauaiResponse) => {
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
      [cookie1, cookie2].map((c) => c.toString()).join(", ")
    );
    deepStrictEqual(data, msg);
  });

  test(".send() (Buffer)", async () => {
    const cookie1 = new Cookie({ key: "__Secure-K1", value: "V1" });
    const cookie2 = new Cookie({ key: "__Host-K2", value: "V2" });
    const msg = "Hello World!";
    const buffer = Buffer.from(msg);

    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response: KauaiResponse) => {
        response.cookies.add(cookie1).add(cookie2);
        response.send(buffer).then(resolve).catch(reject);
      });
    });
    const response = await fetch(url);
    await serverPromise;

    const data = await response.buffer();

    deepStrictEqual(response.headers.get("Content-Type"), ct_text);
    deepStrictEqual(
      response.headers.get("Set-Cookie"),
      [cookie1, cookie2].map((c) => c.toString()).join(", ")
    );
    deepStrictEqual(data, buffer);
  });

  test(".send() (number)", async () => {
    const msg = 1;
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response: KauaiResponse) => {
        response.send(msg).then(resolve).catch(reject);
      });
    });
    const response = await fetch(url);
    await serverPromise;
    const data = await response.text();

    deepStrictEqual(response.headers.get("Content-Type"), ct_text);
    deepStrictEqual(data, msg.toString());
  });

  test(".send() (bigint)", async () => {
    const msg = 1n;
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response: KauaiResponse) => {
        response.send(msg).then(resolve).catch(reject);
      });
    });
    const response = await fetch(url);
    await serverPromise;
    const data = await response.text();

    deepStrictEqual(response.headers.get("Content-Type"), ct_text);
    deepStrictEqual(data, msg.toString());
  });

  test(".json()", async () => {
    const msg = { currency: "💶" };
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response: KauaiResponse) => {
        response.json(msg).then(resolve).catch(reject);
      });
    });
    const response = await fetch(url);
    await serverPromise;
    const data = await response.json();

    deepStrictEqual(response.headers.get("Content-Type"), ct_json);
    deepStrictEqual(data, msg);
  });

  test(".json() (an array)", async () => {
    const msg = [1, "2", { currency: "💶" }];
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response: KauaiResponse) => {
        response.json(msg).then(resolve).catch(reject);
      });
    });
    const response = await fetch(url);
    await serverPromise;
    const data = await response.json();

    deepStrictEqual(response.headers.get("Content-Type"), ct_json);
    deepStrictEqual(data, msg);
  });

  test(".text()", async () => {
    const msg = "😀";
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response: KauaiResponse) => {
        response.text(msg).then(resolve).catch(reject);
      });
    });
    const response = await fetch(url);
    await serverPromise;
    const data = await response.text();

    deepStrictEqual(response.headers.get("Content-Type"), ct_text);
    deepStrictEqual(data, msg);
  });

  test(".html()", async () => {
    const msg = "<html></html>";
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response: KauaiResponse) => {
        response.html(msg).then(resolve).catch(reject);
      });
    });
    const response = await fetch(url);
    await serverPromise;
    const data = await response.text();

    deepStrictEqual(response.headers.get("Content-Type"), ct_html);
    deepStrictEqual(data, msg);
  });

  test(".form()", async () => {
    const msg = new URLSearchParams();
    msg.append("1", "2");
    msg.set("0", "1");
    msg.append("1", "3");
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response: KauaiResponse) => {
        response.form(msg).then(resolve).catch(reject);
      });
    });
    const response = await fetch(url);
    await serverPromise;
    const data = await response.text();

    deepStrictEqual(response.headers.get("Content-Type"), ct_form);
    deepStrictEqual(new URLSearchParams(data), msg);
  });

  test(".sendFile()", async () => {
    const path = "./__temp.tmp";
    const msg = Buffer.from(randomUUID());
    await writeFile(path, msg);
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response: KauaiResponse) => {
        response
          .sendFile(path)
          .catch(reject)
          .finally(() => response.end(resolve));
      });
    });
    const response = await fetch(url);
    deepStrictEqual(response.status, 200);
    await serverPromise;
    const data = await response.buffer();
    await rm(path);

    deepStrictEqual(data, msg);
  });

  test(".sendFile() (304 response with `If-Modified-Since`)", async () => {
    const path = "./__temp.tmp";
    const msg = Buffer.from(randomUUID());
    await writeFile(path, msg);
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response: KauaiResponse) => {
        response
          .sendFile(path)
          .then(() => {
            server.once("request", (_request2, response2: KauaiResponse) => {
              response2.sendFile(path).then(resolve).catch(reject);
            });
          })
          .catch(reject);
      });
    });

    const response = await fetch(url);
    const lm = response.headers.get("Last-Modified");
    ok(lm);
    ok(!Number.isNaN(Date.parse(lm)));
    deepStrictEqual(response.status, 200);

    const data = await response.buffer();
    deepStrictEqual(data, msg);

    const headers = { "If-Modified-Since": lm };
    const response2 = await fetch(url, { headers });
    deepStrictEqual(response2.status, 304);

    const data2 = await response2.text();
    deepStrictEqual(data2, "");

    await serverPromise;
    await rm(path);
  });

  test(".sendFile() (304 response with `If-Modified-Since` HEAD)", async () => {
    const path = "./__temp.tmp";
    const msg = Buffer.from(randomUUID());
    await writeFile(path, msg);
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response: KauaiResponse) => {
        response
          .sendFile(path)
          .then(() => {
            server.once("request", (_request2, response2: KauaiResponse) => {
              response2.sendFile(path).then(resolve).catch(reject);
            });
          })
          .catch(reject);
      });
    });

    const response = await fetch(url, { method: "HEAD" });
    const lm = response.headers.get("Last-Modified");
    ok(lm);
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
    await rm(path);
  });

  test(".sendFile() (416 response with invalid `Range`)", async () => {
    const path = "./__temp.tmp";
    const msg = Buffer.from(randomUUID());
    await writeFile(path, msg);

    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response: KauaiResponse) => {
        response
          .sendFile(path)
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
    await rm(path);

    deepStrictEqual(data, "");
  });

  test(".sendFile() (Partial response with `Range`)", async () => {
    const path = "./__temp.tmp";
    const msg = Buffer.from(randomUUID());
    await writeFile(path, msg);

    const start = 10;
    const end = 20;
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response: KauaiResponse) => {
        response
          .sendFile(path)
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
    const data = await response.buffer();
    await rm(path);
    deepStrictEqual(data, msg.slice(start, end + 1));
  });

  test(".sendFile() (Full response with invalid `If-Range`)", async () => {
    const path = "./__temp.tmp";
    const msg = Buffer.from(randomUUID());
    await writeFile(path, msg);

    const stats = await stat(path);

    const start = 10;
    const end = 20;
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response: KauaiResponse) => {
        response
          .sendFile(path)
          .catch(reject)
          .finally(() => response.end(resolve));
      });
    });
    const headers = {
      Range: `bytes= ${start} - ${end} `,
      "If-Range": `${new Date(stats.mtimeMs - 10000).toUTCString()}`,
    };
    const response = await fetch(url, { headers });
    deepStrictEqual(response.headers.get("Content-Range"), null);
    deepStrictEqual(response.status, 200);

    await serverPromise;
    const data = await response.buffer();
    await rm(path);
    deepStrictEqual(data, msg);
  });

  test(".sendFile() (Partial response with suffix length)", async () => {
    const path = "./__temp.tmp";
    const msg = Buffer.from(randomUUID());
    await writeFile(path, msg);

    const end = 20;
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response: KauaiResponse) => {
        response
          .sendFile(path)
          .catch(reject)
          .finally(() => response.end(resolve));
      });
    });
    const headers = { Range: `bytes=  - ${end} ` };
    const response = await fetch(url, { headers });
    await serverPromise;
    const data = await response.buffer();
    await rm(path);
    const cr = response.headers.get("Content-Range");
    deepStrictEqual(
      cr,
      `bytes ${msg.byteLength - end}-${msg.byteLength - 1}/${msg.byteLength}`
    );
    deepStrictEqual(response.status, 206);
    deepStrictEqual(data, msg.slice(msg.byteLength - end));
  });

  test(".sendFile() (`this.req instanceof KauaiRequest`)", async () => {
    const path = "./__temp.tmp";
    const msg = Buffer.from(randomUUID());
    await writeFile(path, msg);

    const newServer = await new Promise<Server>((resolve) => {
      const s = createServer({
        ServerResponse: KauaiResponse,
        IncomingMessage: KauaiRequest,
      }).listen(port + 1, () => {
        resolve(s);
      });
    });

    const end = 100;
    const serverPromise = new Promise<void>((resolve, reject) => {
      newServer.once("request", (_request, response: KauaiResponse) => {
        response
          .sendFile(path)
          .catch(reject)
          .finally(() => response.end(resolve));
      });
    });
    const headers = { Range: `bytes=  - ${end} ` };
    const response = await fetch(`http://localhost:${port + 1}`, { headers });
    await serverPromise;
    const data = await response.buffer();
    await rm(path);
    deepStrictEqual(response.headers.get("Content-Range"), null);
    deepStrictEqual(response.status, 200);
    deepStrictEqual(data, msg.slice(msg.byteLength - end));
    await new Promise<void>((resolve, reject) => {
      newServer.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  });

  test(".sendFile() (with `URL`)", async () => {
    const path = pathToFileURL("./__temp.tmp");
    const msg = randomUUID();
    await writeFile(path, msg);
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response: KauaiResponse) => {
        response
          .sendFile(path)
          .then(resolve)
          .catch(reject)
          .finally(() => response.end(resolve));
      });
    });
    const response = await fetch(url);
    await serverPromise;
    const data = await response.text();
    await rm(path);

    deepStrictEqual(data, msg);
  });

  test(".sendFile() (with invalid protocol)", async () => {
    const path = new URL("https:/www.example.com/");
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response: KauaiResponse) => {
        rejects(
          () => response.sendFile(path),
          new TypeError(`Protocol ${path.protocol} is not supported`)
        )
          .catch(reject)
          .finally(() => response.end(resolve));
      });
    });
    await fetch(url);
    await serverPromise;
  });

  test(".sendFile() (not a regular file)", async () => {
    const path = pathToFileURL("./____temp");
    await mkdir(path);
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (_request, response: KauaiResponse) => {
        rejects(
          () => response.sendFile(path),
          new Error(`Provided path does not correspond to a regular file`)
        )
          .catch(reject)
          .finally(() => response.end(resolve));
      });
    });
    await fetch(url);
    await serverPromise;
    await rmdir(path);
  });

  teardown((done) => server.close(done));
});
