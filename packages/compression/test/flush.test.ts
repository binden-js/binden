import {
  Compression,
  type ICompressEncodings,
  isCompressible,
} from "../index.js";
import type { ContentType, Context } from "binden";
import {
  type IServed,
  decode,
  fetchRaw,
  pollUntil,
  sameBytes,
  serve,
  within,
} from "./helpers.js";
import { type IncomingMessage, request } from "node:http";
import { afterEach, suite, test } from "node:test";
import { deepStrictEqual, ok, rejects } from "node:assert";
import type { Transform } from "node:stream";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import zlib from "node:zlib";

const decompressors = new Map<string, () => Transform>([
  ["br", (): Transform => zlib.createBrotliDecompress()],
  ["deflate", (): Transform => zlib.createInflate()],
  ["gzip", (): Transform => zlib.createGunzip()],
  ["zstd", (): Transform => zlib.createZstdDecompress()],
]);

/** A streaming decompressor of a coding */
function decompressor(coding: string): Transform {
  return (decompressors.get(coding) as () => Transform)();
}

/** The text that a stream has emitted so far, read as it comes */
interface IReader {
  readonly text: string;
  /** Resolves once the text has `expected` (within 5 s) */
  until(expected: string): Promise<void>;
}

/** Reads a stream as it comes */
function reader(stream: NodeJS.ReadableStream): IReader {
  let received = "";
  stream.on("data", (chunk: Buffer) => {
    received += chunk.toString();
  });
  return {
    get text(): string {
      return received;
    },
    until: async (expected: string): Promise<void> => {
      await pollUntil(() => received.includes(expected)).catch(() => {
        throw new Error(`Not received within 10 s: ${received}`);
      });
    },
  };
}

/**
 * Decompresses what a compressor has flushed (a stream that is not ended):
 * what the decompressor has emitted once its own flush has been called back
 * (it has decompressed all that it has been written), not after a time,
 * which a loaded machine may need more of
 */
async function flushed(coding: string, data: Buffer): Promise<string> {
  const stream = decompressor(coding);
  const read = reader(stream);
  stream.write(data);
  await within(
    new Promise<void>((resolve) => {
      (stream as zlib.Zlib & Transform).flush(() => {
        resolve();
      });
    }),
  );
  stream.destroy();
  return read.text;
}

/** Sends a request, and resolves with its response (not read) */
async function respond(
  url: string,
  headers: Record<string, string>,
  method = "GET",
): Promise<IncomingMessage> {
  const sent = request(url, {
    agent: false,
    headers,
    method,
    signal: AbortSignal.timeout(10_000),
  }).end();
  const [response] = (await within(once(sent, "response"))) as [
    IncomingMessage,
  ];
  return response;
}

const sse = "text/event-stream";

/** Compresses event streams as well */
const filter = (_context: Context, type: ContentType | null): boolean =>
  type?.type === sse || isCompressible(type);

suite("flush()", () => {
  let served: IServed | null = null;

  afterEach(async () => {
    const current = served;
    served = null;
    await current?.close();
  });

  /**
   * Server-sent events, each one flushed: the client reads the first one
   * before the second one is sent
   */
  const events = async (coding: ICompressEncodings): Promise<void> => {
    const { promise: received, resolve } = Promise.withResolvers<null>();
    const written: Buffer[] = [];
    const after: { written: Buffer; acknowledged: boolean }[] = [];
    let calls = 0;
    let acknowledged = 0;
    served = await serve(
      {},
      // The compressed chunks, as the compression writes them
      (context: Context) => {
        const { response } = context;
        const write = response.write.bind(response);
        response.write = ((chunk: Buffer | string, callback: () => void) => {
          calls += 1;
          written.push(Buffer.from(chunk));
          return write(chunk, () => {
            acknowledged += 1;
            callback();
          });
        }) as typeof response.write;
      },
      new Compression({ encodings: [coding], filter }),
      async (context: Context) => {
        const { response } = context;
        context.done = true;
        response.setHeader("Content-Type", sse);
        response.write("data: 1\n\n");
        await response.flush();
        after.push({
          written: Buffer.concat(written),
          acknowledged: calls > 0 && acknowledged === calls,
        });
        await received;
        response.write("data: 2\n\n");
        await response.flush();
        response.end();
      },
    );

    const response = await respond(served.url, { "Accept-Encoding": coding });
    deepStrictEqual(response.headers["content-type"], sse);
    deepStrictEqual(response.headers["content-encoding"], coding);
    const ended = once(response, "end");
    const read = reader(response.pipe(decompressor(coding)));
    await read.until("data: 1\n\n");
    resolve(null);
    await read.until("data: 2\n\n");
    await within(ended);

    deepStrictEqual(read.text, "data: 1\n\ndata: 2\n\n");
    // Once `flush()` has resolved, the compressed event has been written
    deepStrictEqual(after.length, 1);
    const [first] = after;
    ok(first.acknowledged);
    deepStrictEqual(await flushed(coding, first.written), "data: 1\n\n");
  };

  test("server-sent events, flushed after each event (br)", async () => {
    await events("br");
  });

  test("server-sent events, flushed after each event (deflate)", async () => {
    await events("deflate");
  });

  test("server-sent events, flushed after each event (gzip)", async () => {
    await events("gzip");
  });

  test("server-sent events, flushed after each event (zstd)", async () => {
    await events("zstd");
  });

  test("event streams are not compressed by default", async () => {
    served = await serve({}, new Compression(), async (context: Context) => {
      context.setHeader("Content-Type", sse);
      context.response.write("data: 1\n\n");
      await context.response.flush();
      context.response.end();
      context.done = true;
    });
    const response = await fetchRaw(served.url, {
      headers: { "Accept-Encoding": "gzip" },
    });

    ok(!("content-encoding" in response.headers));
    // Sent as it is, which the request accepts
    deepStrictEqual(response.headers.vary, "Accept-Encoding");
    deepStrictEqual(response.body, "data: 1\n\n");
  });

  test("an uncompressed response is flushed as without compression", async () => {
    const { promise: received, resolve } = Promise.withResolvers<null>();
    served = await serve(
      {},
      new Compression({ filter }),
      async (context: Context) => {
        context.done = true;
        context.setHeader("Content-Type", sse);
        context.response.write("data: 1\n\n");
        await context.response.flush();
        await received;
        context.response.end();
      },
    );
    const response = await respond(served.url, {
      "Accept-Encoding": "identity",
    });
    ok(!("content-encoding" in response.headers));
    const ended = once(response, "end");
    const read = reader(response);
    await read.until("data: 1\n\n");
    resolve(null);
    await within(ended);
  });

  test("`flush()` before a write commits the headers", async () => {
    const { promise: received, resolve } = Promise.withResolvers<null>();
    served = await serve(
      {},
      new Compression({ filter }),
      async (context: Context) => {
        context.done = true;
        context.setHeader("Content-Type", sse);
        await context.response.flush();
        await received;
        context.response.end("data: 1\n\n");
      },
    );

    // The headers come before the body
    const response = await respond(served.url, { "Accept-Encoding": "gzip" });
    deepStrictEqual(response.headers["content-encoding"], "gzip");
    resolve(null);
    const read = reader(response.pipe(zlib.createGunzip()));
    await read.until("data: 1\n\n");
  });

  test("`flush()` of a response without a compressor, or ended", async () => {
    const results: unknown[] = [];
    served = await serve(
      {},
      new Compression({ format: "gzip", filter }),
      async (context: Context) => {
        const { response } = context;
        context.done = true;
        response.setHeader("Content-Type", sse);
        const { pathname } = context.url;
        if (pathname === "/ended") {
          response.write("data: 1\n\n");
          response.end();
        }
        await response.flush().then(
          () => results.push(`${context.request.method} ${pathname}`),
          (error: unknown) => results.push(error),
        );
        response.end();
      },
    );

    const head = await fetchRaw(served.url, {
      method: "HEAD",
      headers: { "Accept-Encoding": "gzip" },
    });
    deepStrictEqual(head.headers["content-encoding"], "gzip");
    const ended = await fetchRaw(served.url, {
      path: "/ended",
      headers: { "Accept-Encoding": "gzip" },
    });
    deepStrictEqual(ended.body, "data: 1\n\n");
    deepStrictEqual(results, ["HEAD /", "GET /ended"]);
  });

  test("`flush()` of a replaced response resolves", async () => {
    const { promise: flushed406, resolve } = Promise.withResolvers<unknown>();
    served = await serve(
      {},
      new Compression({ filter }),
      async (context: Context) => {
        context.done = true;
        context.setHeader("Content-Type", sse);
        context.response.write("data: 1\n\n");
        resolve(await context.response.flush().then(() => "resolved"));
      },
    );
    const response = await fetchRaw(served.url, {
      headers: { "Accept-Encoding": "identity;q=0" },
    });

    deepStrictEqual(response.status, 406);
    deepStrictEqual(await within(flushed406), "resolved");
  });

  test("`flush()` waits for the compressed bytes that the response holds back", async () => {
    const data = randomBytes(1024 * 1024);
    const written: Buffer[] = [];
    const { promise: outcome, resolve } = Promise.withResolvers<Buffer>();
    served = await serve(
      {},
      // A response that is always full: each compressed chunk waits for the
      // one before, the others wait in the compressor. Its written chunks are
      // those whose callback has run.
      (context: Context) => {
        const { response } = context;
        const write = response.write.bind(response);
        response.write = ((chunk: Buffer | string, callback: () => void) => {
          write(chunk, () => {
            setTimeout(() => {
              written.push(Buffer.from(chunk));
              callback();
              response.emit("drain");
            }, 1);
          });
          return false;
        }) as typeof response.write;
      },
      new Compression({ format: "gzip", filter: (): boolean => true }),
      async (context: Context) => {
        context.done = true;
        context.response.write(data);
        await context.response.flush();
        resolve(Buffer.concat(written));
        context.response.end();
      },
    );

    const response = await fetchRaw(served.url, {
      headers: { "Accept-Encoding": "gzip" },
    });
    const compressed = await within(outcome);

    // Everything written before `flush()`, as the client can decompress it
    const { Z_SYNC_FLUSH } = zlib.constants;
    sameBytes(zlib.gunzipSync(compressed, { finishFlush: Z_SYNC_FLUSH }), data);
    sameBytes(decode("gzip", response.raw), data);
  });

  test(
    "`flush()` rejects when the response is closed before it is flushed",
    { timeout: 15_000 },
    async () => {
      const { promise: pending, resolve: started } =
        Promise.withResolvers<null>();
      const { promise: outcome, resolve } = Promise.withResolvers<unknown>();
      served = await serve(
        {},
        new Compression({ format: "gzip", filter: (): boolean => true }),
        (context: Context) => {
          context.done = true;
          // More than the connection takes, from a client that does not read
          context.response.write(randomBytes(8 * 1024 * 1024));
          context.response.flush().then(
            () => {
              resolve(null);
            },
            (error: unknown) => {
              resolve((error as { code?: unknown }).code);
            },
          );
          started(null);
        },
      );

      const response = await respond(served.url, { "Accept-Encoding": "gzip" });
      response.pause();
      await within(pending);
      response.destroy();

      deepStrictEqual(await within(outcome), "ERR_STREAM_PREMATURE_CLOSE");
    },
  );

  test("a flush after the response has closed rejects", async () => {
    const { promise: outcome, resolve } = Promise.withResolvers<unknown>();
    served = await serve(
      {},
      new Compression({ format: "gzip", filter }),
      async (context: Context) => {
        context.done = true;
        context.setHeader("Content-Type", sse);
        context.response.write("data: 1\n\n");
        await context.response.flush();
        await once(context.response, "close");
        await rejects(context.response.flush(), {
          code: "ERR_STREAM_PREMATURE_CLOSE",
        });
        resolve("rejected");
      },
    );
    const response = await respond(served.url, { "Accept-Encoding": "gzip" });
    const read = reader(response.pipe(zlib.createGunzip()));
    await read.until("data: 1\n\n");
    response.destroy();

    deepStrictEqual(await within(outcome), "rejected");
  });
});
