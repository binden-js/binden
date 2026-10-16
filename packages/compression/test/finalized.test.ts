import { type Context, type IBindenOptions, shutdown } from "binden";
import { type IServed, gzips, serve, sleep } from "./helpers.js";
import { afterEach, suite, test } from "node:test";
import { Compression } from "../index.js";
import { connect } from "node:net";
import { deepStrictEqual } from "node:assert/strict";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import type zlib from "node:zlib";

/** Resolves once `ready()` holds, polled every 5 ms, or after `ms` milliseconds */
async function until(ready: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready() && Date.now() < deadline) {
    await sleep(5);
  }
}

/** What has become of a reply that waits for the one before it */
interface IOutcome {
  /** Whether its compressor is destroyed */
  readonly destroyed: boolean[];
  /** Whether its response has closed */
  readonly closed: boolean;
  /** How many times its cleanup has run */
  readonly cleanups: number;
}

suite("A compressed reply queued past its deadline", () => {
  const servers: IServed[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (served) => served.close()));
  });

  /**
   * Pipelines a slow `/` (without a deadline) and a `/next` (with a deadline
   * of 50 ms) that `next` replies to through a compression: once the
   * deadline of `/next` has passed while it waits for `/`, `close` ends the
   * connection
   */
  const queued = async (
    next: (context: Context) => Promise<void> | void,
    close: (served: IServed, socket: ReturnType<typeof connect>) => unknown,
    app: IBindenOptions = {},
  ): Promise<IOutcome> => {
    let response: Context["response"] | null = null;
    let cleanups = 0;
    let compressors: readonly zlib.Gzip[] = [];
    // Before: it creates a compressor of its own (to check its options)
    const compression = new Compression({ format: "gzip", threshold: 0 });
    await gzips(async (created) => {
      compressors = created;
      const served = await serve(
        { app: { timeout: 50, ...app } },
        compression,
        async (context: Context) => {
          if (context.url.pathname === "/") {
            context.setTimeout(0);
            await once(context.response, "close");
            return;
          }
          ({ response } = context);
          context.onCleanup(() => {
            cleanups += 1;
          });
          await next(context);
        },
      );
      servers.push(served);
      const socket = connect(Number(new URL(served.url).port), "localhost");
      socket.on("error", () => null);
      await once(socket, "connect");
      socket.write(
        "GET / HTTP/1.1\r\nHost: a\r\nAccept-Encoding: gzip\r\n\r\n" +
          "GET /next HTTP/1.1\r\nHost: a\r\nAccept-Encoding: gzip\r\n\r\n",
      );
      // Past the deadline of `/next`, which has created its compressor
      await until(() => created.length > 0);
      await sleep(150);
      await close(served, socket);
      await until(
        () =>
          created.every((compressor) => compressor.destroyed) &&
          cleanups > 0 &&
          (response?.closed ?? false),
      );
      // Once only
      await sleep(30);
    });
    return {
      destroyed: compressors.map((compressor) => compressor.destroyed),
      closed: (response as Context["response"] | null)?.closed ?? false,
      cleanups,
    };
  };

  /** Ends its reply at once: a large body that waits in the compressor */
  const ended = (context: Context): void => {
    context.response.setHeader("Content-Type", "application/json");
    context.response.end(randomBytes(1024 * 1024));
  };

  const finalized: IOutcome = {
    destroyed: [true],
    closed: true,
    cleanups: 1,
  };

  test("ended, then the client goes away: its compressor is destroyed", async () => {
    deepStrictEqual(
      await queued(ended, (_served, socket) => socket.destroy()),
      finalized,
    );
  });

  test("ended, then a shutdown closes its connection: its compressor is destroyed", async () => {
    let settled = "pending";
    const outcome = await queued(ended, async ({ server }) => {
      settled = await Promise.race([
        shutdown(server, { timeout: 50, cleanup_timeout: 200 }).then(
          () => "resolved",
          (error: unknown) => (error as Error).message,
        ),
        sleep(2000).then(() => "pending"),
      ]);
    });
    deepStrictEqual([outcome, settled], [finalized, "resolved"]);
  });

  test("the reply of the error handler of its deadline, then the client goes away: its compressor is destroyed", async () => {
    deepStrictEqual(
      await queued(
        () =>
          new Promise<void>(() => {
            // Never settles: replied by the error handler at its deadline
          }),
        (_served, socket) => socket.destroy(),
        {
          error_handler: (context: Context): void => {
            const { response } = context;
            response.status(503).type("text/plain");
            // Large, and hardly compressible: it waits in the compressor
            response.end(randomBytes(1024 * 1024).toString("base64"));
          },
        },
      ),
      finalized,
    );
  });
});
