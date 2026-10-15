import { Compression, skipCompression } from "../index.js";
import { type Context, type IBindenOptions, type IMiddleware } from "binden";
import {
  type IServed,
  capture,
  dechunk,
  exchange,
  fetchRaw,
  sameBytes,
  serve,
  sleep,
  text,
} from "./helpers.js";
import { afterEach, suite, test } from "node:test";
import { deepStrictEqual, ok } from "node:assert/strict";
import { randomBytes } from "node:crypto";
import zlib from "node:zlib";

/** A promise with its `resolve()` */
function gate(): { promise: Promise<void>; open(): void } {
  const { promise, resolve } = Promise.withResolvers<never>();
  return { promise, open: resolve as () => void };
}

suite("Compression of a response whose owner is abandoned", () => {
  const servers: IServed[] = [];

  const start = async (
    app: IBindenOptions,
    ...middlewares: IMiddleware[]
  ): Promise<IServed> => {
    const served = await serve({ app }, ...middlewares);
    servers.push(served);
    return served;
  };

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (served) => served.close()));
  });

  test("a timed out error handler that has ended a compressed reply under backpressure: all of it is sent", async () => {
    const body = randomBytes(8 * 1024 * 1024);
    const states: boolean[] = [];
    const captured = capture();
    const { url } = await start(
      {
        logger: captured.logger,
        error_handler_timeout: 100,
        error_handler: async (context: Context): Promise<void> => {
          const { response } = context;
          response.status(500).type("text/plain");
          // Not awaited: the client reads slowly
          response.send(body).catch(() => null);
          states.push(response.writableEnded, response.writableFinished);
          await sleep(200);
          states.push(response.writableFinished);
          // Once timed out
          response.destroy();
          response.write("late");
          response.end("late");
          await new Promise<void>(() => {
            // Never settles
          });
        },
      },
      new Compression({ format: "gzip" }),
      () => {
        throw new Error("Failed");
      },
    );
    const { head, body: raw } = await exchange(url, 500);
    ok(head.startsWith("HTTP/1.1 500 "), head);
    ok(/^content-encoding: gzip$/imu.test(head), head);
    const { body: compressed, complete } = dechunk(raw);
    ok(complete);
    sameBytes(zlib.gunzipSync(compressed), body);
    deepStrictEqual(states, [true, false, false]);
    ok(
      captured.records.some(
        ({ msg }) =>
          msg === "The provided `error_handler` has not settled in time",
      ),
    );
  });

  test("the writes of the abandoned work are ignored while the error handler replies", async () => {
    const abandoned = gate();
    const calls: string[] = [];
    let synchronous = 0;
    let returned: unknown[] = [];
    const reply = text(4096);
    const { url } = await start(
      {
        timeout: 20,
        error_handler: async (context: Context): Promise<void> => {
          context.response.status(503).type("text/plain");
          await abandoned.promise;
          await context.send(reply);
        },
      },
      new Compression({ format: "gzip" }),
      async (context: Context) => {
        const { response } = context;
        await sleep(60);
        const callback = (name: string) => (): void => {
          calls.push(name);
        };
        returned = [
          response.write("late", callback("write")),
          response.write("late", "utf8", callback("write-encoding")),
          response.end("late", callback("end")) === response,
          response.writeHead(200) === response,
        ];
        synchronous = calls.length;
        await response.flush();
        await sleep(10);
        abandoned.open();
      },
    );
    const received = await fetchRaw(url, {
      headers: { "Accept-Encoding": "gzip" },
    });
    deepStrictEqual(
      [received.status, received.headers["content-encoding"], received.body],
      [503, "gzip", reply],
    );
    deepStrictEqual(synchronous, 0);
    deepStrictEqual(returned, [true, true, true, true]);
    deepStrictEqual(calls.toSorted(), ["end", "write", "write-encoding"]);
  });

  test("`skipCompression()` and `run()` of the abandoned work do not change the reply of the error handler", async () => {
    const reply = text(4096);
    const late = new Compression({ format: "gzip", threshold: 0 });
    for (const [path, accept, coding] of [
      // The reply would be refused as it is
      ["/skip", "gzip, identity;q=0", "gzip"],
      // The reply would be compressed
      ["/run", "gzip", null],
    ] as const) {
      const abandoned = gate();
      const { url } = await start(
        {
          timeout: 20,
          error_handler: async (context: Context): Promise<void> => {
            context.response.status(503).type("text/plain");
            await abandoned.promise;
            await context.send(reply);
          },
        },
        ...(path === "/skip" ? [new Compression({ format: "gzip" })] : []),
        async (context: Context) => {
          await sleep(60);
          if (path === "/skip") {
            skipCompression(context.response);
          } else {
            late.run(context);
          }
          abandoned.open();
          await sleep(10);
        },
      );
      const received = await fetchRaw(url, {
        headers: { "Accept-Encoding": accept },
      });
      deepStrictEqual(
        [
          received.status,
          received.headers["content-encoding"] ?? null,
          received.body,
        ],
        [503, coding, reply],
        path,
      );
    }
  });
});
