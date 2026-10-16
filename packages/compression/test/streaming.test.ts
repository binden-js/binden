import { Agent, type IncomingMessage, request } from "node:http";
import { BindenError, type Context } from "binden";
import { Compression, type ICompressionOptions } from "../index.js";
import {
  type IServed,
  decode,
  fetchRaw,
  gzips,
  sameBytes,
  serve,
  sleep,
  text,
  within,
} from "./helpers.js";
import { afterEach, suite, test } from "node:test";
import { deepStrictEqual, ok, rejects } from "node:assert";
import { Readable } from "node:stream";
import { once } from "node:events";
import { randomBytes } from "node:crypto";

const gzip = { "Accept-Encoding": "gzip" };

/** Sends a request that accepts `gzip`, and resolves with its response (not read) */
async function respond(url: string): Promise<IncomingMessage> {
  const sent = request(url, {
    agent: false,
    headers: gzip,
    signal: AbortSignal.timeout(5000),
  }).end();
  const [response] = (await within(once(sent, "response"))) as [
    IncomingMessage,
  ];
  return response;
}

suite("Streaming through the compressor", () => {
  let served: IServed | null = null;

  /** Serves a handler through a compression (`gzip` by default) */
  const start = async (
    handler: (context: Context) => Promise<void> | void,
    options: ICompressionOptions = { format: "gzip" },
  ): Promise<string> => {
    served = await serve({}, new Compression(options), (context: Context) => {
      context.setHeader("Content-Type", "text/plain");
      return handler(context);
    });
    return served.url;
  };

  afterEach(async () => {
    const current = served;
    served = null;
    await current?.close();
  });

  test("a compressed reply keeps its connection alive (chunked)", async () => {
    const body = text(4096);
    const url = await start((context: Context) => {
      const { pathname } = context.url;
      if (pathname === "/json") {
        return context.json({ body });
      } else if (pathname === "/error") {
        // The reply of the default error handler
        throw new BindenError(400, { expose: true, json: { body } });
      }
      return context.send(body);
    });
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const outcomes: unknown[] = [];
      for (const path of ["/send", "/json", "/error", "/send"]) {
        const sent = request(new URL(path, url), {
          agent,
          headers: gzip,
          signal: AbortSignal.timeout(5000),
        }).end();
        const [response] = (await within(once(sent, "response"))) as [
          IncomingMessage,
        ];
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        await within(once(response, "end"));
        const { headers } = response;
        const decoded = decode(
          headers["content-encoding"],
          Buffer.concat(chunks),
        );
        outcomes.push([
          path,
          response.statusCode,
          headers["transfer-encoding"],
          headers.connection,
          decoded.toString().includes(body),
          sent.reusedSocket,
        ]);
      }
      deepStrictEqual(outcomes, [
        ["/send", 200, "chunked", "keep-alive", true, false],
        ["/json", 200, "chunked", "keep-alive", true, true],
        ["/error", 400, "chunked", "keep-alive", true, true],
        ["/send", 200, "chunked", "keep-alive", true, true],
      ]);
    } finally {
      agent.destroy();
    }
  });

  test("the compressor is created for a compressed body only", async () => {
    const url = await start(
      (context) =>
        context.text(context.url.pathname === "/small" ? "small" : text(2048)),
      { format: "auto" },
    );
    const created = await gzips(async () => {
      await fetchRaw(url, { path: "/small", headers: gzip });
      await fetchRaw(url, { headers: { "Accept-Encoding": "identity" } });
      await fetchRaw(url, { method: "HEAD", headers: gzip });
      const response = await fetchRaw(url, { headers: gzip });
      deepStrictEqual(response.headers["content-encoding"], "gzip");
    });

    deepStrictEqual(created.length, 1);
  });

  /** Writes the data in chunks, with backpressure: the results of `write()` */
  const backpressure = async (expected: Buffer): Promise<void> => {
    const size = 64 * 1024;
    const results: unknown[] = [];
    const url = await start(async (context) => {
      const { response } = context;
      context.done = true;
      for (let offset = 0; offset < expected.length; offset += size) {
        const written = response.write(
          expected.subarray(offset, offset + size),
        );
        results.push(written);
        if (!written) {
          await once(response, "drain");
        }
      }
      await new Promise<void>((resolve) => {
        response.end(resolve);
      });
    });

    const response = await fetchRaw(url, { headers: gzip });
    sameBytes(decode("gzip", response.raw), expected);
    ok(results.includes(false));
  };

  test("keeps the backpressure of `write()` (a full compressor)", async () => {
    // Compressible data fills the compressor
    await backpressure(Buffer.alloc(1024 * 1024, "binden "));
  });

  test(
    "keeps the backpressure of `write()` (a full response)",
    { timeout: 15_000 },
    async () => {
      // Random data fills the response
      await backpressure(randomBytes(1024 * 1024));
    },
  );

  test("a slow client pauses the compressor", { timeout: 15_000 }, async () => {
    const expected = randomBytes(4 * 1024 * 1024);
    let ended = false;
    const buffered: number[] = [];
    const url = await start(async (context) => {
      context.done = true;
      const done = new Promise<void>((resolve) => {
        context.response.end(expected, () => {
          ended = true;
          resolve();
        });
      });
      await sleep(100);
      buffered.push(context.response.writableLength);
      await done;
    });

    const response = await respond(url);
    response.pause();
    await sleep(200);
    // Paused: the response cannot finish, and does not buffer the data
    deepStrictEqual(ended, false);
    ok(Number(buffered[0]) < 1024 * 1024, `${buffered[0]}`);
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk)).resume();
    await within(once(response, "end"));
    sameBytes(decode("gzip", Buffer.concat(chunks)), expected);
    deepStrictEqual(ended, true);
  });

  test(
    "a slow client pauses the compressor, whose `drain` the application cannot remove",
    { timeout: 15_000 },
    async () => {
      const expected = randomBytes(4 * 1024 * 1024);
      const url = await start(async (context) => {
        context.done = true;
        const { response } = context;
        // An application that removes the `drain` listeners it believes are
        // its own: the compressor resumes all the same
        const timer = setInterval(() => {
          response.removeAllListeners("drain");
        }, 1);
        try {
          await new Promise<void>((resolve) => {
            response.end(expected, resolve);
          });
        } finally {
          clearInterval(timer);
        }
      });

      const response = await respond(url);
      response.pause();
      await sleep(100);
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk)).resume();
      await within(once(response, "end"));
      sameBytes(decode("gzip", Buffer.concat(chunks)), expected);
    },
  );

  test("`send()` resolves once the response has finished", async () => {
    const events: string[] = [];
    const url = await start(async (context) => {
      context.response.once("finish", () => events.push("finish"));
      await context.send(text(2048));
      events.push("resolved");
      throw new BindenError(400, { expose: true, message: "late error" });
    });
    const response = await fetchRaw(url, { headers: gzip });

    deepStrictEqual(response.status, 200);
    deepStrictEqual(response.body, text(2048));
    deepStrictEqual(events, ["finish", "resolved"]);
  });

  test("`end()` as Node.js: its callback, a second `end()`, `writableEnded`", async () => {
    const states: unknown[] = [];
    const { promise: code, resolve } = Promise.withResolvers<unknown>();
    const url = await start(async (context) => {
      const { response } = context;
      context.done = true;
      states.push(response.writableEnded);
      response.write("first ");
      await new Promise<void>((done) => {
        response.end(text(2048), "utf8", () => {
          states.push(response.writableFinished);
          done();
        });
        states.push(response.writableEnded);
        // Ignored
        response.end("second");
      });
      // As for an uncompressed response, `send()` does nothing after `end()`
      await response.send(Readable.from(["third"]));
      // As Node.js, with `ERR_STREAM_ALREADY_FINISHED`
      response.end((error?: (Error & { code?: unknown }) | null) => {
        resolve(error?.code);
      });
    });
    const response = await fetchRaw(url, { headers: gzip });

    deepStrictEqual(response.body, `first ${text(2048)}`);
    deepStrictEqual(states, [false, true, true]);
    deepStrictEqual(await within(code), "ERR_STREAM_ALREADY_FINISHED");
  });

  test("an `end()` that throws does not end a compressed response", async () => {
    const states: unknown[] = [];
    const url = await start((context) => {
      const { response } = context;
      context.done = true;
      response.write(text(2048));
      for (const args of [[{}], ["x", "unknown"]]) {
        try {
          Reflect.apply(response.end.bind(response), response, [
            ...args,
            (): void => {
              states.push("called");
            },
          ]);
        } catch (error: unknown) {
          states.push((error as { code?: unknown }).code);
        }
        states.push(response.writableEnded);
      }
      // Ended now, with its chunk
      response.end(" end");
    });
    const response = await fetchRaw(url, { headers: gzip });

    deepStrictEqual(response.body, `${text(2048)} end`);
    deepStrictEqual(states, [
      "ERR_INVALID_ARG_TYPE",
      false,
      "ERR_UNKNOWN_ENCODING",
      false,
    ]);
  });

  test("`end()` with a callback only, while the response is not finished", async () => {
    const url = await start(async (context) => {
      const { response } = context;
      context.done = true;
      response.write(text(2048));
      response.end();
      await new Promise<void>((resolve) => {
        response.end(resolve);
      });
    });
    const response = await fetchRaw(url, { headers: gzip });

    deepStrictEqual(response.body, text(2048));
  });

  test("a response started by compressed data is kept (`done`)", async () => {
    const url = await start((context) => {
      // Waits in the compressor
      context.response.write("x");
      context.done = true;
      setTimeout(() => {
        context.response.end("y");
      }, 50);
    });
    const response = await fetchRaw(url, { headers: gzip });

    deepStrictEqual(response.body, "xy");
  });

  test("an error after the first write cuts the response", async () => {
    const url = await start((context) => {
      context.response.write("prefix ");
      throw new BindenError(400, { expose: true, message: "invalid request" });
    });

    // A truncated body must not look complete
    await rejects(fetchRaw(url, { headers: gzip }));
  });

  test(
    "writes fail once the client has gone away",
    { timeout: 15_000 },
    async () => {
      const { promise: failed, resolve } = Promise.withResolvers<unknown>();
      const { promise: written, resolve: started } =
        Promise.withResolvers<null>();
      const url = await start((context) => {
        context.done = true;
        // More than the connection takes: the next write waits
        context.response.write(randomBytes(8 * 1024 * 1024));
        context.response.write("next", (error?: Error | null) => {
          resolve((error as { code?: unknown } | null | undefined)?.code);
        });
        started(null);
      });

      const response = await respond(url);
      await within(written);
      response.destroy();

      deepStrictEqual(await within(failed), "ERR_STREAM_DESTROYED");
    },
  );

  test("a write after `end()` fails, the response is sent", async () => {
    const { promise: code, resolve } = Promise.withResolvers<unknown>();
    const url = await start((context) => {
      const { response } = context;
      response.end(text(2048));
      response.write("late");
      const written = response.write("late", (error?: Error | null) => {
        resolve((error as { code?: unknown } | null | undefined)?.code);
      });
      deepStrictEqual(written, false);
      context.done = true;
    });
    const response = await fetchRaw(url, { headers: gzip });

    deepStrictEqual(response.body, text(2048));
    deepStrictEqual(await within(code), "ERR_STREAM_WRITE_AFTER_END");
  });

  test(
    "`send()` rejects when the client goes away",
    { timeout: 15_000 },
    async () => {
      const { promise: settled, resolve } = Promise.withResolvers<unknown>();
      const url = await start(async (context) => {
        try {
          await context.send(randomBytes(16 * 1024 * 1024));
          resolve(null);
        } catch (error: unknown) {
          resolve((error as { code?: unknown }).code);
        }
      });

      const response = await respond(url);
      response.destroy();

      // With the error of its write that the compressor has not taken, as
      // without a compression (which gets the error of the socket)
      deepStrictEqual(await within(settled), "ERR_STREAM_DESTROYED");
    },
  );

  test("a failure of the compressor closes the connection", async () => {
    await gzips(async (created) => {
      const url = await start(async (context) => {
        context.done = true;
        context.response.write("data");
        await sleep(20);
        // E.g. out of memory (the compressor of the response is the last one)
        created.at(-1)?.destroy(new Error("The compressor has failed"));
      });
      // At once (not the timeout of the request)
      await rejects(fetchRaw(url, { headers: gzip }), { code: "ECONNRESET" });
    });
  });
});
