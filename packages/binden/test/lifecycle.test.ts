import {
  Binden,
  BindenAbortError,
  BindenError,
  type Context,
  type IBindenOptions,
} from "../index.js";
import {
  type ICaptured,
  type IListening,
  capture,
  listen,
  never,
  send,
  sleep,
} from "./helpers.js";
import { deepStrictEqual, ok, rejects, throws } from "node:assert/strict";
import { suite, test } from "node:test";
import { Readable } from "node:stream";

/** Runs `fn` with a listening application (with a captured debug logger) */
async function withApp(
  options: IBindenOptions,
  setup: (app: Binden) => void,
  fn: (listening: IListening, captured: ICaptured) => Promise<void>,
): Promise<void> {
  const captured = capture();
  const app = new Binden({ ...options, logger: captured.logger });
  setup(app);
  const listening = await listen(app);
  try {
    await fn(listening, captured);
  } finally {
    await listening.close();
  }
}

suite("Lifecycle", () => {
  test("`timeout` and `error_handler_timeout` are validated", () => {
    for (const timeout of [
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "10",
      null,
    ]) {
      throws(
        () => new Binden({ timeout: timeout as number }),
        new TypeError("`timeout` is not an integer"),
      );
      throws(
        () => new Binden({ error_handler_timeout: timeout as number }),
        new TypeError("`error_handler_timeout` is not an integer"),
      );
    }
    for (const timeout of [-1, 2 ** 31]) {
      throws(() => new Binden({ timeout }), RangeError);
    }
    throws(
      () => new Binden({ error_handler_timeout: 0 }),
      new RangeError("`error_handler_timeout` is not between 1 and 2147483647"),
    );
    ok(
      new Binden({ timeout: 0, error_handler_timeout: 2 ** 31 - 1 }) instanceof
        Binden,
    );
    ok(
      new Binden({ timeout: 2 ** 31 - 1, error_handler_timeout: 1 }) instanceof
        Binden,
    );
  });

  test("a deadline stops the stack and replies `503` through the error handler", async () => {
    const errors: unknown[] = [];
    let reached = false;
    await withApp(
      {
        timeout: 30,
        error_handler: (context: Context, error: unknown): void => {
          errors.push(
            error,
            (context.signal.reason as BindenAbortError).reason,
          );
        },
      },
      (app) => {
        app.use(
          async () => {
            await never();
          },
          () => {
            reached = true;
          },
        );
      },
      async ({ port }) => {
        const response = await send(port);
        deepStrictEqual([response.status, response.body], [503, ""]);
      },
    );
    const [error, reason] = errors;
    ok(error instanceof BindenError);
    deepStrictEqual(
      [error.status, error.code, reason],
      [503, "deadline", "deadline"],
    );
    ok(!reached);
  });

  test("a deadline closes the connection once the reply has started", async () => {
    await withApp(
      { timeout: 30 },
      (app) => {
        app.use(async (context: Context) => {
          // Chunked: an ended reply would look complete
          context.response.writeHead(200);
          context.response.write("abc");
          await never();
        });
      },
      async ({ port }) => {
        await rejects(send(port), { code: "ECONNRESET" });
      },
    );
  });

  test("the late result of a middleware is ignored", async () => {
    let late = "pending";
    await withApp(
      { timeout: 20 },
      (app) => {
        app.use(async (context: Context) => {
          await sleep(60);
          // Resolves (without an error)
          await context.send("late");
          late = "resolved";
        });
      },
      async ({ port }, captured) => {
        const response = await send(port);
        deepStrictEqual([response.status, response.body], [503, ""]);
        await captured.waitFor("A late reply has been ignored");
      },
    );
    deepStrictEqual(late, "resolved");
  });

  test("a late failure of a middleware is logged", async () => {
    await withApp(
      { timeout: 20 },
      (app) => {
        app.use(async () => {
          await sleep(60);
          throw new Error("late");
        });
      },
      async ({ port }, captured) => {
        const response = await send(port);
        deepStrictEqual(response.status, 503);
        await captured.waitFor(
          "A middleware has failed after the request was aborted",
        );
      },
    );
  });

  test("a late reply does not replace the reply of the error handler", async () => {
    await withApp(
      {
        timeout: 20,
        error_handler: async (context: Context): Promise<void> => {
          // The late reply comes first
          await sleep(80);
          await context.status(503).send("handler");
        },
      },
      (app) => {
        app.use(async (context: Context) => {
          await sleep(40);
          await context.send("late");
        });
      },
      async ({ port }) => {
        const response = await send(port);
        deepStrictEqual([response.status, response.body], [503, "handler"]);
      },
    );
  });

  test("`context.setTimeout()` sets the deadline of a request", async () => {
    await withApp(
      {},
      (app) => {
        app.use("/deadline", async (context: Context) => {
          context.setTimeout(20);
          await never();
        });
        app.use("/none", async (context: Context) => {
          context.setTimeout(20);
          context.setTimeout(0);
          await sleep(60);
          await context.send("ok");
        });
      },
      async ({ port }) => {
        deepStrictEqual((await send(port, { path: "/deadline" })).status, 503);
        deepStrictEqual((await send(port, { path: "/none" })).body, "ok");
      },
    );
  });

  test("a deadline closes a reply that has not finished once the stack has completed", async () => {
    await withApp(
      { timeout: 40 },
      (app) => {
        app.use((context: Context) => {
          // Never ends
          new Readable({
            read(): void {
              // Nothing more
            },
          }).pipe(context.response);
          context.response.write("abc");
          context.done = true;
        });
      },
      async ({ port }) => {
        await rejects(send(port), { code: "ECONNRESET" });
      },
    );
  });

  test("an unexpected failure of the error handling closes the connection", async () => {
    await withApp(
      {},
      (app) => {
        app.use((context: Context) => {
          // The default reply then fails
          context.response.removeHeader = (): never => {
            throw new Error("Unexpected");
          };
          throw new BindenError(400);
        });
      },
      async ({ port }, captured) => {
        await rejects(send(port), { code: "ECONNRESET" });
        await captured.waitFor("The request has failed");
      },
    );
  });

  suite("`error_handler_timeout`", () => {
    test("an error handler that does not settle in time gets an opaque `500`", async () => {
      await withApp(
        {
          error_handler_timeout: 20,
          error_handler: async (context: Context): Promise<void> => {
            context.response.status(418).set({
              "Content-Type": "text/html",
              "Content-Length": 99,
              ETag: '"etag"',
              "X-Kept": "1",
            });
            await never();
          },
        },
        (app) => {
          app.use(() => {
            throw new BindenError(400);
          });
        },
        async ({ port }, captured) => {
          const response = await send(port);
          deepStrictEqual([response.status, response.body], [500, ""]);
          ok(!("content-type" in response.headers));
          ok(!("etag" in response.headers));
          deepStrictEqual(response.headers["content-length"], "0");
          deepStrictEqual(response.headers["x-kept"], "1");
          await captured.waitFor(
            "The provided `error_handler` has not settled in time",
          );
        },
      );
    });

    test("an error handler that fails gets an opaque `500`", async () => {
      const handlers: Partial<Record<string, () => Promise<void> | void>> = {
        "/throws": (): never => {
          throw new Error("A failing error handler");
        },
        "/rejects": async (): Promise<void> => {
          await sleep(10);
          throw new Error("A failing error handler");
        },
      };
      await withApp(
        {
          error_handler: async (context: Context): Promise<void> => {
            context.response.setHeader("Content-Type", "text/html");
            await handlers[context.url.pathname]?.();
          },
        },
        (app) => {
          app.use(() => {
            throw new BindenError(400);
          });
        },
        async ({ port }, captured) => {
          for (const path of Object.keys(handlers)) {
            const response = await send(port, { path });
            deepStrictEqual([response.status, response.body], [500, ""]);
            ok(!("content-type" in response.headers));
          }
          await captured.waitFor("The provided `error_handler` has failed");
        },
      );
    });

    test("an opaque `500` that cannot be sent is logged", async () => {
      await withApp(
        {
          error_handler: (context: Context): never => {
            context.request.destroy();
            throw new Error("A failing error handler");
          },
        },
        (app) => {
          app.use(() => {
            throw new BindenError(400);
          });
        },
        async ({ port }, captured) => {
          await rejects(send(port));
          await captured.waitFor("The error reply has not been sent");
        },
      );
    });

    test("a late failure of an error handler is logged, and its late reply ignored", async () => {
      await withApp(
        {
          error_handler_timeout: 20,
          error_handler: async (context: Context): Promise<void> => {
            await sleep(60);
            await context.send("late");
            throw new Error("late");
          },
        },
        (app) => {
          app.use(() => {
            throw new BindenError(400);
          });
        },
        async ({ port }, captured) => {
          const response = await send(port);
          deepStrictEqual([response.status, response.body], [500, ""]);
          await captured.waitFor("A late reply has been ignored");
          await captured.waitFor(
            "The provided `error_handler` has failed late",
          );
        },
      );
    });

    test("an error handler that does not settle in time once it has replied closes the connection", async () => {
      await withApp(
        {
          error_handler_timeout: 20,
          error_handler: async (context: Context): Promise<void> => {
            // Chunked: an ended reply would look complete
            context.response.writeHead(400);
            context.response.write("abc");
            await never();
          },
        },
        (app) => {
          app.use(() => {
            throw new BindenError(400);
          });
        },
        async ({ port }) => {
          await rejects(send(port), { code: "ECONNRESET" });
        },
      );
    });
  });
});

suite("Lifecycle (late sends of the response)", () => {
  const late: Partial<Record<string, (context: Context) => Promise<void>>> = {
    "/send": (context) => context.response.send("late"),
    "/json": (context) => context.response.json({ late: true }),
    "/text": (context) => context.response.text("late"),
    "/redirect": (context) => context.response.redirect("/elsewhere"),
    "/sendFile": (context) => context.response.sendFile(import.meta.filename),
    // It would send the headers
    "/flush": (context) => context.response.flush(),
  };

  test("a send of the response after the deadline does not replace the reply of the error handler", async () => {
    await withApp(
      {
        timeout: 20,
        error_handler: async (context: Context): Promise<void> => {
          // The late send comes first
          await sleep(80);
          await context.status(503).send("handler");
        },
      },
      (app) => {
        app.use(async (context: Context) => {
          await sleep(40);
          await late[context.url.pathname]?.(context);
        });
      },
      async ({ port }) => {
        for (const path of Object.keys(late)) {
          const response = await send(port, { path });
          deepStrictEqual(
            [response.status, response.body],
            [503, "handler"],
            path,
          );
          ok(!("location" in response.headers), path);
        }
      },
    );
  });
});
