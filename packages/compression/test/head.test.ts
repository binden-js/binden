import { type IServed, fetchRaw, serve, text } from "./helpers.js";
import { afterEach, suite, test } from "node:test";
import { type BindenResponse } from "binden";
import { Compression } from "../index.js";
import { Readable } from "node:stream";
import { deepStrictEqual } from "node:assert/strict";

/** The length of a body, as the decision sees it */
type ILength = "at" | "below" | "empty" | "unknown";

/** The bodies of a threshold of 1024 bytes, by path: how they are written, and their length */
const bodies = new Map<
  string,
  readonly [ILength, (response: BindenResponse) => Promise<void> | void]
>(
  Object.entries({
    "/end": [
      "empty",
      (response): void => {
        response.end();
      },
    ],
    "/end-empty": [
      "empty",
      (response): void => {
        response.end("");
      },
    ],
    "/end-below": [
      "below",
      (response): void => {
        response.end(text(1023));
      },
    ],
    "/end-at": [
      "at",
      (response): void => {
        response.end(text(1024));
      },
    ],
    "/write": [
      "unknown",
      (response): void => {
        response.write(text(1024));
        response.end(text(1024));
      },
    ],
    "/stream-0": [
      "empty",
      (response): Promise<void> =>
        response.setHeader("Content-Length", 0).send(Readable.from([])),
    ],
    "/stream-below": [
      "below",
      (response): Promise<void> =>
        response
          .setHeader("Content-Length", 1023)
          .send(Readable.from([text(1023)])),
    ],
    "/stream-at": [
      "at",
      (response): Promise<void> =>
        response
          .setHeader("Content-Length", 1024)
          .send(Readable.from([text(1024)])),
    ],
    "/stream": [
      "unknown",
      (response): Promise<void> =>
        response.send(Readable.from([text(1024), text(1024)])),
    ],
  }),
);

const vary = "Accept-Encoding";
const none = ({} as { value?: undefined }).value;
const as_is = [200, none, none, none] as const;
const small = [200, none, vary, none] as const;
const compressed = [200, "gzip", vary, "chunked"] as const;
const refused = [406, none, vary, none] as const;

/** The status, `Content-Encoding`, `Vary` and `Transfer-Encoding`, by length */
const decisions: Record<string, Record<ILength, readonly unknown[]>> = {
  gzip: { empty: as_is, below: small, at: compressed, unknown: compressed },
  "identity;q=0": {
    empty: as_is,
    below: refused,
    at: refused,
    unknown: refused,
  },
  "gzip, identity;q=0": {
    empty: as_is,
    below: refused,
    at: compressed,
    unknown: compressed,
  },
};

suite("`HEAD` decides as `GET`", () => {
  let served: IServed | null = null;

  afterEach(async () => {
    const current = served;
    served = null;
    await current?.close();
  });

  test("by the length of its body (empty, below or at the threshold, unknown), never `406` for an empty one", async () => {
    served = await serve(
      {},
      new Compression({ format: "gzip" }),
      async ({ response, url }): Promise<void> => {
        response.type("text/plain");
        await bodies.get(url.pathname)?.[1](response);
      },
    );
    const { url } = served;
    for (const [accept, decision] of Object.entries(decisions)) {
      for (const [path, [length]] of bodies) {
        for (const method of ["GET", "HEAD"]) {
          const name = `${method} ${path} (${accept})`;
          const received = await fetchRaw(url, {
            path,
            method,
            headers: { "Accept-Encoding": accept },
          });
          const { status, headers } = received;
          deepStrictEqual(
            [
              status,
              headers["content-encoding"],
              headers.vary,
              headers["transfer-encoding"],
            ],
            decision[length],
            name,
          );
          deepStrictEqual(
            received.body.length,
            method === "GET" && status === 200
              ? { empty: 0, below: 1023, at: 1024, unknown: 2048 }[length]
              : 0,
            name,
          );
        }
      }
    }
  });

  test("a stream that `HEAD` does not read is of an unknown length, not empty", async () => {
    served = await serve(
      {},
      new Compression({ format: "gzip" }),
      async ({ response }): Promise<void> => {
        response.type("text/plain");
        await response.send(Readable.from([]));
      },
    );
    const { url } = served;
    const results: unknown[] = [];
    for (const accept of Object.keys(decisions)) {
      for (const method of ["GET", "HEAD"]) {
        const { status, headers } = await fetchRaw(url, {
          method,
          headers: { "Accept-Encoding": accept },
        });
        results.push([
          method,
          accept,
          status,
          headers["content-encoding"],
          headers.vary,
        ]);
      }
    }
    // `GET` reads it to its end: an empty body
    deepStrictEqual(results, [
      ["GET", "gzip", 200, none, none],
      ["HEAD", "gzip", 200, "gzip", vary],
      ["GET", "identity;q=0", 200, none, none],
      ["HEAD", "identity;q=0", 406, none, vary],
      ["GET", "gzip, identity;q=0", 200, none, none],
      ["HEAD", "gzip, identity;q=0", 200, "gzip", vary],
    ]);
  });
});
