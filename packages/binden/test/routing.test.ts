import {
  Binden,
  BindenError,
  Context,
  type IBindenOptions,
  Middleware,
  Router,
  Stack,
} from "../index.js";
import { type IApp, type IListening, listen, send } from "./helpers.js";
import { compile, matchPrefix, matchRoute } from "../src/route.js";
import { deepStrictEqual, ok, throws } from "node:assert/strict";
import { suite, test } from "node:test";
import { layersOf } from "../src/stack.js";

/** Runs `fn` with a listening application */
async function withApp(
  app: IApp,
  fn: (listening: IListening) => Promise<void>,
): Promise<void> {
  const listening = await listen(app);
  try {
    await fn(listening);
  } finally {
    await listening.close();
  }
}

/** Replies with the parameters and the mount path of the request */
function echo(name = "echo") {
  return (context: Context): Promise<void> =>
    context.json({
      name,
      params: context.params,
      mount_path: context.mount_path,
    });
}

/** The status and the JSON (or text) body of a request */
async function get(
  port: number,
  path: string,
  method = "GET",
): Promise<[number, unknown]> {
  const { status, body, headers } = await send(port, { path, method });
  const json = headers["content-type"] === "application/json";
  return [status, json ? (JSON.parse(body) as unknown) : body];
}

class Noop extends Middleware {
  // eslint-disable-next-line class-methods-use-this -- a middleware that does nothing
  public run(): void {
    // Nothing
  }
}

suite("Routing", () => {
  suite("patterns", () => {
    test("`route()` refuses an invalid pattern", () => {
      const stack = new Stack();
      const invalid: [unknown, string][] = [
        ["users", "The route pattern does not start with `/`"],
        [1, "The route pattern does not start with `/`"],
        ["/:", "Invalid parameter name in /:"],
        ["/*", "Invalid parameter name in /*"],
        ["/:1a", "Invalid parameter name in /:1a"],
        ["/:a-b", "Invalid parameter name in /:a-b"],
        ["/:id/:id", "Duplicate parameter name in /:id/:id"],
        ["/:id/*id", "Duplicate parameter name in /:id/*id"],
        ["/*rest/x", "`*rest` is not the last segment"],
        ["/a:b", "An unescaped `:` in /a:b"],
        ["/file.*", "An unescaped `*` in /file.*"],
        ["/a\\b", "Invalid escape in /a\\b"],
        ["/a\\", "Invalid escape in /a\\"],
      ];
      for (const [pattern, message] of invalid) {
        throws(
          () => stack.route(pattern as string, new Noop()),
          new TypeError(message),
        );
        // Even without items
        throws(() => stack.route(pattern as string), new TypeError(message));
      }
      throws(
        () => stack.mount("/api/*rest", new Noop()),
        new TypeError("A mount prefix has no `*` (/api/*rest)"),
      );
      throws(
        () => stack.mount("api"),
        new TypeError("The mount pattern does not start with `/`"),
      );
      throws(
        () => stack.route("/", {} as Middleware),
        new TypeError("Unsupported Middleware/Router"),
      );
      throws(
        () => stack.use("/", new Stack() as unknown as Middleware),
        new TypeError("Unsupported Middleware/Router"),
      );
      throws(
        () => stack.mount("/", {} as Middleware),
        new TypeError("Unsupported Middleware/Router/Stack"),
      );
      deepStrictEqual(stack.stack, []);
    });

    test("`stack` lists the patterns of `route()` and `mount()`", () => {
      const a = new Noop();
      const b = new Noop();
      const nested = new Stack();
      const stack = new Stack()
        .route("/users/:id", a)
        .route("/users/:id", b)
        .mount("/api/", nested)
        .mount("/api", a)
        .mount("/", b)
        .use(a)
        // Nothing to add
        .route("/x")
        .mount("/x");
      deepStrictEqual(stack.stack, [
        [[a, b], { route: "/users/:id" }],
        [[nested, a], { mount: "/api" }],
        [[b], { mount: "" }],
        [[a], null],
      ]);
    });
  });

  suite("`route()`", () => {
    test("matches a pattern, with its parameters", async () => {
      const app = new Binden()
        .route("/users/:id", echo("user"))
        .route("/users/:id/posts/:post", echo("post"))
        .route("/files/*path", echo("file"))
        .route("/a\\:b/\\*", echo("escaped"))
        .route("/", echo("root"));
      await withApp(app, async ({ port }) => {
        deepStrictEqual(await get(port, "/users/7"), [
          200,
          { name: "user", params: { id: "7" }, mount_path: "" },
        ]);
        deepStrictEqual(await get(port, "/users/7/posts/x"), [
          200,
          { name: "post", params: { id: "7", post: "x" }, mount_path: "" },
        ]);
        deepStrictEqual(await get(port, "/files"), [
          200,
          { name: "file", params: { path: "" }, mount_path: "" },
        ]);
        deepStrictEqual(await get(port, "/files/a/b%20c/"), [
          200,
          { name: "file", params: { path: "a/b c/" }, mount_path: "" },
        ]);
        deepStrictEqual((await get(port, "/a:b/*"))[1], {
          name: "escaped",
          params: {},
          mount_path: "",
        });
        deepStrictEqual((await get(port, "/"))[1], {
          name: "root",
          params: {},
          mount_path: "",
        });
        // A parameter is one non-empty segment
        deepStrictEqual((await get(port, "/users"))[0], 404);
        deepStrictEqual((await get(port, "/users/"))[0], 404);
        deepStrictEqual((await get(port, "/users/7/x"))[0], 404);
        deepStrictEqual((await get(port, "/users//posts/x"))[0], 404);
        // The case of the literals (`case_sensitive`), and a trailing `/` (`strict`)
        deepStrictEqual((await get(port, "/Users/7"))[0], 404);
        deepStrictEqual((await get(port, "/users/7/"))[0], 404);
      });
    });

    test("decodes every parameter once", async () => {
      const app = new Binden()
        .route("/users/:id", echo())
        .route("/files/*path", echo())
        .route("/café/:x", echo());
      await withApp(app, async ({ port }) => {
        const params = async (path: string): Promise<unknown> =>
          ((await get(port, path))[1] as { params: unknown }).params;
        deepStrictEqual(await params("/users/%41%20b"), { id: "A b" });
        deepStrictEqual(await params("/users/%2541"), { id: "%41" });
        deepStrictEqual(await params("/users/caf%C3%A9"), { id: "café" });
        deepStrictEqual(await params("/files/%2541/%41"), { path: "%41/A" });
        // A literal is compared once decoded
        deepStrictEqual(await params("/caf%C3%A9/1"), { x: "1" });
        // A parameter named `__proto__` is a parameter
        const proto = new Binden().route("/:__proto__", (context: Context) =>
          context.json({ own: Object.hasOwn(context.params, "__proto__") }),
        );
        await withApp(proto, async (listening) => {
          deepStrictEqual(await get(listening.port, "/x"), [
            200,
            { own: true },
          ]);
        });
      });
    });

    test("a parameter that cannot be decoded is `400 Bad Request`", async () => {
      const app = new Binden()
        .route("/users/:id/x", echo())
        .route("/files/*path", echo());
      await withApp(app, async ({ port }) => {
        for (const path of [
          // Not UTF-8
          "/users/%FF/x",
          // An encoded `/` or `\` would change the segments
          "/users/a%2Fb/x",
          "/users/a%2fb/x",
          "/users/a%5Cb/x",
          "/files/a/%2F",
          "/files/%C3",
        ]) {
          deepStrictEqual((await get(port, path))[0], 400, path);
        }
        // Not when the other segments do not match
        deepStrictEqual((await get(port, "/users/%FF/y"))[0], 404);
        // A literal that cannot be decoded does not match
        deepStrictEqual((await get(port, "/%FF/a"))[0], 404);
      });
    });

    test("an encoded slash in a parameter with `encoded_slashes`", async () => {
      const app = new Binden({ encoded_slashes: true })
        .route("/files/:name", echo("file"))
        .route("/raw/*rest", echo("raw"))
        .mount("/users/:id", echo("user"));
      await withApp(app, async ({ port }) => {
        const params = async (path: string): Promise<unknown> =>
          ((await get(port, path))[1] as { params: unknown }).params;
        deepStrictEqual(await params("/files/a%2Fb"), { name: "a/b" });
        deepStrictEqual(await params("/files/a%5cb"), { name: "a\\b" });
        deepStrictEqual(await params("/raw/x/a%2Fb"), { rest: "x/a/b" });
        deepStrictEqual(await params("/users/a%2Fb/x"), { id: "a/b" });
      });
      // Without it: the whole path is refused
      const strict = new Binden().route("/files/:name", echo("file"));
      await withApp(strict, async ({ port }) => {
        deepStrictEqual((await get(port, "/files/a%2Fb"))[0], 400);
      });
    });

    test("matchRoute() and matchPrefix() refuse an encoded slash without `encoded_slashes`", () => {
      const route = compile("/:name/*rest", "route");
      const prefix = compile("/:name", "mount");
      for (const path of ["/a%2Fb/c", "/a/b%5Cc"]) {
        throws(
          () => matchRoute(route, path, {}),
          (error: unknown) =>
            error instanceof BindenError && error.status === 400,
        );
      }
      throws(
        () => matchPrefix(prefix, "/a%2Fb/c", {}),
        (error: unknown) =>
          error instanceof BindenError && error.status === 400,
      );
      deepStrictEqual(
        matchRoute(route, "/a%2Fb/c%5Cd", { encoded_slashes: true }),
        { name: "a/b", rest: "c\\d" },
      );
      deepStrictEqual(
        matchPrefix(prefix, "/a%2Fb/c", { encoded_slashes: true }),
        {
          params: { name: "a/b" },
          prefix: "/a%2Fb",
          rest: "/c",
        },
      );
    });

    test("`routing.case_sensitive: false` and `routing.strict: false`", async () => {
      const app = new Binden({
        routing: { case_sensitive: false, strict: false },
      })
        .route("/users/:id", echo("user"))
        .route("/items/", echo("items"))
        .route("/files/*path", echo("file"))
        .route("/", echo("root"))
        .mount("/API", new Stack().route("/x", echo("api")));
      await withApp(app, async ({ port }) => {
        const name = async (path: string): Promise<unknown> =>
          ((await get(port, path))[1] as { name: string }).name;
        deepStrictEqual(await name("/USERS/7"), "user");
        deepStrictEqual(await name("/users/7/"), "user");
        deepStrictEqual(await name("/items"), "items");
        deepStrictEqual(await name("/items/"), "items");
        deepStrictEqual(await name("/"), "root");
        deepStrictEqual(await name("/api/X"), "api");
        deepStrictEqual(
          ((await get(port, "/files/a/")) as [number, { params: unknown }])[1]
            .params,
          { path: "a" },
        );
        // A parameter keeps its case, and only one trailing `/` is ignored
        deepStrictEqual(
          ((await get(port, "/Users/AbC")) as [number, { params: unknown }])[1]
            .params,
          { id: "AbC" },
        );
        deepStrictEqual((await get(port, "/users/7//"))[0], 404);
      });
    });

    test("`use()` keeps an exact path", async () => {
      const app = new Binden({
        routing: { case_sensitive: false, strict: false },
      }).use("/users", echo("users"));
      await withApp(app, async ({ port }) => {
        deepStrictEqual((await get(port, "/users"))[0], 200);
        deepStrictEqual((await get(port, "/users/"))[0], 404);
        deepStrictEqual((await get(port, "/USERS"))[0], 404);
      });
    });
  });

  suite("`mount()`", () => {
    test("the mounted items see the rest of the path", async () => {
      const users = new Stack()
        .use("/", echo("list"))
        .route("/posts/:post", echo("post"))
        .use(echo("rest"));
      const app = new Binden()
        .mount("/users/:id", users)
        .mount("/static", echo("static"))
        .use(echo("root"));
      await withApp(app, async ({ port }) => {
        deepStrictEqual(await get(port, "/users/7"), [
          200,
          { name: "list", params: { id: "7" }, mount_path: "/users/7" },
        ]);
        deepStrictEqual((await get(port, "/users/7/"))[1], {
          name: "list",
          params: { id: "7" },
          mount_path: "/users/7",
        });
        deepStrictEqual((await get(port, "/users/a%20b/posts/9"))[1], {
          name: "post",
          params: { id: "a b", post: "9" },
          mount_path: "/users/a%20b",
        });
        deepStrictEqual((await get(port, "/users/7/x"))[1], {
          name: "rest",
          params: { id: "7" },
          mount_path: "/users/7",
        });
        deepStrictEqual((await get(port, "/static/a/b"))[1], {
          name: "static",
          params: {},
          mount_path: "/static",
        });
        // On a segment boundary only
        deepStrictEqual((await get(port, "/staticx"))[1], {
          name: "root",
          params: {},
          mount_path: "",
        });
        deepStrictEqual((await get(port, "/users"))[1], {
          name: "root",
          params: {},
          mount_path: "",
        });
      });
    });

    test("the level of a mount is left once its items are done", async () => {
      const levels: unknown[] = [];
      const record = (context: Context): void => {
        levels.push([context.params, context.mount_path]);
      };
      const shared = new Stack().route("/:x", record);
      const app = new Binden()
        .mount("/a/:id", shared)
        .mount("/b", shared, new Stack().mount("/c", record))
        .use(record, (context: Context) => context.send());
      await withApp(app, async ({ port }) => {
        deepStrictEqual((await get(port, "/a/1/2"))[0], 200);
        deepStrictEqual((await get(port, "/b/3"))[0], 200);
        deepStrictEqual((await get(port, "/b/c/d"))[0], 200);
      });
      deepStrictEqual(levels, [
        [{ id: "1", x: "2" }, "/a/1"],
        [{}, ""],
        [{ x: "3" }, "/b"],
        [{}, ""],
        // `/c/d` is not one segment
        [{}, "/b/c"],
        [{}, ""],
      ]);
    });

    test("a middleware of a mounted stack may replace the context", async () => {
      let replaced: Context | null = null;
      const nested = new Stack().use((context: Context) => {
        replaced = new Context({
          request: context.request,
          response: context.response,
        });
        return replaced;
      });
      const app = new Binden().mount(
        "/",
        nested,
        // In the same layer as the mounted stack
        (context: Context) => context.json({ same: context === replaced }),
      );
      await withApp(app, async ({ port }) => {
        deepStrictEqual(await get(port, "/"), [200, { same: true }]);
      });
    });

    test("a mounted stack ends the request once it is done", async () => {
      let reached = false;
      const app = new Binden()
        .mount("/", new Stack().mount("/", echo("nested")))
        .use(() => {
          reached = true;
        });
      await withApp(app, async ({ port }) => {
        deepStrictEqual(
          ((await get(port, "/x")) as [number, { name: string }])[1].name,
          "nested",
        );
      });
      deepStrictEqual(reached, false);
    });

    test("an application, a stack in itself and other values cannot be mounted", () => {
      const a = new Stack();
      const b = new Stack().mount("/a", a);
      const c = new Stack().mount("/b", b);
      const app = new Binden();
      throws(
        () => a.mount("/x", app),
        new TypeError("An application (`Binden`) cannot be mounted"),
      );
      throws(
        () => app.mount("/x", app),
        new TypeError("An application (`Binden`) cannot be mounted"),
      );
      throws(
        () => a.mount("/x", a),
        new TypeError("A stack cannot be mounted in itself"),
      );
      // Through other stacks
      throws(
        () => a.mount("/x", c),
        new TypeError("A stack cannot be mounted in itself"),
      );
      throws(
        () => a.mount("/x", b),
        new TypeError("A stack cannot be mounted in itself"),
      );
      // The same stack in several places is not a cycle
      const shared = new Stack();
      const both = new Stack().mount("/1", shared).mount("/2", shared);
      ok(new Stack().mount("/x", both, shared) instanceof Stack);
    });

    test("a stack mounted in itself fails the request", async () => {
      const a = new Stack();
      const app = new Binden().mount("/a", a);
      // A cycle that `mount()` would refuse
      layersOf(a).push({
        kind: "mount",
        pattern: compile("/a", "mount"),
        items: [a],
      });
      await withApp(app, async ({ port }) => {
        deepStrictEqual((await get(port, "/a/a/a"))[0], 500);
      });
    });
  });

  suite("routers", () => {
    test("a router handles a method in any case", async () => {
      const app = new Binden().use(
        new Router({ guarded: true }).on("propfind", (context: Context) =>
          context.status(207).send(),
        ),
      );
      await withApp(app, async ({ port }) => {
        deepStrictEqual((await get(port, "/", "PROPFIND"))[0], 207);
      });
    });

    test("`OPTIONS` gets `204` with the methods of the guarded routers, unless one handles it", async () => {
      const options = new Router({ guarded: true })
        .get(echo())
        .options((context: Context) =>
          context.setHeader("Allow", "GET, OPTIONS").status(200).send("own"),
        );
      const app = new Binden()
        .use(
          "/auto",
          new Router({ guarded: true }).get(echo()),
          new Router({ guarded: true }).post(echo()),
        )
        .use("/own", options)
        .use("/open", new Router().get(echo()));
      const noHead = new Binden({ auto_head: false }).use(
        new Router({ guarded: true }).get(echo()),
      );
      await withApp(app, async ({ port }) => {
        const auto = await send(port, { path: "/auto", method: "OPTIONS" });
        deepStrictEqual(
          [auto.status, auto.headers.allow, auto.body],
          [204, "GET, HEAD, POST, OPTIONS", ""],
        );
        const own = await send(port, { path: "/own", method: "OPTIONS" });
        deepStrictEqual([own.status, own.body], [200, "own"]);
        // 405 with the same methods
        const refused = await send(port, { path: "/auto", method: "DELETE" });
        deepStrictEqual(
          [refused.status, refused.headers.allow],
          [405, "GET, HEAD, POST, OPTIONS"],
        );
        const ownRefused = await send(port, { path: "/own", method: "PUT" });
        deepStrictEqual(
          [ownRefused.status, ownRefused.headers.allow],
          [405, "GET, OPTIONS, HEAD"],
        );
        // Without a guarded router
        deepStrictEqual(
          (await send(port, { path: "/open", method: "OPTIONS" })).status,
          404,
        );
      });
      await withApp(noHead, async ({ port }) => {
        const auto = await send(port, { method: "OPTIONS" });
        deepStrictEqual(
          [auto.status, auto.headers.allow],
          [204, "GET, OPTIONS"],
        );
      });
    });
  });

  suite("options", () => {
    test("invalid options are refused", () => {
      const invalid: [IBindenOptions, string][] = [
        [
          { auto_head: 1 as unknown as boolean },
          "`auto_head` is not a boolean",
        ],
        [
          { error_handler: "no" as unknown as () => void },
          "`error_handler` is not a function",
        ],
        [
          { state: {} as unknown as () => Record<string, unknown> },
          "`state` is not a function",
        ],
        [{ routing: null as unknown as object }, "`routing` is not an object"],
        [{ routing: "yes" as unknown as object }, "`routing` is not an object"],
        [
          { routing: { case_sensitive: 0 as unknown as boolean } },
          "`routing.case_sensitive` is not a boolean",
        ],
        [
          { routing: { strict: "no" as unknown as boolean } },
          "`routing.strict` is not a boolean",
        ],
      ];
      for (const [options, message] of invalid) {
        throws(() => new Binden(options), new TypeError(message));
      }
    });

    test("`state` creates the state of every request", async () => {
      let count = 0;
      const app = new Binden<{ count: number; seen: boolean }>({
        state: (): { count: number; seen: boolean } => {
          count += 1;
          return { count, seen: false };
        },
      }).use((context): Promise<void> => {
        const { state } = context;
        const { seen } = state;
        state.seen = true;
        return context.json({ count: state.count, seen });
      });
      await withApp(app, async ({ port }) => {
        deepStrictEqual(await get(port, "/"), [200, { count: 1, seen: false }]);
        deepStrictEqual(await get(port, "/"), [200, { count: 2, seen: false }]);
      });
    });

    test("a `state` that fails, or that is not an object, fails the request", async () => {
      const failing = new Binden({
        state: (): never => {
          throw new Error("A failing state");
        },
      }).use(echo());
      const invalid = new Binden({
        state: (): Record<string, unknown> =>
          null as unknown as Record<string, unknown>,
      }).use(echo());
      for (const app of [failing, invalid]) {
        await withApp(app, async ({ port }) => {
          deepStrictEqual((await get(port, "/"))[0], 500);
        });
      }
    });
  });
});
