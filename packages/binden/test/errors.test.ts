import {
  Binden,
  BindenError,
  type Context,
  type IBindenOptions,
  Middleware,
} from "../index.js";
import {
  type ICaptured,
  type IListening,
  capture,
  listen,
  send,
} from "./helpers.js";
import { deepStrictEqual, ok, throws } from "node:assert/strict";
import { suite, test } from "node:test";

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

suite("Errors and logging", () => {
  test("`logger` and `log_error_details` are validated", () => {
    throws(
      () => new Binden({ logger: {} as IBindenOptions["logger"] }),
      new TypeError("`logger` is not a logger"),
    );
    throws(
      () => new Binden({ log_error_details: 1 as unknown as boolean }),
      new TypeError("`log_error_details` is not a boolean"),
    );
  });

  test("the default handler sends the headers of a `BindenError`", async () => {
    await withApp(
      {},
      (app) => {
        app.use(() => {
          throw new BindenError(401, {
            headers: { "WWW-Authenticate": ["Basic", 'Bearer realm="api"'] },
          });
        });
      },
      async ({ port }) => {
        const response = await send(port);
        deepStrictEqual(response.status, 401);
        deepStrictEqual(
          response.headers["www-authenticate"],
          'Basic, Bearer realm="api"',
        );
      },
    );
  });

  test("the default handler removes the headers of the body that it replaces", async () => {
    // Its framing, representation and validators: e.g. a `Trailer` that
    // Node.js refuses with a `Content-Length`, or a stale length
    const headers = {
      "Content-Digest": "sha-256=:AAAA:",
      "Content-Disposition": "attachment",
      "Content-Encoding": "gzip",
      "Content-Language": "en",
      "Content-Length": 999,
      "Content-Location": "/page.html",
      "Content-Range": "bytes 0-1/2",
      "Content-Type": "text/html",
      Digest: "SHA-256=AAAA",
      ETag: `"x"`,
      "Last-Modified": "Wed, 01 Jan 2020 00:00:00 GMT",
      "Repr-Digest": "sha-256=:AAAA:",
      Trailer: "X-T",
      "Transfer-Encoding": "chunked",
    };
    for (const expose of [false, true]) {
      await withApp(
        {},
        (app) => {
          app.use(({ response }: Context) => {
            response.set(headers);
            throw new BindenError(409, { message: "conflict", expose });
          });
        },
        async ({ port }) => {
          const response = await send(port);
          deepStrictEqual(response.status, 409);
          deepStrictEqual(response.body, expose ? "conflict" : "");
          const own: Partial<Record<string, string>> = {
            "Content-Length": `${response.body.length}`,
            ...(expose ? { "Content-Type": "text/plain; charset=utf-8" } : {}),
          };
          for (const name of Object.keys(headers)) {
            deepStrictEqual(
              response.headers[name.toLowerCase()],
              own[name],
              `${name} (expose: ${expose})`,
            );
          }
        },
      );
    }
  });

  test("the default handler replies `500` to a status that is not of an error", async () => {
    const thrown: Partial<Record<string, unknown>> = {
      "/ok": { status: 200 },
      "/redirect": { status: 302, headers: { Location: "/x" } },
      "/string": { status: "400" },
      "/large": { status: 600 },
      "/float": { status: 404.5 },
      "/teapot": { status: 418, headers: { "X-Duck": "1" } },
    };
    await withApp(
      {},
      (app) => {
        app.use((context: Context) => {
          throw thrown[context.url.pathname];
        });
      },
      async ({ port }) => {
        const statuses: unknown[] = [];
        for (const path of Object.keys(thrown)) {
          const response = await send(port, { path });
          statuses.push([
            path,
            response.status,
            response.headers["x-duck"] ?? null,
          ]);
        }
        // The headers of a value that is not a `BindenError` are not sent
        deepStrictEqual(statuses, [
          ["/ok", 500, null],
          ["/redirect", 500, null],
          ["/string", 500, null],
          ["/large", 500, null],
          ["/float", 500, null],
          ["/teapot", 418, null],
        ]);
      },
    );
  });

  test("a server error is logged at `error`, a client error at `debug`", async () => {
    await withApp(
      {},
      (app) => {
        app.use("/server", () => {
          throw new Error("secret-message");
        });
        app.use("/client", () => {
          throw new BindenError(404, { message: "secret-message" });
        });
      },
      async ({ port }, captured) => {
        await send(port, { path: "/server" });
        await send(port, { path: "/client" });
        const failed = captured.records.filter(
          ({ msg }) => msg === "The request has failed",
        );
        deepStrictEqual(
          failed.map(({ level, failure }) => [level, failure]),
          [
            [
              50,
              {
                type: "Error",
                status: 500,
                location: "middleware",
                request_id: failed[0]?.trace_id,
              },
            ],
            [
              20,
              {
                type: "BindenError",
                status: 404,
                location: "middleware",
                request_id: failed[1]?.trace_id,
              },
            ],
          ],
        );
        ok(!captured.output().includes("secret"), captured.output());
      },
    );
  });

  test("`log_error_details` logs the message, the stack, the cause and any code", async () => {
    await withApp(
      { log_error_details: true },
      (app) => {
        app.use(() => {
          throw Object.assign(
            new Error("the message", { cause: new Error("the cause") }),
            { code: "E_CUSTOM" },
          );
        });
      },
      async ({ port }, captured) => {
        await send(port);
        const { failure } = await captured.waitFor("The request has failed");
        const { message, code, stack, cause } = failure as Record<
          string,
          unknown
        >;
        deepStrictEqual([message, code], ["the message", "E_CUSTOM"]);
        ok(typeof stack === "string");
        deepStrictEqual(
          (cause as Record<string, unknown>).message,
          "the cause",
        );
      },
    );
  });

  test("a failing cleanup is logged with its location and request id", async () => {
    await withApp(
      {},
      (app) => {
        app.use((context: Context) => {
          context.onCleanup(() => {
            throw new Error("secret-message");
          });
          return context.send("ok");
        });
      },
      async ({ port }, captured) => {
        await send(port);
        const record = await captured.waitFor(
          "A cleanup of the request has failed",
        );
        deepStrictEqual(record.failure, {
          type: "Error",
          location: "cleanup",
          request_id: record.trace_id,
        });
      },
    );
  });

  test("a second reply is logged (`warn`) and not sent", async () => {
    await withApp(
      {},
      (app) => {
        app.use(async (context: Context) => {
          await context.send("first");
          await context.send("second");
        });
      },
      async ({ port }, captured) => {
        deepStrictEqual((await send(port)).body, "first");
        const record = await captured.waitFor(
          "The response has already been started",
        );
        deepStrictEqual(record.level, 40);
      },
    );
  });

  test("a middleware that ignores errors logs them", async () => {
    class Ignoring extends Middleware {
      // eslint-disable-next-line class-methods-use-this -- a failing middleware
      public run(): never {
        throw new Error("secret-message");
      }
    }
    await withApp(
      {},
      (app) => {
        app.use(new Ignoring({ ignore_errors: true }), (context: Context) =>
          context.send("ok"),
        );
      },
      async ({ port }, captured) => {
        deepStrictEqual((await send(port)).body, "ok");
        const record = await captured.waitFor("Middleware ignores errors");
        deepStrictEqual(record.middleware, "Ignoring");
        deepStrictEqual(record.failure, {
          type: "Error",
          location: "middleware",
          request_id: record.trace_id,
        });
      },
    );
  });
});
