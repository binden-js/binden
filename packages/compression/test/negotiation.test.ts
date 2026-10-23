import { Compression, type ICompressionOptions } from "../index.js";
import { type IServed, fetchRaw, none, serve, text } from "./helpers.js";
import { accepts, negotiate } from "../src/negotiate.js";
import { afterEach, suite, test } from "node:test";
import { deepStrictEqual, ok } from "node:assert";
import type { Context } from "binden";

const body = text(2048);

suite("Content negotiation", () => {
  let served: IServed | null = null;

  /** Serves `body` (as text) through a compression */
  const start = async (options?: ICompressionOptions): Promise<string> => {
    served = await serve({}, new Compression(options), (context: Context) =>
      context.text(body),
    );
    return served.url;
  };

  afterEach(async () => {
    const current = served;
    served = null;
    await current?.close();
  });

  test("negotiate()", () => {
    const offers = ["br", "gzip", "deflate"] as const;
    const cases: [string | undefined, string | false][] = [
      // No header (or an empty one): no coding
      [none, "identity"],
      ["", "identity"],
      // The greatest weight, then the order of the offers
      ["gzip", "gzip"],
      ["x-gzip", "gzip"],
      ["GZIP;Q=0.5", "gzip"],
      ["gzip, deflate, br, zstd", "br"],
      ["deflate;q=0.9, gzip;q=0.8", "deflate"],
      ["br;q=0.1, *", "gzip"],
      ["br;q=0, *", "gzip"],
      ["*;q=0.5, br;q=0.5", "br"],
      // A weight that is not a qvalue drops its element
      ["br;q=1, gzip;q=2", "br"],
      ["gzip;q=2", "identity"],
      // Unknown codings are acceptable alternatives to nothing
      ["compress", "identity"],
      // `identity` wins only when it weighs more
      ["*;q=0.6, identity;q=0.7", "identity"],
      ["*;q=0.8, identity;q=0.7", "br"],
      ["gzip;q=0.5, identity;q=0.5", "gzip"],
      ["identity", "identity"],
      // Nothing is acceptable: `identity` is excluded
      ["identity;q=0", false],
      ["*;q=0", false],
      ["identity;q=0, *;q=0", false],
      ["br;q=0, gzip;q=0, deflate;q=0, identity;q=0", false],
      ["compress, identity;q=0", false],
      // `identity` named by itself is acceptable whatever `*` is
      ["*;q=0, identity", "identity"],
      ["*;q=0, gzip", "gzip"],
      ["br;q=0, gzip;q=0, deflate;q=0, *", "identity"],
    ];
    for (const [header, expected] of cases) {
      deepStrictEqual(negotiate(header, offers), expected, header);
    }
    deepStrictEqual(negotiate("gzip, br", ["gzip", "br"]), "gzip");
    deepStrictEqual(negotiate("zstd", offers), "identity");
    deepStrictEqual(negotiate("zstd, br", ["zstd", "br"]), "zstd");
  });

  test("accepts()", () => {
    const cases: [string | undefined, string[], boolean][] = [
      // Any coding without the header, none with an empty one
      [none, ["gzip"], true],
      [none, ["*"], true],
      ["", ["gzip"], false],
      ["gzip", ["gzip"], true],
      ["x-gzip", ["gzip"], true],
      ["GZIP", ["x-gzip"], true],
      ["*", ["aes128gcm"], true],
      ["aes128gcm", ["aes128gcm"], true],
      ["br, gzip;q=0.1", ["gzip"], true],
      // Not named, or refused
      ["br", ["gzip"], false],
      ["identity", ["gzip"], false],
      ["gzip;q=0", ["gzip"], false],
      ["*;q=0", ["gzip"], false],
      ["*, gzip;q=0", ["gzip"], false],
      // Every coding of the representation
      ["gzip, br", ["gzip", "br"], true],
      ["gzip", ["gzip", "br"], false],
      // Not a content coding
      ["*", ["*"], false],
      ["*", ["gzip;q=1"], false],
    ];
    for (const [header, codings, expected] of cases) {
      deepStrictEqual(
        accepts(header, codings),
        expected,
        `${String(header)} ${codings.join()}`,
      );
    }
  });

  test("no `Accept-Encoding` gets no coding (and `Vary`)", async () => {
    const url = await start();
    const response = await fetchRaw(url);

    deepStrictEqual(response.status, 200);
    ok(!("content-encoding" in response.headers));
    deepStrictEqual(response.headers.vary, "Accept-Encoding");
    deepStrictEqual(response.headers["content-length"], `${body.length}`);
    deepStrictEqual(response.body, body);
  });

  test("the coding of the greatest weight, in the order of `encodings`", async () => {
    const url = await start();
    const cases: [string, string | undefined][] = [
      ["gzip, deflate, br, zstd", "br"],
      ["gzip, deflate", "gzip"],
      ["deflate", "deflate"],
      ["x-gzip", "gzip"],
      ["br;q=0.5, gzip", "gzip"],
      ["zstd", none],
      ["identity", none],
      ["*;q=0.6, identity;q=0.7", none],
    ];
    for (const [header, coding] of cases) {
      const response = await fetchRaw(url, {
        headers: { "Accept-Encoding": header },
      });
      deepStrictEqual(response.headers["content-encoding"], coding, header);
      deepStrictEqual(response.headers.vary, "Accept-Encoding");
      deepStrictEqual(response.body, body);
    }
  });

  test("`encodings` sets the codings and their order (`zstd` is opt-in)", async () => {
    const url = await start({ encodings: ["zstd", "gzip"] });
    const cases: [string, string | undefined][] = [
      ["gzip, deflate, br, zstd", "zstd"],
      ["br, gzip", "gzip"],
      ["br, deflate", none],
    ];
    for (const [header, coding] of cases) {
      const response = await fetchRaw(url, {
        headers: { "Accept-Encoding": header },
      });
      deepStrictEqual(response.headers["content-encoding"], coding, header);
      deepStrictEqual(response.body, body);
    }
  });

  test("`406 Not Acceptable` when no coding is acceptable, `identity` neither", async () => {
    const url = await start();
    for (const header of ["identity;q=0", "*;q=0", "compress, identity;q=0"]) {
      for (const method of ["GET", "HEAD"]) {
        const response = await fetchRaw(url, {
          method,
          headers: { "Accept-Encoding": header },
        });
        deepStrictEqual(response.status, 406, `${method} ${header}`);
        deepStrictEqual(response.headers["content-length"], "0");
        deepStrictEqual(response.headers.vary, "Accept-Encoding");
        ok(!("content-type" in response.headers));
        ok(!("content-encoding" in response.headers));
        deepStrictEqual(response.body, "");
      }
    }

    // An acceptable coding is used rather than `identity`
    const gzip = await fetchRaw(url, {
      headers: { "Accept-Encoding": "identity;q=0, gzip" },
    });
    deepStrictEqual(gzip.status, 200);
    deepStrictEqual(gzip.headers["content-encoding"], "gzip");
    deepStrictEqual(gzip.body, body);
  });

  test("`406` replaces the response at its commit, by every path", async () => {
    const callbacks: string[] = [];
    served = await serve({}, new Compression(), async (context: Context) => {
      const { response } = context;
      context.done = true;
      const headers = { "Content-Type": "text/plain" };
      if (context.url.pathname === "/flush") {
        response.setHeader("Content-Type", "text/plain");
        response.flushHeaders();
      } else {
        response.writeHead(200, "Fine", headers);
      }
      response.write(body, () => callbacks.push("write"));
      await new Promise<void>((resolve) => {
        response.end(() => {
          callbacks.push("end");
          resolve();
        });
      });
    });
    for (const path of ["/head", "/flush"]) {
      const response = await fetchRaw(served.url, {
        path,
        headers: { "Accept-Encoding": "*;q=0" },
      });
      deepStrictEqual(response.status, 406, path);
      deepStrictEqual(response.headers["content-length"], "0");
      ok(!("content-type" in response.headers));
      deepStrictEqual(response.raw.length, 0);
    }
    deepStrictEqual(callbacks.toSorted(), ["end", "end", "write", "write"]);
  });

  test("a fixed format is the only coding besides `identity`", async () => {
    const url = await start({ format: "deflate" });
    const cases: [string | null, number, string | undefined][] = [
      // `identity` is preferred without the header, or with an empty one
      [null, 200, none],
      ["", 200, none],
      ["deflate", 200, "deflate"],
      ["gzip, deflate;q=0.5", 200, "deflate"],
      ["*", 200, "deflate"],
      ["identity;q=0, *", 200, "deflate"],
      // Not acceptable: `identity` then
      ["gzip", 200, none],
      ["deflate;q=0, identity", 200, none],
      ["deflate;q=0.5, identity", 200, none],
      // Neither
      ["identity;q=0", 406, none],
      ["gzip, identity;q=0", 406, none],
      ["deflate;q=0, identity;q=0", 406, none],
      ["*;q=0", 406, none],
    ];
    for (const [header, status, coding] of cases) {
      for (const method of ["GET", "HEAD"]) {
        const response = await fetchRaw(url, {
          method,
          headers: header === null ? {} : { "Accept-Encoding": header },
        });
        deepStrictEqual(
          [
            response.status,
            response.headers["content-encoding"],
            response.headers.vary,
          ],
          [status, coding, "Accept-Encoding"],
          `${method} ${String(header)}`,
        );
        deepStrictEqual(
          response.body,
          status === 200 && method === "GET" ? body : "",
        );
      }
    }
  });

  test("`Vary` keeps its values", async () => {
    served = await serve(
      {},
      (context: Context) => {
        const { pathname } = context.url;
        context.setHeader(
          "Vary",
          pathname === "/list" ? ["Origin", "accept-encoding"] : "Origin",
        );
      },
      new Compression(),
      (context: Context) => context.text(body),
    );
    const headers = { "Accept-Encoding": "gzip" };

    const added = await fetchRaw(served.url, { headers });
    deepStrictEqual(added.headers.vary, "Origin, Accept-Encoding");

    const kept = await fetchRaw(served.url, { path: "/list", headers });
    deepStrictEqual(kept.headers.vary, "Origin, accept-encoding");
    deepStrictEqual(kept.headers["content-encoding"], "gzip");
  });
});
