import {
  Binden,
  BindenError,
  type Context,
  type IBindenOptions,
  Router,
  Stack,
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

const message = "The request has completed";

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

/** The access records written so far, without their duration and id */
function records(captured: ICaptured): Record<string, unknown>[] {
  return captured.records
    .filter(({ msg }) => msg === message)
    .map((record) => {
      const { duration_ms, trace_id, id, path } = record;
      ok(typeof duration_ms === "number" && duration_ms >= 0);
      ok(id === trace_id && typeof id === "string");
      const { level, method, route, status, body_bytes, aborted } = record;
      return {
        level,
        method,
        route,
        ...(typeof path === "undefined" ? {} : { path }),
        status,
        body_bytes,
        aborted,
      };
    });
}

/** Waits for the access records of `count` requests */
async function waitFor(captured: ICaptured, count: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (records(captured).length < count && Date.now() < deadline) {
    await sleep(5);
  }
}

suite("Access log", () => {
  test("`access_log` is validated", () => {
    const invalid: [unknown, string][] = [
      ["yes", "`access_log` is not a boolean or an object"],
      [null, "`access_log` is not a boolean or an object"],
      [{ level: "warn" }, "`access_log.level` is not `info` or `debug`"],
      [{ path: "full" }, "`access_log.path` is not `template` or `path`"],
    ];
    for (const [access_log, error] of invalid) {
      throws(
        () => new Binden({ access_log: access_log as boolean }),
        new TypeError(error),
      );
    }
  });

  test("is off by default", async () => {
    await withApp(
      {},
      (app) => {
        app.use((context: Context) => context.send("ok"));
      },
      async ({ port }, captured) => {
        await send(port);
        await sleep(20);
        deepStrictEqual(records(captured), []);
      },
    );
  });

  test("one record of every request, with its route", async () => {
    await withApp(
      { access_log: true },
      (app) => {
        const users = new Stack().route("/:id", (context: Context) =>
          context.send("user"),
        );
        app
          .route("/items/:id", (context: Context) => context.send("item"))
          .mount("/api/users", users)
          .use(
            "/static",
            new Router().get((context: Context) => context.send("s")),
          )
          .use(/^\/regexp$/u, (context: Context) => context.send("r"))
          .use("/raw", (context: Context) => {
            // Node.js does not send these bodies
            if (context.request.method === "GET") {
              context.response.statusCode = 204;
            }
            context.response.end("abc");
            context.done = true;
          });
      },
      async ({ port }, captured) => {
        for (const path of [
          "/items/1?secret=1",
          "/api/users/2",
          "/static",
          "/regexp",
          "/nothing",
        ]) {
          await send(port, { path });
        }
        await send(port, { path: "/static", method: "HEAD" });
        await send(port, { path: "/raw", method: "HEAD" });
        await send(port, { path: "/raw" });
        await waitFor(captured, 8);
        const base = { level: 30, method: "GET", aborted: false };
        deepStrictEqual(records(captured), [
          { ...base, route: "/items/:id", status: 200, body_bytes: 4 },
          { ...base, route: "/api/users/:id", status: 200, body_bytes: 4 },
          { ...base, route: "/static", status: 200, body_bytes: 1 },
          { ...base, route: "/^\\/regexp$/u", status: 200, body_bytes: 1 },
          { ...base, route: "<unmatched>", status: 404, body_bytes: 0 },
          // No body is sent
          {
            ...base,
            method: "HEAD",
            route: "/static",
            status: 200,
            body_bytes: 0,
          },
          {
            ...base,
            method: "HEAD",
            route: "/raw",
            status: 200,
            body_bytes: 0,
          },
          { ...base, route: "/raw", status: 204, body_bytes: 0 },
        ]);
        ok(!captured.output().includes("secret"));
      },
    );
  });

  test("the route of the layer that has started the reply", async () => {
    await withApp(
      { access_log: true },
      (app) => {
        const api = new Stack()
          // Runs, but does not reply
          .route("/users/:id", (context: Context) => {
            context.state.seen = true;
          })
          .route("/items/:id", () => {
            throw new BindenError(404);
          })
          .use((context: Context) => {
            if (context.url.pathname === "/api/fallback") {
              return context.send("api");
            }
            return context;
          })
          .route(
            "/guarded",
            new Router({ guarded: true }).get((context: Context) =>
              context.send("guarded"),
            ),
          );
        app
          // Runs for every request
          .use((context: Context) => {
            context.state.logged = true;
          })
          .mount("/api", api)
          .use("/root", (context: Context) => {
            // Started here, but not done: the next layers do not take it
            context.response.write("root");
          })
          .use((context: Context) => {
            if (context.url.pathname.startsWith("/api/users/")) {
              return context.status(404).send("fallback");
            } else if (context.url.pathname === "/root") {
              context.response.end();
              context.done = true;
            }
            return context;
          });
      },
      async ({ port }, captured) => {
        const paths = [
          "/api/users/1",
          "/api/items/1",
          "/api/fallback",
          "/root",
          "/nothing",
        ];
        for (const path of paths) {
          await send(port, { path });
        }
        await send(port, { path: "/api/guarded", method: "POST" });
        await waitFor(captured, 6);
        deepStrictEqual(
          records(captured).map(({ route, status }) => [route, status]),
          [
            // The fallback of the root, not the route that has run before
            ["*", 404],
            // The error of a route
            ["/api/items/:id", 404],
            // A `use()` without a path in a mount
            ["/api", 200],
            ["/root", 200],
            // The `404` and `405` of the framework
            ["<unmatched>", 404],
            ["<unmatched>", 405],
          ],
        );
      },
    );
  });

  test("the level, and the path of the request", async () => {
    await withApp(
      { access_log: { level: "debug", path: "path" } },
      (app) => {
        app.route("/users/:id", (context: Context) => context.send("ok"));
      },
      async ({ port }, captured) => {
        await send(port, { path: "/users/a%20b?token=secret" });
        // An absolute-form request-target, and `*`
        await send(port, {
          path: `http://user:secret@localhost:${port}/users/1?token=secret`,
        });
        await send(port, { path: "*", method: "OPTIONS" });
        await waitFor(captured, 3);
        const base = {
          level: 20,
          method: "GET",
          route: "/users/:id",
          status: 200,
          body_bytes: 2,
          aborted: false,
        };
        deepStrictEqual(records(captured), [
          { ...base, path: "/users/a%20b" },
          // 400 (the userinfo), and its path without the userinfo
          {
            ...base,
            route: "<unmatched>",
            path: "/users/1",
            status: 400,
            body_bytes: 0,
          },
          {
            ...base,
            method: "OPTIONS",
            route: "<unmatched>",
            path: "",
            status: 204,
            body_bytes: 0,
          },
        ]);
        ok(!captured.output().includes("secret"));
      },
    );
  });

  test("the bytes of a streamed body", async () => {
    await withApp(
      { access_log: true },
      (app) => {
        app.use((context: Context) =>
          context.send(Readable.from([Buffer.from("ab"), Buffer.from("cde")])),
        );
        app.use(() => {
          // Not reached
        });
      },
      async ({ port }, captured) => {
        deepStrictEqual((await send(port)).body, "abcde");
        await waitFor(captured, 1);
        deepStrictEqual(records(captured)[0]?.body_bytes, 5);
      },
    );
    await withApp(
      { access_log: true },
      (app) => {
        app.use((context: Context) => {
          context.response.write("é", "latin1");
          context.response.write("é");
          context.response.write(new Uint8Array(3));
          context.response.end(() => {
            // Ended
          });
          context.done = true;
        });
      },
      async ({ port }, captured) => {
        await send(port);
        await waitFor(captured, 1);
        deepStrictEqual(records(captured)[0]?.body_bytes, 6);
      },
    );
  });

  test("a request aborted before its headers has no status", async () => {
    const started = Promise.withResolvers<null>();
    await withApp(
      { access_log: true },
      (app) => {
        app.use(async () => {
          started.resolve(null);
          await never();
        });
      },
      async ({ port }, captured) => {
        const pending = rejects(send(port, { ms: 100 }));
        await started.promise;
        await pending;
        await waitFor(captured, 1);
        deepStrictEqual(records(captured), [
          {
            level: 30,
            method: "GET",
            route: "*",
            status: null,
            body_bytes: 0,
            aborted: true,
          },
        ]);
      },
    );
  });

  test("a request that has passed its deadline", async () => {
    await withApp(
      { access_log: true, timeout: 20 },
      (app) => {
        app.use(async () => {
          await never();
        });
      },
      async ({ port }, captured) => {
        deepStrictEqual((await send(port)).status, 503);
        await waitFor(captured, 1);
        deepStrictEqual(records(captured), [
          {
            level: 30,
            method: "GET",
            route: "*",
            status: 503,
            body_bytes: 0,
            aborted: true,
          },
        ]);
      },
    );
  });
});
