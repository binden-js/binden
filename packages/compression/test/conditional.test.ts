import { BindenAbortError, type Context } from "binden";
import {
  type IReceived,
  type IServed,
  capture,
  fetchRaw,
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

    // Too small to be compressed, with whatever the request accepts
    const small = await fetchRaw(url, {
      path: "/small",
      headers: accepts.refused,
    });
    deepStrictEqual(small.status, 200);
    deepStrictEqual(small.body, "small");
    ok(!("vary" in small.headers));

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

      // A range of the file as it is, whatever the request accepts
      const range = { ...tagged, ...accepts.gzip, Range: "bytes=0-9" };
      const partial = await fetchRaw(url, { headers: range });
      deepStrictEqual(partial.status, 206);
      ok(!("content-encoding" in partial.headers));
      deepStrictEqual(partial.raw.toString(), content.slice(0, 10));

      // `If-Range` matches the strong tag of the file as it is only
      const strong = await fetchRaw(url, {
        headers: { ...range, "If-Range": String(identity.headers.etag) },
      });
      deepStrictEqual(strong.status, validator === null ? 200 : 206);
      const weak = await fetchRaw(url, {
        headers: { ...range, "If-Range": String(gzip.headers.etag) },
      });
      deepStrictEqual(weak.status, 200);
      deepStrictEqual(weak.headers["content-encoding"], "gzip");
      deepStrictEqual(weak.body, content);
    }
  });

  test("`If-Match` met by the strong tag gets the representation of that tag", async () => {
    const tag = `"v1"`;
    served = await serve({}, new Compression(), (context: Context) =>
      context.response.sendFile(file, { validator: tag }),
    );
    const { url } = served;
    const conditional = async (
      headers: Record<string, string>,
      method: string,
    ): Promise<Record<string, unknown>> => {
      const received = await fetchRaw(url, { method, headers });
      return { ...representation(received), body: received.body };
    };

    for (const method of ["GET", "HEAD"]) {
      const body = method === "GET" ? content : "";
      const identity = {
        status: 200,
        etag: tag,
        vary: "Accept-Encoding",
        encoding: none,
        length: `${content.length}`,
        ranges: "bytes",
        body,
      };
      for (const list of [tag, `"a", ${tag}`, `"a,b",${tag}`]) {
        deepStrictEqual(
          await conditional({ ...accepts.gzip, "If-Match": list }, method),
          identity,
          `${method} ${list}`,
        );
      }
      // Whatever the request accepts
      deepStrictEqual(
        await conditional({ ...accepts.refused, "If-Match": tag }, method),
        identity,
      );
      // `*` matches any representation, a weak tag never matches
      deepStrictEqual(
        await conditional({ ...accepts.gzip, "If-Match": "*" }, method),
        {
          ...identity,
          etag: `W/${tag}`,
          encoding: "gzip",
          length: none,
          ranges: none,
        },
      );
      deepStrictEqual(
        await conditional(
          { ...accepts.gzip, "If-Match": `"a", W/${tag}` },
          method,
        ),
        { ...identity, status: 412, vary: none, length: "0", body: "" },
      );
      // The `304` of the `200` that it stands for
      deepStrictEqual(
        await conditional(
          { ...accepts.gzip, "If-Match": tag, "If-None-Match": tag },
          method,
        ),
        { ...identity, status: 304, body: "" },
      );
    }
  });

  test("`If-Match` met by the strong tag: a fixed format, and the dynamic `ETag`", async () => {
    // The dynamic `ETag` has no precondition of its own: `If-Match` is not
    // evaluated, but the representation of its tag is still selected
    served = await serve(
      { etag: true },
      new Compression({ format: "gzip" }),
      (context: Context) => {
        if (context.url.pathname === "/weak") {
          context.setHeader("ETag", `W/"weak"`);
        }
        return context.text(content);
      },
    );
    const { url } = served;
    const sent = await fetchRaw(url);
    const weak = String(sent.headers.etag);
    const strong = weak.replace(/^W\//u, "");
    deepStrictEqual(
      [sent.headers["content-encoding"], sent.body],
      ["gzip", content],
    );
    const cases: [string, unknown[]][] = [
      [strong, [strong, none]],
      [`"other"`, [weak, "gzip"]],
      // Not by the strong comparison
      [weak, [weak, "gzip"]],
    ];
    for (const [list, expected] of cases) {
      const received = await fetchRaw(url, { headers: { "If-Match": list } });
      deepStrictEqual(
        [received.headers.etag, received.headers["content-encoding"]],
        expected,
        list,
      );
      deepStrictEqual(received.body, content);
    }
    // A weak tag is never met by `If-Match`
    const weakly = await fetchRaw(url, {
      path: "/weak",
      headers: { "If-Match": `W/"weak"` },
    });
    deepStrictEqual(weakly.headers["content-encoding"], "gzip");
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
          vary: none,
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
    const outcomes: unknown[] = [];
    let reads = 0;
    try {
      served = await serve(
        { app: { logger: captured.logger } },
        new Compression(),
        async (context: Context) => {
          const { response } = context;
          // A file, or a source whose chunks come at once
          const source = new Readable({
            read(): void {
              reads += 1;
              this.push(reads > chunks ? null : chunk);
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
          outcomes.push(
            await sent.then(
              () => null,
              (error: unknown) => error,
            ),
            response.writableFinished,
            source.destroyed || reads === 0,
          );
        },
      );
      for (const path of ["/file", "/stream"]) {
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
      }
      deepStrictEqual(outcomes, [null, true, true, null, true, true]);
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
          signal: AbortSignal.timeout(5000),
        }).end();
        const [response] = (await once(sent, "response")) as [IncomingMessage];
        deepStrictEqual(response.headers["content-encoding"], "gzip");
        await once(response, "data");
        sent.destroy();

        deepStrictEqual(await within(outcome), [
          "ERR_STREAM_PREMATURE_CLOSE",
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
