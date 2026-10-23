import { type Context, type IMiddleware } from "binden";
import {
  type IServed,
  compressors,
  fetchRaw,
  gzips,
  pollUntil,
  serve,
  sleep,
  text,
  within,
} from "./helpers.js";
import { type Socket, connect } from "node:net";
import { afterEach, suite, test } from "node:test";
import { Compression } from "../index.js";
import { deepStrictEqual } from "node:assert/strict";
import { once } from "node:events";
// The owners of the works (internal to binden), which the callbacks keep
import { owners } from "../../binden/dist/src/seal.js";
import { randomBytes } from "node:crypto";

const gzip = { "Accept-Encoding": "gzip" };

/** A callback as it has been called: its name, owner, receiver and arguments */
type ICall = [string, string, string, unknown[]];

/** What a callback has been called with, as the tests compare it */
function describe(value: unknown): unknown {
  return value instanceof Error
    ? (value as { code?: unknown }).code
    : value === null
      ? null
      : typeof value;
}

/**
 * Records the calls of the callbacks of a work: by the owner of the work
 * that calls them (`stack`, or `none` for a work of no request), and by
 * their receiver (`response`, the list of the end callbacks of Node.js 26,
 * `none`, or the buffered write of the socket that Node.js 24 calls the
 * callback of a write with)
 */
function recorder(
  calls: ICall[],
  response: object,
): (name: string) => () => void {
  const stack = owners.getStore();
  return (name: string) =>
    function recorded(this: unknown, ...args: unknown[]): void {
      const owner = owners.getStore();
      calls.push([
        name,
        owner === stack ? "stack" : typeof owner === "undefined" ? "none" : "?",
        this === response
          ? "response"
          : Array.isArray(this)
            ? "list"
            : typeof this === "undefined"
              ? "none"
              : "request",
        args.map(describe),
      ]);
    };
}

/** Resolves once `count` callbacks have been called (rejects after 10 s) */
async function calledBack(
  calls: readonly ICall[],
  count: number,
): Promise<void> {
  await pollUntil(() => calls.length >= count).catch(() => {
    throw new Error(`${calls.length} of ${count} callbacks called`);
  });
}

/** The calls in the order of their names (their order differs by path) */
function sorted(calls: readonly ICall[]): ICall[] {
  return calls.toSorted(([a], [b]) => a.localeCompare(b));
}

/**
 * The replies of the tests: how they write their body, with callbacks of
 * the work and of works of no request (`owners.exit()`), which may write
 * before the response is sealed
 */
const replies: Record<
  string,
  (
    response: Context["response"],
    record: (name: string) => () => void,
  ) => Promise<void> | void
> = {
  "write() decides": (response, record) => {
    response.write(text(64), record("write"));
    owners.exit(() => response.write(text(64), "utf8", record("write none")));
    response.end(text(64), record("end"));
    owners.exit(() => response.end(record("end none")));
  },
  "end() decides": (response, record) => {
    response.end(text(64), "utf8", record("end"));
    owners.exit(() => response.end(record("end none")));
  },
  "writeHead() decides": (response, record) => {
    response.writeHead(200);
    owners.exit(() => response.write(text(64), record("write none")));
    response.end(record("end"));
  },
  "end() once the body has been sent": async (response, record) => {
    response.write(text(64), record("write"));
    await response.flush();
    await sleep(20);
    response.end(text(64), record("end"));
  },
};

/** The calls that each reply makes */
const counts: Record<string, number> = {
  "write() decides": 4,
  "end() decides": 2,
  "writeHead() decides": 2,
  "end() once the body has been sent": 2,
};

suite("The callbacks of `write()` and `end()`", () => {
  const servers: IServed[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (served) => served.close()));
  });

  /** The calls of the callbacks of a reply, with or without the compression */
  const callsOf = async (
    reply: string,
    compression: boolean,
    accept: string,
  ): Promise<{ status: number; calls: ICall[] }> => {
    const calls: ICall[] = [];
    const middlewares: IMiddleware[] = compression
      ? [new Compression({ format: "gzip", threshold: 0 })]
      : [];
    const served = await serve({}, ...middlewares, async (context: Context) => {
      const { response } = context;
      context.done = true;
      response.type("text/plain");
      await replies[reply](response, recorder(calls, response));
    });
    servers.push(served);
    const { status } = await fetchRaw(served.url, {
      headers: { "Accept-Encoding": accept },
    });
    await calledBack(calls, counts[reply]);
    // None runs twice
    await sleep(30);
    return { status, calls: sorted(calls) };
  };

  test("run once, as the work that has called them, with the receiver and the arguments of Node.js", async () => {
    for (const reply of Object.keys(replies)) {
      const plain = await callsOf(reply, false, "gzip");
      // As binden calls them: by their owner, with the receivers of the
      // version of Node.js
      deepStrictEqual(
        plain.calls.map(([name, owner]) => [name, owner]),
        plain.calls.map(([name]) => [
          name,
          name.endsWith(" none") ? "none" : "stack",
        ]),
        reply,
      );
      // The compressor (and the replacement) calls the callback of a write
      // as the callback of a stream: Node.js 24 calls those of the socket
      // with the write that it has buffered
      const written = plain.calls.map(
        ([name, owner, receiver, args]): ICall => [
          name,
          owner,
          name.startsWith("write") ? "none" : receiver,
          args,
        ],
      );
      for (const [accept, status, expected] of [
        ["identity", 200, plain.calls],
        ["gzip", 200, written],
        ["identity;q=0", 406, written],
      ] as const) {
        deepStrictEqual(
          await callsOf(reply, true, accept),
          { status, calls: expected },
          `${reply}: ${accept}`,
        );
      }
    }
  });

  test("of `end()` run once with an error when the compressed response is destroyed before its end", async () => {
    for (const reason of [null, "ECONNRESET"]) {
      const calls: ICall[] = [];
      const states: unknown[] = [];
      const served = await serve(
        {},
        new Compression({ format: "gzip", threshold: 0 }),
        (context: Context) => {
          const { response } = context;
          context.done = true;
          const record = recorder(calls, response);
          response.type("text/plain");
          response.write(text(64));
          response.end(text(64), record("end"));
          owners.exit(() => response.end(record("end none")));
          // Before the compressor has ended (e.g. the client has gone away)
          response.destroy(
            ...(reason === null
              ? []
              : [Object.assign(new Error("gone"), { code: reason })]),
          );
          states.push(response.writableEnded, response.writableFinished);
        },
      );
      servers.push(served);
      await fetchRaw(served.url, { headers: gzip }).catch(() => null);
      await calledBack(calls, 2);
      await sleep(30);

      // The error of the response, if any
      const code = reason ?? "ERR_STREAM_DESTROYED";
      deepStrictEqual(states, [true, false]);
      deepStrictEqual(sorted(calls), [
        ["end", "stack", "none", [code]],
        ["end none", "none", "none", [code]],
      ]);
    }
  });

  test("of an `end()` after a destroyed compressed response are left to Node.js", async () => {
    const calls: ICall[] = [];
    const { promise: closed, resolve } = Promise.withResolvers<null>();
    const served = await serve(
      {},
      new Compression({ format: "gzip", threshold: 0 }),
      (context: Context) => {
        const { response } = context;
        context.done = true;
        response.type("text/plain");
        response.write(text(64));
        response.once("close", () => {
          response.end(text(64), recorder(calls, response)("end"));
          resolve(null);
        });
        response.destroy();
      },
    );
    servers.push(served);
    await fetchRaw(served.url, { headers: gzip }).catch(() => null);
    await within(closed);
    await sleep(50);

    // As for an `end()` of a response that has been destroyed
    deepStrictEqual(calls, []);
  });
});

/** The codings of the compressors */
const codings = ["gzip", "br", "deflate", "zstd"] as const;

/**
 * The options of a test whose response is backed up by a client that reads
 * nothing: Windows takes a whole write while its send buffer has room, so
 * that the compressor may never wait for the response
 */
const backedUpBySlowClient = {
  skip: process.platform === "win32",
  timeout: 60_000,
};

/**
 * Sends a request that accepts `coding` (after `before`, e.g. a request that
 * the response waits for) on a new connection that is never read (a slow
 * client): the connection, which the test closes
 */
async function slowClient(
  url: string,
  coding: string,
  before = "",
): Promise<Socket> {
  const socket = connect(Number(new URL(url).port), "127.0.0.1");
  socket.on("error", () => null);
  await within(once(socket, "connect"));
  socket.pause();
  socket.write(
    `${before}GET /next HTTP/1.1\r\nHost: localhost\r\nAccept-Encoding: ${coding}\r\n\r\n`,
  );
  return socket;
}

/**
 * Resolves once the writes of a response wait for its `drain`: the client
 * reads nothing, and the compressor is paused (rejects after 10 s)
 */
async function full(response: Context["response"]): Promise<void> {
  await pollUntil(() => response.writableNeedDrain).catch(() => {
    throw new Error("The response has not been backed up");
  });
}

/**
 * A recorded callback (see `recorder()`) that also settles a promise: it
 * resolves, or rejects with the error that it is called with
 */
function settling(
  recorded: () => void,
  resolve: () => void,
  reject: (error: unknown) => void,
): (error?: Error | null) => void {
  return function settled(this: unknown, ...args: unknown[]): void {
    Reflect.apply(recorded, this, args);
    const [error] = args as [Error | null | undefined];
    if (error) {
      reject(error);
    } else {
      resolve();
    }
  };
}

/** The code of an error (as the tests compare it) */
function codeOf(error: unknown): unknown {
  return (error as { code?: unknown }).code;
}

suite("The callbacks of a compressed response that is destroyed", () => {
  const servers: IServed[] = [];
  const sockets: Socket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.destroy();
    }
    await Promise.all(servers.splice(0).map(async (served) => served.close()));
  });

  test(
    "of a large write that the middleware awaits run once with the error when the client resets",
    backedUpBySlowClient,
    async () => {
      for (const coding of codings) {
        const calls: ICall[] = [];
        const steps: unknown[] = [];
        const { promise: backedUp, resolve: backed } =
          Promise.withResolvers<null>();
        const { promise: settled, resolve: settle } =
          Promise.withResolvers<null>();
        const served = await serve(
          {},
          new Compression({ format: coding, threshold: 0 }),
          async (context: Context) => {
            const { response } = context;
            context.done = true;
            response.type("text/plain");
            const written = recorder(calls, response)("write");
            try {
              // Incompressible: it waits in the compressor, which the
              // response has paused
              await new Promise<void>((resolve, reject) => {
                response.write(
                  randomBytes(8 * 1024 * 1024),
                  settling(written, resolve, reject),
                );
                backed(full(response).then(() => null));
              });
              steps.push("written");
            } catch (error: unknown) {
              steps.push(codeOf(error));
            } finally {
              steps.push("finally");
              settle(null);
            }
          },
        );
        servers.push(served);
        const socket = await slowClient(served.url, coding);
        sockets.push(socket);
        await within(backedUp);
        socket.resetAndDestroy();
        await within(settled);
        // None runs twice
        await sleep(50);

        deepStrictEqual(
          { coding, calls, steps },
          {
            coding,
            calls: [["write", "stack", "none", ["ERR_STREAM_DESTROYED"]]],
            steps: ["ERR_STREAM_DESTROYED", "finally"],
          },
        );
      }
    },
  );

  test(
    "of many writes and of the end run once each, in order, when the client resets",
    backedUpBySlowClient,
    async () => {
      for (const coding of codings) {
        const calls: ICall[] = [];
        let finallies = 0;
        const { promise: backedUp, resolve: backed } =
          Promise.withResolvers<null>();
        const { promise: settled, resolve: settle } =
          Promise.withResolvers<null>();
        const served = await serve(
          {},
          new Compression({ format: coding, threshold: 0 }),
          async (context: Context) => {
            const { response } = context;
            context.done = true;
            response.type("text/plain");
            const record = recorder(calls, response);
            try {
              for (let index = 0; index < 256; index += 1) {
                response.write(randomBytes(64 * 1024), record(`${index}`));
              }
              response.end(record("end"));
              backed(full(response).then(() => null));
              await once(response, "close");
            } finally {
              finallies += 1;
              settle(null);
            }
          },
        );
        servers.push(served);
        const socket = await slowClient(served.url, coding);
        sockets.push(socket);
        await within(backedUp);
        socket.resetAndDestroy();
        await within(settled);
        await calledBack(calls, 257);
        await sleep(50);

        // The writes that the compressor has taken, then the others and the
        // end with the error
        const failed = calls.findIndex(([, , , [error]]) => error !== null);
        deepStrictEqual(
          { coding, finallies, calls },
          {
            coding,
            finallies: 1,
            calls: [...Array.from(Array(256).keys(), String), "end"].map(
              (name, index): ICall => [
                name,
                "stack",
                "none",
                [index < failed ? null : "ERR_STREAM_DESTROYED"],
              ],
            ),
          },
        );
        // Some writes are still in the compressor
        deepStrictEqual(failed < 256, true);
      }
    },
  );

  test(
    "of the writes that the middleware awaits run once with the error when its deadline cuts a slow client",
    backedUpBySlowClient,
    async () => {
      for (const coding of codings) {
        const calls: ICall[] = [];
        const steps: unknown[] = [];
        const { promise: settled, resolve: settle } =
          Promise.withResolvers<null>();
        const served = await serve(
          {},
          new Compression({ format: coding, threshold: 0 }),
          async (context: Context) => {
            const { response } = context;
            response.type("text/plain");
            const record = recorder(calls, response);
            // Its deadline passes only once the client, which reads nothing,
            // has backed the response up: the compressor is paused until the
            // response drains, so that the write that waits then is never
            // called back before. A fixed deadline could pass while the
            // compressor still compresses a write (e.g. slowly, on a loaded
            // machine), which then succeeds, and the writes after it are
            // ignored. A drain of the response removes it until the response
            // is backed up again
            let armed = false;
            response.on("drain", () => {
              if (armed && !response.writableNeedDrain) {
                armed = false;
                context.setTimeout(0);
              }
            });
            const watch = setInterval(() => {
              if (!armed && response.writableNeedDrain) {
                armed = true;
                context.setTimeout(20);
              }
            }, 5).unref();
            try {
              for (let index = 0; index < 64; index += 1) {
                const written = record(`${index}`);
                await new Promise<void>((resolve, reject) => {
                  response.write(
                    randomBytes(256 * 1024),
                    settling(written, resolve, reject),
                  );
                });
              }
              steps.push("written");
            } catch (error: unknown) {
              steps.push(codeOf(error));
            } finally {
              clearInterval(watch);
              steps.push("finally");
              settle(null);
            }
          },
        );
        servers.push(served);
        sockets.push(await slowClient(served.url, coding));
        await within(settled);
        await sleep(50);

        // Each one once the one before has been called back: the last one
        // with the error
        deepStrictEqual(
          { coding, calls, steps },
          {
            coding,
            calls: calls.map(([name], index): ICall => [
              name,
              "stack",
              "none",
              [index < calls.length - 1 ? null : "ERR_STREAM_DESTROYED"],
            ]),
            steps: ["ERR_STREAM_DESTROYED", "finally"],
          },
        );
      }
    },
  );

  test("of a write that the compressor is compressing run once with the error of the response", async () => {
    for (const coding of codings) {
      for (const reason of [null, "ECONNRESET"]) {
        const calls: ICall[] = [];
        const served = await serve(
          {},
          new Compression({ format: coding, threshold: 0 }),
          (context: Context) => {
            const { response } = context;
            context.done = true;
            response.type("text/plain");
            response.write(
              randomBytes(1024 * 1024),
              recorder(calls, response)("write"),
            );
            // While the compressor compresses it, without backpressure: it
            // calls it back once it has (without an error) afterwards
            response.destroy(
              ...(reason === null
                ? []
                : [Object.assign(new Error("gone"), { code: reason })]),
            );
          },
        );
        servers.push(served);
        await fetchRaw(served.url, {
          headers: { "Accept-Encoding": coding },
        }).catch(() => null);
        await calledBack(calls, 1);
        await sleep(100);

        deepStrictEqual(
          { coding, calls },
          {
            coding,
            calls: [
              ["write", "stack", "none", [reason ?? "ERR_STREAM_DESTROYED"]],
            ],
          },
        );
      }
    }
  });

  test("of `end()` run once when the response is destroyed as the compressor ends", async () => {
    // A response that waits for the one before it (no socket yet) closes on
    // the next tick (before the end of the compressor, since Node.js 24.16),
    // another one once its socket has closed (after the end)
    const first = "GET / HTTP/1.1\r\nHost: localhost\r\n\r\n";
    for (const before of ["", first]) {
      const calls: ICall[] = [];
      const { promise: closed, resolve } = Promise.withResolvers<null>();
      await gzips(async (created) => {
        const served = await serve(
          {},
          new Compression({ format: "gzip", threshold: 0 }),
          async (context: Context) => {
            const { response } = context;
            if (context.url.pathname === "/") {
              await sleep(200);
              response.end();
              return;
            }
            context.done = true;
            response.type("text/plain");
            response.write(text(64));
            // Compressed
            await sleep(20);
            // The last compressed bytes: the compressor emits its end on the
            // next tick
            created.at(-1)?.once("data", () => {
              response.destroy();
            });
            response.end(recorder(calls, response)("end"));
            await once(response, "close");
            resolve(null);
          },
        );
        servers.push(served);
        sockets.push(await slowClient(served.url, "gzip", before));
        await within(closed);
        await calledBack(calls, 1);
        await sleep(50);
      });

      deepStrictEqual(
        { before, calls },
        {
          before,
          calls: [["end", "stack", "none", ["ERR_STREAM_DESTROYED"]]],
        },
      );
    }
  });

  test("of `end()` run once when the end of the response destroys it", async () => {
    for (const order of ["destroyed", "ended"]) {
      const calls: ICall[] = [];
      const { promise: closed, resolve } = Promise.withResolvers<null>();
      const served = await serve(
        {},
        (context: Context) => {
          // E.g. an instrumentation of `end()`, under the compression: the
          // response is destroyed by the end of the compressed response,
          // before (or once) Node.js takes its callbacks
          const { response } = context;
          const end = response.end.bind(response) as (
            ...args: unknown[]
          ) => Context["response"];
          response.end = (...args: unknown[]): Context["response"] => {
            if (order === "destroyed") {
              response.destroy();
              return end(...args);
            }
            const ended = end(...args);
            response.destroy();
            return ended;
          };
        },
        new Compression({ format: "gzip", threshold: 0 }),
        async (context: Context) => {
          const { response } = context;
          context.done = true;
          response.type("text/plain");
          response.end(text(64), recorder(calls, response)("end"));
          await once(response, "close");
          resolve(null);
        },
      );
      servers.push(served);
      await fetchRaw(served.url, { headers: gzip }).catch(() => null);
      await within(closed);
      await calledBack(calls, 1);
      await sleep(50);

      // Destroyed before: with the error once it has closed. Afterwards: as
      // Node.js calls it (by the version of Node.js), and not again
      deepStrictEqual(
        { order, calls: calls.map(([name, owner]) => [name, owner]) },
        { order, calls: [["end", "stack"]] },
      );
      if (order === "destroyed") {
        deepStrictEqual(calls, [
          ["end", "stack", "none", ["ERR_STREAM_DESTROYED"]],
        ]);
      }
    }
  });
});

/** The codings, and `null` without a compression */
const modes = [null, ...codings] as const;

/** The sizes of the writes: within the buffers, and far beyond them */
const sizes = [100, 8 * 1024 * 1024] as const;

/**
 * How the response of a middleware is gone before its first write: its
 * client goes away while the middleware waits for something else (e.g. a
 * query), the middleware destroys it, or its connection closes while the
 * `filter` of the compression decides (its `close` emitted at once)
 */
type IGone = "client" | "destroy" | "filter";

/** The options of `writeGone()` */
interface IGoneOptions {
  /** The coding of the compression, `null` without one */
  readonly coding: (typeof modes)[number];
  readonly size: number;
  readonly gone: IGone;
  /** What the middleware does before its write (nothing by default) */
  readonly reply?:
    ((response: Context["response"], chunk: Buffer) => void) | undefined;
}

suite("The callbacks of a response that is gone before the decision", () => {
  const servers: IServed[] = [];
  const sockets: Socket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.destroy();
    }
    await Promise.all(servers.splice(0).map(async (served) => served.close()));
  });

  /**
   * How a middleware writes once its response is gone: the calls of the
   * callback of the write that it awaits, its steps (the error of that
   * write, then its `finally`), and whether each compressor created is
   * destroyed
   */
  const writeGone = async ({
    coding,
    size,
    gone,
    reply = (): null => null,
  }: IGoneOptions): Promise<{
    calls: ICall[];
    steps: unknown[];
    created: boolean[];
  }> => {
    const calls: ICall[] = [];
    const steps: unknown[] = [];
    const { promise: started, resolve: start } = Promise.withResolvers<null>();
    const { promise: settled, resolve: settle } = Promise.withResolvers<null>();
    const filter = (context: Context): boolean => {
      if (gone === "filter") {
        context.request.socket.emit("close", false);
      }
      return true;
    };
    const middlewares =
      coding === null
        ? []
        : [new Compression({ format: coding, threshold: 0, filter })];
    const created = await compressors(async () => {
      const served = await serve(
        {},
        ...middlewares,
        async (context: Context) => {
          const { response } = context;
          context.done = true;
          response.type("text/plain");
          const written = recorder(calls, response)("write");
          try {
            start(null);
            if (gone === "client") {
              // Listened to before the client goes away (see `started`)
              await once(response, "close");
            } else if (gone === "destroy") {
              response.destroy();
            }
            await new Promise<void>((resolve, reject) => {
              reply(response, randomBytes(size));
              response.write(
                randomBytes(size),
                settling(written, resolve, reject),
              );
            });
            steps.push("written");
          } catch (error: unknown) {
            steps.push(codeOf(error));
          } finally {
            steps.push("finally");
            settle(null);
          }
        },
      );
      servers.push(served);
      const socket = await slowClient(served.url, coding ?? "identity");
      sockets.push(socket);
      await within(started);
      if (gone === "client") {
        socket.destroy();
      }
      await within(settled);
      // None runs twice
      await sleep(30);
    });
    return {
      calls,
      steps,
      created: created.map((compressor) => compressor.destroyed),
    };
  };

  /** What a write gets, as without a compression */
  const failed = (
    error: string,
  ): Omit<Awaited<ReturnType<typeof writeGone>>, "created"> => ({
    calls: [["write", "stack", "none", [error]]],
    steps: [error, "finally"],
  });

  test("of a write that the middleware awaits once its client has gone away run once with the error, as without a compression, without a compressor", async () => {
    for (const coding of modes) {
      for (const size of sizes) {
        deepStrictEqual(
          {
            coding,
            size,
            ...(await writeGone({ coding, size, gone: "client" })),
          },
          { coding, size, ...failed("ERR_STREAM_DESTROYED"), created: [] },
        );
      }
    }
  });

  test("of a write that the middleware awaits once it has destroyed the response (not closed yet) run once with the error, without a compressor", async () => {
    for (const coding of modes) {
      for (const size of sizes) {
        deepStrictEqual(
          {
            coding,
            size,
            ...(await writeGone({ coding, size, gone: "destroy" })),
          },
          { coding, size, ...failed("ERR_STREAM_DESTROYED"), created: [] },
        );
      }
    }
  });

  test("of a write after `writeHead()`, `flushHeaders()` or `end()` once the client has gone away run once with the error, without a compressor", async () => {
    const commits: Record<
      string,
      (response: Context["response"], chunk: Buffer) => void
    > = {
      writeHead: (response) => response.writeHead(200),
      flushHeaders: (response) => {
        response.flushHeaders();
      },
      // Node.js never calls back the `end()` of a destroyed response
      end: (response, chunk) => response.end(chunk),
    };
    for (const coding of modes) {
      for (const [name, reply] of Object.entries(commits)) {
        // A write after the end of a response gets its own error
        const error =
          name === "end"
            ? "ERR_STREAM_WRITE_AFTER_END"
            : "ERR_STREAM_DESTROYED";
        deepStrictEqual(
          {
            coding,
            name,
            ...(await writeGone({ coding, size: 100, gone: "client", reply })),
          },
          { coding, name, ...failed(error), created: [] },
        );
      }
    }
  });

  test("of a write whose compressor starts once the connection has closed run once with the error, the compressor destroyed at once", async () => {
    for (const coding of codings) {
      for (const size of sizes) {
        deepStrictEqual(
          {
            coding,
            size,
            ...(await writeGone({ coding, size, gone: "filter" })),
          },
          { coding, size, ...failed("ERR_STREAM_DESTROYED"), created: [true] },
        );
      }
    }
  });
});
