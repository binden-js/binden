import { BindenAbortError, type Context } from "binden";
import {
  type IReceived,
  type IServed,
  capture,
  fetchRaw,
  gzips,
  none,
  serve,
  text,
  within,
} from "./helpers.js";
import { type IncomingMessage, request } from "node:http";
import { after, afterEach, before, suite, test } from "node:test";
import { deepStrictEqual, ok } from "node:assert";
import { randomBytes, randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { Compression } from "../index.js";
import { Readable } from "node:stream";
import { join } from "node:path";
import { once } from "node:events";
import { tmpdir } from "node:os";

/** The headers that tell the representation of a response */
function representation({
  status,
  headers,
}: IReceived): Record<string, unknown> {
  return {
    status,
    etag: headers.etag,
    vary: headers.vary,
    encoding: headers["content-encoding"],
    length: headers["content-length"],
    ranges: headers["accept-ranges"],
  };
}

const large = text(2048);
const accepts = {
  gzip: { "Accept-Encoding": "gzip" },
  identity: { "Accept-Encoding": "identity" },
  none: {},
  refused: { "Accept-Encoding": "identity;q=0" },
} as const;

suite("Conditional requests of compressed responses", () => {
  let served: IServed | null = null;
  const file = join(tmpdir(), `binden-compression-${randomUUID()}.txt`);
  const content = text(4096);

  before(async () => {
    await writeFile(file, content);
  });

  after(async () => {
    await rm(file);
  });

  afterEach(async () => {
    const current = served;
    served = null;
    await current?.close();
  });

  test("the dynamic `ETag`: `If-None-Match` sees the representation of `GET`", async () => {
    served = await serve(
      { etag: true },
      new Compression(),
      (context: Context) => {
        const bodies: Record<string, Buffer | bigint | number | string> = {
          "/send": large,
          "/buffer": Buffer.from("small"),
          "/number": 42,
          "/bigint": 42n,
        };
        const { pathname } = context.url;
        const data = bodies[pathname];
        return pathname === "/small"
          ? context.text("small")
          : typeof data === "undefined"
            ? context.json({ large })
            : context.send(data);
      },
    );
    const { url } = served;

    for (const path of [
      "/",
      "/send",
      "/small",
      "/buffer",
      "/number",
      "/bigint",
    ]) {
      for (const [name, accept] of Object.entries(accepts)) {
        const get = await fetchRaw(url, { path, headers: accept });
        const head = await fetchRaw(url, {
          path,
          method: "HEAD",
          headers: accept,
        });
        deepStrictEqual(
          representation(head),
          representation(get),
          `${path} ${name}`,
        );
        const etag = String(get.headers.etag);

        for (const method of ["GET", "HEAD"]) {
          const conditional = await fetchRaw(url, {
            path,
            method,
            headers: { ...accept, "If-None-Match": etag },
          });
          // The length of an uncompressed `200` stays (RFC 9110, section 8.6)
          const expected =
            get.status === 406
              ? representation(get)
              : { ...representation(get), status: 304, encoding: none };
          deepStrictEqual(
            representation(conditional),
            expected,
            `${method} ${path} ${name}`,
          );
          deepStrictEqual(conditional.raw.length, 0);
        }
      }
    }

    // The tags of the representations
    const gzip = await fetchRaw(url, { headers: accepts.gzip });
    const identity = await fetchRaw(url, { headers: accepts.identity });
    deepStrictEqual(gzip.headers.etag, `W/${String(identity.headers.etag)}`);
    deepStrictEqual(gzip.headers["content-encoding"], "gzip");
    deepStrictEqual(JSON.parse(gzip.body), { large });

    // The tag of one matches the other (by the weak comparison)
    const cross = await fetchRaw(url, {
      headers: {
        ...accepts.gzip,
        "If-None-Match": String(identity.headers.etag),
      },
    });
    deepStrictEqual(cross.status, 304);
    deepStrictEqual(cross.headers.etag, gzip.headers.etag);

    // Too small to be compressed: as it is, when the request accepts it
    const small = await fetchRaw(url, { path: "/small" });
    deepStrictEqual(small.body, "small");
    deepStrictEqual(small.headers.vary, "Accept-Encoding");
    const unacceptable = await fetchRaw(url, {
      path: "/small",
      headers: accepts.refused,
    });
    deepStrictEqual(unacceptable.status, 406);

    const refused = await fetchRaw(url, { headers: accepts.refused });
    deepStrictEqual(refused.status, 406);
    ok(!("etag" in refused.headers));
  });

  test("`sendFile()`: `If-None-Match`, `Range` and `If-Range`", async () => {
    served = await serve({}, new Compression(), (context: Context) => {
      const validator = context.request.headers["x-validator"];
      return context.response.sendFile(
        file,
        typeof validator === "string" ? { validator } : {},
      );
    });
    const { url } = served;

    for (const validator of [null, `"v1"`]) {
      const tagged = validator === null ? {} : { "x-validator": validator };
      for (const [name, accept] of Object.entries(accepts)) {
        const headers = { ...tagged, ...accept };
        const get = await fetchRaw(url, { headers });
        const head = await fetchRaw(url, { method: "HEAD", headers });
        deepStrictEqual(representation(head), representation(get), name);
        // Nothing acceptable: no tag to match
        deepStrictEqual(get.status === 406, name === "refused");
        if (get.status !== 406) {
          deepStrictEqual(get.body, content);
          const conditional = await fetchRaw(url, {
            headers: { ...headers, "If-None-Match": String(get.headers.etag) },
          });
          deepStrictEqual(representation(conditional), {
            ...representation(get),
            status: 304,
            encoding: none,
          });
        }
      }

      const gzip = await fetchRaw(url, {
        headers: { ...tagged, ...accepts.gzip },
      });
      deepStrictEqual(gzip.headers["content-encoding"], "gzip");
      ok(String(gzip.headers.etag).startsWith("W/"));
      ok(!("accept-ranges" in gzip.headers));
      const identity = await fetchRaw(url, {
        headers: { ...tagged, ...accepts.identity },
      });
      deepStrictEqual(identity.headers["accept-ranges"], "bytes");
      deepStrictEqual(identity.headers["content-length"], `${content.length}`);

      // The compressed representation is sent whole: it has no ranges
      for (const range of [
        { Range: "bytes=0-9" },
        { Range: "bytes=0-9", "If-Range": String(identity.headers.etag) },
        { Range: "bytes=0-9", "If-Range": String(gzip.headers.etag) },
        { Range: `bytes=${content.length}-` },
      ]) {
        const whole = await fetchRaw(url, {
          headers: { ...tagged, ...accepts.gzip, ...range },
        });
        deepStrictEqual(representation(whole), representation(gzip));
        deepStrictEqual(whole.body, content);
      }

      // The ranges of the file as it is
      const range = { ...tagged, ...accepts.identity, Range: "bytes=0-9" };
      const partial = await fetchRaw(url, { headers: range });
      deepStrictEqual(partial.status, 206);
      ok(!("content-encoding" in partial.headers));
      deepStrictEqual(partial.raw.toString(), content.slice(0, 10));
      const unsatisfiable = await fetchRaw(url, {
        headers: { ...range, Range: `bytes=${content.length}-` },
      });
      deepStrictEqual(unsatisfiable.status, 416);

      // `If-Range` matches its strong tag only
      const strong = await fetchRaw(url, {
        headers: { ...range, "If-Range": String(identity.headers.etag) },
      });
      deepStrictEqual(strong.status, validator === null ? 200 : 206);
      deepStrictEqual(strong.raw.length, validator === null ? 4096 : 10);
    }
  });

  test("`sendFile()` with a redirect or an error status: the whole file, whatever the preconditions and `Range`", async () => {
    const tag = `"v1"`;
    served = await serve({}, new Compression(), (context: Context) =>
      context.response
        .status(Number(context.request.headers["x-status"]))
        .sendFile(file, { validator: tag }),
    );
    const { url } = served;
    const conditions = {
      "If-None-Match": { "If-None-Match": tag },
      "If-Modified-Since": {
        "If-Modified-Since": new Date(Date.now() + 86_400_000).toUTCString(),
      },
      "If-Match": { "If-Match": `"other"` },
      Range: { Range: "bytes=0-9" },
    };
    // What they do to a `200` (to `GET`: `HEAD` has no ranges), by coding
    const applied: Record<
      "gzip" | "identity",
      Record<keyof typeof conditions, number>
    > = {
      gzip: {
        "If-None-Match": 304,
        "If-Modified-Since": 304,
        "If-Match": 412,
        Range: 200,
      },
      identity: {
        "If-None-Match": 304,
        "If-Modified-Since": 304,
        "If-Match": 412,
        Range: 206,
      },
    };
    for (const status of [200, 302, 404, 503]) {
      for (const [name, condition] of Object.entries(conditions) as [
        keyof typeof conditions,
        Record<string, string>,
      ][]) {
        for (const coding of ["gzip", "identity"] as const) {
          for (const method of ["GET", "HEAD"]) {
            const label = `${method} ${status} ${name} (${coding})`;
            const received = await fetchRaw(url, {
              method,
              headers: {
                "X-Status": `${status}`,
                ...accepts[coding],
                ...condition,
              },
            });
            const expected =
              status === 200
                ? method === "HEAD" && name === "Range"
                  ? 200
                  : applied[coding][name]
                : status;
            deepStrictEqual(received.status, expected, label);
            if (status !== 200) {
              // The file as a `200` would send it whole
              deepStrictEqual(
                [
                  received.headers["content-encoding"],
                  received.headers["content-length"],
                  received.headers["content-range"],
                  received.body,
                ],
                coding === "gzip"
                  ? ["gzip", none, none, method === "GET" ? content : ""]
                  : [
                      none,
                      `${content.length}`,
                      none,
                      method === "GET" ? content : "",
                    ],
                label,
              );
            }
          }
        }
      }
    }
  });

  test("`sendFile()`: the preconditions of the chosen representation", async () => {
    const tag = `"v1"`;
    served = await serve({}, new Compression(), (context: Context) =>
      context.response.sendFile(file, { validator: tag }),
    );
    const { url } = served;
    const received = async (
      headers: Record<string, string>,
      method: string,
    ): Promise<Record<string, unknown>> => {
      const response = await fetchRaw(url, { method, headers });
      return { ...representation(response), body: response.body };
    };
    const modified = String((await fetchRaw(url)).headers["last-modified"]);
    const earlier = new Date(Date.parse(modified) - 1000).toUTCString();

    for (const method of ["GET", "HEAD"]) {
      const compressed = {
        status: 200,
        etag: `W/${tag}`,
        vary: "Accept-Encoding",
        encoding: "gzip",
        length: none,
        ranges: none,
        body: method === "GET" ? content : "",
      };
      // Empty: no compressor, and no `Content-Encoding`
      const failed = {
        ...compressed,
        status: 412,
        encoding: none,
        length: "0",
        body: "",
      };
      const notModified = { ...compressed, status: 304, encoding: none };
      const cases: [Record<string, string>, unknown][] = [
        [{}, compressed],
        // The strong comparison: the tag of the compressed representation is weak
        [{ "If-Match": tag }, failed],
        [{ "If-Match": `"a", ${tag}` }, failed],
        [{ "If-Match": `W/${tag}` }, failed],
        // Any representation
        [{ "If-Match": "*" }, compressed],
        [{ "If-Unmodified-Since": earlier }, failed],
        [{ "If-Unmodified-Since": modified }, compressed],
        // The weak comparison
        [{ "If-None-Match": tag }, { ...notModified, body: "" }],
        [{ "If-None-Match": `W/${tag}` }, { ...notModified, body: "" }],
        [{ "If-Modified-Since": modified }, { ...notModified, body: "" }],
        [{ "If-Modified-Since": earlier }, compressed],
        // `If-Match` first
        [{ "If-Match": tag, "If-None-Match": tag }, failed],
      ];
      const created = await gzips(async () => {
        for (const [headers, expected] of cases) {
          deepStrictEqual(
            await received({ ...accepts.gzip, ...headers }, method),
            expected,
            `${method} ${JSON.stringify(headers)}`,
          );
        }
      });
      // Only for the compressed bodies of `GET`
      deepStrictEqual(created.length, method === "GET" ? 4 : 0);

      // The file as it is, which the request accepts: its strong tag
      const identity = {
        ...compressed,
        etag: tag,
        encoding: none,
        length: `${content.length}`,
        ranges: "bytes",
      };
      deepStrictEqual(
        await received({ ...accepts.identity, "If-Match": tag }, method),
        identity,
      );
      deepStrictEqual(
        await received(
          { ...accepts.identity, "If-Match": tag, "If-None-Match": tag },
          method,
        ),
        { ...identity, status: 304, body: "" },
      );
    }

    // Another method: a matching `If-None-Match` fails
    const other = await fetchRaw(url, {
      method: "POST",
      headers: { ...accepts.gzip, "If-None-Match": tag },
    });
    deepStrictEqual(representation(other), {
      status: 412,
      etag: `W/${tag}`,
      vary: "Accept-Encoding",
      encoding: none,
      length: "0",
      ranges: none,
    });
  });

  test("the dynamic `ETag`: the preconditions of the chosen representation", async () => {
    const modified = "Wed, 01 Jan 2020 00:00:00 GMT";
    const earlier = "Tue, 31 Dec 2019 23:59:59 GMT";
    served = await serve(
      { etag: true },
      new Compression(),
      (context: Context) => {
        const { pathname } = context.url;
        if (pathname === "/modified") {
          context.setHeader("Last-Modified", modified);
        } else if (pathname === "/weak") {
          context.setHeader("ETag", `W/"weak"`);
        }
        return context.text(content);
      },
    );
    const { url } = served;
    const received = async (
      path: string,
      headers: Record<string, string>,
      method: string,
    ): Promise<Record<string, unknown>> => {
      const response = await fetchRaw(url, { path, method, headers });
      return { ...representation(response), body: response.body };
    };
    const sent = await fetchRaw(url, { headers: accepts.gzip });
    const weak = String(sent.headers.etag);
    const strong = weak.replace(/^W\//u, "");
    deepStrictEqual(sent.headers["content-encoding"], "gzip");
    ok(weak.startsWith("W/"));

    for (const method of ["GET", "HEAD"]) {
      const compressed = {
        status: 200,
        etag: weak,
        vary: "Accept-Encoding",
        encoding: "gzip",
        length: none,
        ranges: none,
        body: method === "GET" ? content : "",
      };
      const failed = {
        ...compressed,
        status: 412,
        encoding: none,
        length: "0",
        body: "",
      };
      const notModified = {
        ...compressed,
        status: 304,
        encoding: none,
        body: "",
      };
      const cases: [string, Record<string, string>, unknown][] = [
        ["/", {}, compressed],
        ["/", { "If-Match": strong }, failed],
        ["/", { "If-Match": weak }, failed],
        ["/", { "If-Match": `"other"` }, failed],
        ["/", { "If-Match": "*" }, compressed],
        ["/", { "If-None-Match": strong }, notModified],
        ["/", { "If-None-Match": weak }, notModified],
        ["/", { "If-Match": strong, "If-None-Match": strong }, failed],
        // The dates of the `Last-Modified` of the response
        ["/modified", { "If-Unmodified-Since": earlier }, failed],
        ["/modified", { "If-Unmodified-Since": modified }, compressed],
        ["/modified", { "If-Modified-Since": modified }, notModified],
        ["/modified", { "If-Modified-Since": earlier }, compressed],
        // A weak tag of the application never meets `If-Match`
        ["/weak", { "If-Match": `W/"weak"` }, { ...failed, etag: `W/"weak"` }],
      ];
      const created = await gzips(async () => {
        for (const [path, headers, expected] of cases) {
          deepStrictEqual(
            await received(path, { ...accepts.gzip, ...headers }, method),
            expected,
            `${method} ${path} ${JSON.stringify(headers)}`,
          );
        }
      });
      deepStrictEqual(created.length, method === "GET" ? 4 : 0);
    }
  });

  test("`406` takes precedence over the preconditions", async () => {
    served = await serve(
      { etag: true },
      new Compression(),
      async (context: Context) => {
        await (context.url.pathname === "/file"
          ? context.response.sendFile(file, { validator: `"v1"` })
          : context.text(content));
      },
    );
    const { url } = served;
    const modified = String(
      (await fetchRaw(url, { path: "/file" })).headers["last-modified"],
    );
    for (const path of ["/file", "/"]) {
      for (const method of ["GET", "HEAD"]) {
        for (const headers of [
          {},
          { "If-None-Match": "*" },
          { "If-None-Match": `"v1"` },
          { "If-Match": `"other"` },
          { "If-Modified-Since": modified },
          { "If-Unmodified-Since": "Thu, 01 Jan 1970 00:00:00 GMT" },
        ]) {
          const received = await fetchRaw(url, {
            path,
            method,
            headers: { ...accepts.refused, ...headers },
          });
          deepStrictEqual(
            representation(received),
            {
              status: 406,
              etag: none,
              vary: "Accept-Encoding",
              encoding: none,
              length: "0",
              ranges: none,
            },
            `${method} ${path} ${JSON.stringify(headers)}`,
          );
          deepStrictEqual(received.raw.length, 0);
        }
      }
    }
  });

  test("`sendFile()`: a small file keeps its strong validator on `304`", async () => {
    const small = join(tmpdir(), `binden-compression-${randomUUID()}.txt`);
    await writeFile(small, text(100));
    try {
      served = await serve({}, new Compression(), (context: Context) =>
        context.response.sendFile(small, { validator: `"v1"` }),
      );
      const { url } = served;
      for (const method of ["GET", "HEAD"]) {
        const get = await fetchRaw(url, { method, headers: accepts.gzip });
        deepStrictEqual(representation(get), {
          status: 200,
          etag: `"v1"`,
          vary: "Accept-Encoding",
          encoding: none,
          length: "100",
          ranges: "bytes",
        });
        const conditional = await fetchRaw(url, {
          method,
          headers: { ...accepts.gzip, "If-None-Match": `"v1"` },
        });
        deepStrictEqual(representation(conditional), {
          ...representation(get),
          status: 304,
        });
      }
    } finally {
      await rm(small);
    }
  });

  test("a stream replaced with `406` is no longer read, without an error", async () => {
    const big = join(tmpdir(), `binden-compression-${randomUUID()}.txt`);
    const chunk = Buffer.from(text(64 * 1024));
    const chunks = 16;
    await writeFile(big, Buffer.concat(Array(chunks).fill(chunk)));
    const captured = capture();
    // Per path: the client gets the empty `406` before the send of its
    // request has settled, so the next request may run before it does
    const outcomes = new Map<string, unknown[]>();
    const settled = new Map<string, PromiseWithResolvers<null>>();
    // The reads of the source that `/stream` sends
    let reads = 0;
    try {
      served = await serve(
        { app: { logger: captured.logger } },
        new Compression(),
        async (context: Context) => {
          const { response } = context;
          const path = context.url.pathname;
          // The reads of the source of this request
          let own = 0;
          // A file, or a source whose chunks come at once
          const source = new Readable({
            read(): void {
              own += 1;
              if (path === "/stream") {
                reads = own;
              }
              this.push(own > chunks ? null : chunk);
            },
          });
          const sent =
            context.url.pathname === "/file"
              ? response.sendFile(big)
              : response
                  .set({
                    "Content-Type": "text/plain",
                    "Content-Length": chunks * chunk.length,
                  })
                  .send(source);
          outcomes.set(path, [
            await sent.then(
              () => null,
              (error: unknown) => error,
            ),
            response.writableFinished,
            source.destroyed || own === 0,
          ]);
          settled.get(path)?.resolve(null);
        },
      );
      for (const path of ["/file", "/stream"]) {
        const done = Promise.withResolvers<null>();
        settled.set(path, done);
        const refused = await fetchRaw(served.url, {
          path,
          headers: accepts.refused,
        });
        deepStrictEqual(representation(refused), {
          status: 406,
          etag: none,
          vary: "Accept-Encoding",
          encoding: none,
          length: "0",
          ranges: none,
        });
        deepStrictEqual(refused.raw.length, 0);
        await within(done.promise);
      }
      deepStrictEqual(
        [...(outcomes.get("/file") ?? []), ...(outcomes.get("/stream") ?? [])],
        [null, true, true, null, true, true],
      );
      ok(reads < chunks, `${reads}`);
      deepStrictEqual(
        captured.records.filter(({ level }) => Number(level) >= 40),
        [],
      );
    } finally {
      await rm(big);
    }
  });

  test("a `304` of the application gets the decision of a `200` of unknown length", async () => {
    served = await serve({}, new Compression(), (context: Context) => {
      const { response } = context;
      response.set({ "Content-Type": "text/plain", ETag: `"app"` });
      return context.request.headers["if-none-match"] === `W/"app"`
        ? response.status(304).send()
        : context.send(large);
    });
    const { url } = served;
    const get = await fetchRaw(url, { headers: accepts.gzip });
    deepStrictEqual(get.headers["content-encoding"], "gzip");
    deepStrictEqual(get.body, large);
    const conditional = await fetchRaw(url, {
      headers: { ...accepts.gzip, "If-None-Match": String(get.headers.etag) },
    });
    deepStrictEqual(representation(conditional), {
      ...representation(get),
      status: 304,
      encoding: none,
    });
  });

  test(
    "a client that goes away cancels a compressed response",
    { timeout: 15_000 },
    async () => {
      const random = join(tmpdir(), `binden-compression-${randomUUID()}.txt`);
      await writeFile(random, randomBytes(8 * 1024 * 1024));
      const { promise: outcome, resolve } = Promise.withResolvers<unknown[]>();
      try {
        served = await serve(
          {},
          new Compression(),
          async (context: Context) => {
            const cleaned = new Promise<void>((done) => {
              context.onCleanup(done);
            });
            const sent = await context.response.sendFile(random).then(
              () => null,
              (error: unknown) => (error as { code?: unknown }).code,
            );
            await cleaned;
            const { reason } = context.signal as { reason?: unknown };
            resolve([
              sent,
              reason instanceof BindenAbortError ? reason.reason : null,
              context.response.writableFinished,
            ]);
          },
        );
        const { url } = served;

        const sent = request(url, {
          agent: false,
          headers: accepts.gzip,
          signal: AbortSignal.timeout(10_000),
        }).end();
        const [response] = (await once(sent, "response")) as [IncomingMessage];
        deepStrictEqual(response.headers["content-encoding"], "gzip");
        await once(response, "data");
        sent.destroy();

        // With the error of its write that the compressor has not taken
        deepStrictEqual(await within(outcome), [
          "ERR_STREAM_DESTROYED",
          "client_closed",
          false,
        ]);

        // The server goes on
        const next = await fetchRaw(url, { headers: accepts.gzip });
        deepStrictEqual(next.status, 200);
      } finally {
        await rm(random);
      }
    },
  );
});
