/* eslint-disable init-declarations */
import { Binden, type Context } from "binden";
import { type Server, request } from "node:http";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Multipart } from "../index.js";
import { deepEqual } from "node:assert/strict";

const port = 8080;
const url = `http://localhost:${port}/`;

function post(body: string, boundary: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    request(url, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": Buffer.byteLength(body),
      },
    })
      .once("error", reject)
      .once("response", (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      })
      .end(body);
  });
}

describe("Multipart (malformed body)", () => {
  let server: Server;

  beforeEach(async () => {
    const app = new Binden().use(new Multipart(), (ct: Context) =>
      ct.send("OK"),
    );
    await new Promise<void>((resolve) => {
      server = app.createServer().listen(port, resolve);
    });
  });

  it("Replies with 415 error when a file part is not terminated", async () => {
    const boundary = "binden-boundary";
    const truncated = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="file.txt"',
      "Content-Type: text/plain",
      "",
      "Hello World",
    ].join("\r\n");

    deepEqual(await post(truncated, boundary), 415);

    const complete = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="file.txt"',
      "Content-Type: text/plain",
      "",
      "Hello World",
      `--${boundary}--`,
      "",
    ].join("\r\n");

    deepEqual(await post(complete, boundary), 200);
  });

  afterEach(async () => {
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
