import {
  type IServed,
  capture,
  converse,
  fetchRaw,
  serve,
  sleep,
  text,
  within,
} from "./helpers.js";
import { afterEach, suite, test } from "node:test";
import { Compression } from "../index.js";
import type { Context } from "binden";
import { Readable } from "node:stream";
import { deepStrictEqual } from "node:assert/strict";

const body = text(8192);

suite("The access log of a compressed response", () => {
  let served: IServed | null = null;

  afterEach(async () => {
    const current = served;
    served = null;
    await current?.close();
  });

  test("counts the bytes of the body as sent: compressed, and none of a refused write", async () => {
    const captured = capture();
    served = await serve(
      { app: { logger: captured.logger, access_log: true } },
      new Compression({ format: "gzip" }),
      async (context: Context) => {
        const { response } = context;
        // Which record of the access log is of this response
        response.type("text/plain").setHeader("X-Id", context.id);
        const { pathname } = context.url;
        if (pathname === "/stream") {
          await response.send(
            Readable.from([body.slice(0, 4096), body.slice(4096)]),
          );
        } else if (pathname === "/flushed") {
          response.write(body.slice(0, 4096));
          await response.flush();
          response.end(body.slice(4096));
        } else if (pathname === "/late") {
          response.end(body);
          // Refused (after its end): never written
          response.write("late");
        } else {
          await response.send(body);
        }
      },
    );
    const { url } = served;
    // The bytes of the body received, by the id of the request
    const sent = new Map<unknown, number>();
    for (const [path, method, accept] of [
      ["/", "GET", "gzip"],
      ["/stream", "GET", "gzip"],
      ["/flushed", "GET", "gzip"],
      ["/late", "GET", "gzip"],
      ["/", "HEAD", "gzip"],
      ["/", "GET", "identity;q=0"],
      ["/", "GET", "identity"],
    ]) {
      const received = await fetchRaw(url, {
        path,
        method,
        headers: { "Accept-Encoding": accept },
      });
      sent.set(received.headers["x-id"], received.raw.length);
    }
    // HTTP/1.0: delimited by the close of the connection
    const [response] = await converse(
      url,
      "GET /stream HTTP/1.0\r\nHost: a\r\nAccept-Encoding: gzip\r\n\r\n",
    );
    sent.set(
      /\r\nx-id: (?<id>\S+)/u.exec(response.head)?.groups?.id,
      response.body.length,
    );
    const completed = (): Map<unknown, unknown> =>
      new Map(
        captured.entries
          .filter(({ msg }) => msg === "The request has completed")
          .map(({ id, body_bytes: bytes }) => [id, bytes]),
      );
    // Logged once each response is closed
    await within(
      (async (): Promise<void> => {
        while (completed().size < sent.size) {
          await sleep(5);
        }
      })(),
    );

    deepStrictEqual(completed(), sent);
    // Compressed, but for `HEAD`, `406` and `identity`
    const bytes = [...sent.values()];
    deepStrictEqual(
      bytes.map((count) => count > 0 && count < body.length),
      [true, true, true, true, false, false, false, true],
    );
    deepStrictEqual(bytes.slice(4, 7), [0, 0, body.length]);
  });
});
