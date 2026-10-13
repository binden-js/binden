/* eslint-disable init-declarations */
import { Binden, type Context } from "binden";
import { type Server, request } from "node:http";
import { afterEach, beforeEach, describe, it } from "node:test";
import { deepEqual, ok } from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Multipart } from "../index.js";

let url = "";

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
      server = app.createServer().listen(0, () => {
        url = `http://localhost:${(server.address() as AddressInfo).port}/`;
        resolve();
      });
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

describe("Multipart (aborted request)", () => {
  let server: Server;
  let started: Promise<void>;
  let settled: Promise<unknown>;

  beforeEach(async () => {
    let start: () => void;
    let settle: (value: unknown) => void;
    started = new Promise<void>((resolve) => {
      start = resolve;
    });
    settled = new Promise<unknown>((resolve) => {
      settle = resolve;
    });

    const parser = new Multipart();
    const app = new Binden().use(async (ct: Context) => {
      start();
      try {
        await parser.run(ct);
        settle(null);
      } catch (error: unknown) {
        settle(error);
      }
    });
    await new Promise<void>((resolve) => {
      server = app.createServer().listen(0, () => {
        url = `http://localhost:${(server.address() as AddressInfo).port}/`;
        resolve();
      });
    });
  });

  it(
    "Settles when the connection is closed in the middle of a file",
    { timeout: 5000 },
    async () => {
      const boundary = "binden-boundary";
      const head = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="file.txt"',
        "Content-Type: text/plain",
        "",
        "Hello",
      ].join("\r\n");
      const req = request(url, {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": Buffer.byteLength(head) + 1024,
        },
      });
      req.on("error", () => {
        // The connection is closed on purpose
      });
      req.write(head);

      await started;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      req.destroy();

      ok((await settled) instanceof Error);
    },
  );

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
