import { Binden, type Context } from "../index.js";
import { PassThrough, Readable } from "node:stream";
import { capture, listen, send, sleep, within } from "./helpers.js";
import { deepStrictEqual, ok } from "node:assert/strict";
import { suite, test } from "node:test";
import { connect } from "node:net";
import { once } from "node:events";

/** How a send has settled: `resolved`, or its error (its `code`, or itself) */
function outcomeOf(promise: Promise<void>): Promise<unknown> {
  return promise.then(
    () => "resolved",
    (error: unknown) => (error as { code?: unknown }).code ?? error,
  );
}

/** A source of one chunk, paused (`readableFlowing === false`) by `pause()` or by an `unpipe()` */
function paused(how: "pause" | "unpipe", chunk = "hello"): Readable {
  const source = new Readable({
    read(): void {
      this.push(chunk);
      this.push(null);
    },
  });
  if (how === "pause") {
    source.pause();
  } else {
    // E.g. a tee that is detached
    const side = new PassThrough();
    source.pipe(side);
    source.unpipe(side);
  }
  return source;
}

/** Runs the middleware for one request, and resolves with the reply and the outcome of its send */
async function replied(
  middleware: (context: Context) => Promise<void>,
  request: Parameters<typeof send>[1] = {},
): Promise<[number, string, unknown]> {
  const outcome = Promise.withResolvers<unknown>();
  const app = new Binden({ logger: capture().logger }).use(
    async (context: Context) => {
      await middleware(context).then(
        () => {
          outcome.resolve("resolved");
        },
        (error: unknown) => {
          outcome.resolve((error as { code?: unknown }).code ?? error);
          throw error;
        },
      );
    },
  );
  const listening = await listen(app);
  try {
    const { status, body } = await send(listening.port, {
      ms: 2000,
      ...request,
    });
    return [status, body, await within(outcome.promise)];
  } finally {
    await listening.close();
  }
}

suite("A paused Readable", () => {
  for (const how of ["pause", "unpipe"] as const) {
    test(`(by ${how === "pause" ? "`pause()`" : "an `unpipe()`"}) is read as the body, as \`pipe()\` reads it`, async () => {
      const source = paused(how);
      deepStrictEqual(source.readableFlowing, false);
      deepStrictEqual(await replied((context) => context.send(source)), [
        200,
        "hello",
        "resolved",
      ]);
    });
  }

  test("is destroyed without being read for `HEAD`", async () => {
    let reads = 0;
    const source = new Readable({
      read(): void {
        reads += 1;
        this.push(null);
      },
    });
    source.pause();
    deepStrictEqual(
      await replied((context) => context.send(source), { method: "HEAD" }),
      [200, "", "resolved"],
    );
    deepStrictEqual([source.destroyed, reads], [true, 0]);
  });

  for (const how of ["pause", "unpipe"] as const) {
    test(`the request of the response (paused by ${how === "pause" ? "`pause()`" : "an `unpipe()`, as by a body parser that refuses it"}) is echoed`, async () => {
      deepStrictEqual(
        await replied(
          async (context) => {
            const { request } = context;
            if (how === "pause") {
              request.pause();
            } else {
              const sink = new PassThrough();
              request.pipe(sink);
              request.unpipe(sink);
            }
            deepStrictEqual(request.readableFlowing, false);
            await context.send(request);
          },
          {
            method: "POST",
            headers: { "Content-Length": 5 },
            body: "hello",
          },
        ),
        [200, "hello", "resolved"],
      );
    });
  }

  test("whose `resume()` throws: the send rejects with its error at once, which can still be replied", async () => {
    const failure = new Error("Not resumed");
    const source = new (class extends Readable {
      // eslint-disable-next-line class-methods-use-this -- it never resumes
      public override resume(): this {
        throw failure;
      }
    })({
      read(): void {
        // Never read
      },
    });
    source.pause();
    const reply = await replied(async (context) => {
      const error = await outcomeOf(context.send(source));
      // Destroyed with it, once the send has settled
      deepStrictEqual(
        [error, context.response.started, source.destroyed],
        [failure, false, true],
      );
      throw error;
    });
    deepStrictEqual(reply, [500, "", failure]);
  });

  test(
    "while the response needs a drain: stays paused until it drains, then is read",
    {
      // Windows takes a whole write while its send buffer has room: the
      // response may not need a drain long enough
      skip: process.platform === "win32",
    },
    async () => {
      const size = 8 * 1024 * 1024;
      const waiting = Promise.withResolvers<unknown[]>();
      const outcome = Promise.withResolvers<unknown>();
      let reads = 0;
      const source = new Readable({
        read(): void {
          reads += 1;
          this.push("tail");
          this.push(null);
        },
      });
      source.pause();
      const app = new Binden({ logger: capture().logger }).use(
        async (context: Context) => {
          const { response } = context;
          // Its client does not read yet
          response.write(Buffer.alloc(size, "a"));
          const needed = response.writableNeedDrain;
          const sent = outcomeOf(context.send(source));
          await sleep(50);
          waiting.resolve([needed, source.readableFlowing, reads]);
          outcome.resolve(await sent);
        },
      );
      const listening = await listen(app);
      const socket = connect(listening.port, "localhost");
      try {
        await once(socket, "connect");
        let tail = "";
        socket
          .on("data", (chunk: Buffer) => {
            tail = (tail + chunk.toString("latin1")).slice(-100);
          })
          .on("error", () => {
            // Closed by the server: `close` follows
          })
          .pause();
        socket.write(
          "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        );
        deepStrictEqual(await within(waiting.promise), [true, false, 0]);
        socket.resume();
        deepStrictEqual(await within(outcome.promise, 5000), "resolved");
        await within(once(socket, "close"), 5000);
        ok(tail.endsWith("4\r\ntail\r\n0\r\n\r\n"), tail);
        deepStrictEqual(reads, 1);
      } finally {
        socket.destroy();
        await listening.close();
      }
    },
  );
});
