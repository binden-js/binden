import {
  Binden,
  BindenAbortError,
  BindenError,
  BindenRequest,
  Context,
  type IBindenOptions,
  type IServer,
  Middleware,
  Router,
  createSerializers,
  described,
  formatting,
  framingLength,
  isClosing,
  serializers,
  shutdown,
  validateRequestOptions,
} from "../index.js";
import { deepStrictEqual, ok } from "node:assert/strict";
import { suite, test } from "node:test";
import { EventEmitter } from "node:events";
import { Socket } from "node:net";
import { createServer } from "node:http";
import { within } from "./helpers.js";

/** `undefined`, which the linter does not let the tests write */
const none = ({} as { value?: undefined }).value;

/** A value of any type, given in place of the one that a method declares */
function given<T>(value: unknown): T {
  return value as T;
}

/** A proxy that has been revoked: any operation on it throws */
function revoked(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

/** The error of the test, which a trap of a proxy throws (see `throwing()`) */
let own = new RangeError("A trap of the test");

/**
 * A proxy whose every trap throws the error of the test, a new one (whose
 * stack is not formatted yet)
 */
function throwing(): object {
  const error = new RangeError("A trap of the test");
  own = error;
  const trap = (): never => {
    throw error;
  };
  return new Proxy(
    {},
    { get: trap, getPrototypeOf: trap, ownKeys: trap, has: trap },
  );
}

/** The conversions of the values of `counting()` */
let conversions = 0;

/**
 * An object that counts its conversions (`toString()`, `valueOf()` and
 * `Symbol.toPrimitive`): a refusal must not convert it
 */
function counting(text = "a"): object {
  const convert = (): string => {
    conversions += 1;
    return text;
  };
  return { toString: convert, valueOf: convert, [Symbol.toPrimitive]: convert };
}

/** Records the errors whose stacks V8 formats while `run` runs */
function recorded<T>(run: (formatted: WeakSet<object>) => T): T {
  const previous: unknown = Reflect.get(Error, "prepareStackTrace");
  const formatted = new WeakSet<object>();
  Reflect.set(Error, "prepareStackTrace", (error: Error): string => {
    formatted.add(error);
    return `${error.name}: ${error.message}`;
  });
  try {
    return run(formatted);
  } finally {
    Reflect.set(Error, "prepareStackTrace", previous);
  }
}

/** What a thrown value tells: its class, its message, whether its stack was formatted and whether it is the error of the test */
function told(error: unknown, formatted: WeakSet<object>): unknown {
  const { constructor, message } = error as Error;
  return [
    constructor.name,
    message,
    formatted.has(error as Error),
    error === own,
  ];
}

/**
 * What a call has done: `returned`, or what its error tells (see `told()`)
 * once the caller gets it
 */
function outcome(run: () => unknown): unknown {
  return recorded((formatted) => {
    try {
      run();
      return "returned";
    } catch (error: unknown) {
      return told(error, formatted);
    }
  });
}

/** What a call that returns a promise has rejected with (see `outcome()`) */
async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  const formatted = new WeakSet<object>();
  const previous: unknown = Reflect.get(Error, "prepareStackTrace");
  Reflect.set(Error, "prepareStackTrace", (error: Error): string => {
    formatted.add(error);
    return `${error.name}: ${error.message}`;
  });
  try {
    await within(run());
    return "resolved";
  } catch (error: unknown) {
    return told(error, formatted);
  } finally {
    Reflect.set(Error, "prepareStackTrace", previous);
  }
}

/** A refusal of binden: a formatted `TypeError` of the message */
function refused(message: string): unknown {
  return ["TypeError", message, true, false];
}

/** The formatted error of V8 for a revoked proxy, of an operation */
function revokedError(operation: string): unknown {
  return [
    "TypeError",
    `Cannot perform '${operation}' on a proxy that has been revoked`,
    true,
    false,
  ];
}

/** The error of the test, formatted */
const ownError = ["RangeError", "A trap of the test", true, true];

/** A middleware class of the test */
class Noop extends Middleware {
  // eslint-disable-next-line class-methods-use-this -- nothing to do
  public run(): void {
    // Nothing
  }
}

/**
 * The constructors and functions whose options (an object) are optional, and
 * how V8 refuses to read a revoked proxy of them (a destructuring gets its
 * properties, a spread its keys)
 */
const optional: readonly (readonly [
  string,
  (options: unknown) => unknown,
  string,
])[] = [
  [
    "new BindenError()",
    (options): unknown => new BindenError(404, given(options)),
    "get",
  ],
  ["new Middleware()", (options): unknown => new Noop(given(options)), "get"],
  ["new Router()", (options): unknown => new Router(given(options)), "get"],
  [
    "new Binden()",
    (options): unknown => new Binden(given<IBindenOptions>(options)),
    "get",
  ],
  [
    "createServer()",
    (options): unknown => new Binden().createServer(given(options)),
    "ownKeys",
  ],
  [
    "createSecureServer()",
    (options): unknown => new Binden().createSecureServer(given(options)),
    "ownKeys",
  ],
  [
    "createSerializers()",
    (options): unknown => createSerializers(given(options)),
    "get",
  ],
  [
    "validateRequestOptions()",
    (options): unknown => validateRequestOptions(given(options)),
    "get",
  ],
  [
    "shutdown()",
    (options): unknown => shutdown(createServer(), given(options)),
    "get",
  ],
];

suite(
  "The options of a constructor or a function of binden are an object, read inside the boundary that formats what they throw (R27-1)",
  () => {
    test("anything but an object (or undefined) is refused, described (a string was read as an object without the options)", () => {
      for (const [name, create] of optional) {
        const options =
          name === "validateRequestOptions()"
            ? "`options` is not an object"
            : null;
        deepStrictEqual(
          [
            outcome((): unknown => create("Not found")),
            outcome((): unknown => create(5)),
            outcome((): unknown => create(null)),
          ],
          options === null
            ? [
                refused("`options` is not an object: Not found"),
                refused("`options` is not an object: 5"),
                refused("`options` is not an object: null"),
              ]
            : [refused(options), refused(options), refused(options)],
          name,
        );
        deepStrictEqual(
          outcome((): unknown => create(none)),
          "returned",
          name,
        );
      }
    });

    test("a revoked proxy, or one whose traps throw, throws the error of V8 (or of the trap itself), formatted", () => {
      for (const [name, create, operation] of [
        ...optional,
        [
          "new Context()",
          (options: unknown): unknown => new Context(given(options)),
          "get",
        ],
      ] as const) {
        deepStrictEqual(
          [
            outcome((): unknown => create(revoked())),
            outcome((): unknown => create(throwing())),
          ],
          [revokedError(operation), ownError],
          name,
        );
      }
    });

    test("new Context() and shutdown() refuse options that are not an object", async () => {
      deepStrictEqual(
        [
          outcome((): unknown => new Context(given(null))),
          outcome((): unknown => new Context(given("x"))),
          outcome((): unknown => shutdown(createServer(), given("x"))),
          outcome(
            (): unknown =>
              new Context({
                request: given(revoked()),
                response: given(revoked()),
              }),
          ),
        ],
        [
          refused("`options` is not an object: null"),
          refused("`options` is not an object: x"),
          refused("`options` is not an object: x"),
          revokedError("get"),
        ],
      );
      // Its own options are optional
      const server = createServer();
      await within(shutdown(server, none));
      ok(isClosing(server));
    });

    test("a nested option that a revoked proxy is, or whose traps throw, throws the error of V8 (or of the trap itself), formatted", () => {
      for (const row of [
        [
          "Binden routing",
          (value: unknown): unknown => new Binden({ routing: given(value) }),
          "get",
        ],
        [
          "Binden access_log",
          (value: unknown): unknown => new Binden({ access_log: given(value) }),
          "get",
        ],
        [
          "Binden logger",
          (value: unknown): unknown => new Binden({ logger: given(value) }),
          "get",
        ],
        [
          "Binden allowed_hosts",
          (value: unknown): unknown =>
            new Binden({ allowed_hosts: given(value) }),
          "IsArray",
          refused("`allowed_hosts` is not an array or a function"),
        ],
        [
          "BindenError headers",
          (value: unknown): unknown =>
            new BindenError(400, { headers: { "X-A": given(value) } }),
          "IsArray",
          refused("Invalid value of the `X-A` header"),
        ],
        [
          "Context logger",
          (value: unknown): unknown =>
            new Context({
              request: new BindenRequest(new Socket()),
              response: given(null),
              logger: given(value),
            }),
          "getPrototypeOf",
        ],
      ] as const) {
        const [name, create, operation, refusal = ownError] = row;
        deepStrictEqual(
          [
            outcome((): unknown => create(revoked())),
            outcome((): unknown => create(throwing())),
          ],
          [revokedError(operation), refusal],
          name,
        );
      }
    });

    test("createServer() formats the argument errors of Node.js", () => {
      const [type, , formatted] = outcome((): unknown =>
        new Binden().createServer({ requestTimeout: given("x") }),
      ) as unknown[];
      deepStrictEqual([type, formatted], ["TypeError", true]);
    });
  },
);

suite(
  "BindenError and BindenAbortError check their arguments first (R27-1)",
  () => {
    test("the status of a BindenError is checked before its default message is looked up, which would convert it", () => {
      conversions = 0;
      deepStrictEqual(
        [
          outcome((): unknown => new BindenError(given(counting("404")))),
          outcome((): unknown => new BindenError(given(revoked()))),
          outcome((): unknown => new BindenError(given(Symbol("s")))),
          outcome((): unknown => new BindenError(500, given(revoked()))),
        ],
        [
          refused("Invalid status code"),
          refused("Invalid status code"),
          refused("Invalid status code"),
          revokedError("get"),
        ],
      );
      deepStrictEqual(conversions, 0);
    });

    test("the values of a header of a BindenError are read once, by their indexes (an iterator of its own is not used)", () => {
      const values = ["a"];
      Reflect.set(values, Symbol.iterator, function* evil(): Generator<string> {
        yield "b\r\nX-Injected: 1";
      });
      const error = new BindenError(401, {
        headers: { "WWW-Authenticate": values },
      });
      deepStrictEqual(error.headers, { "WWW-Authenticate": ["a"] });
      ok(Object.isFrozen(error.headers["WWW-Authenticate"]));
    });

    test("a BindenAbortError of anything but its three reasons is refused, described", () => {
      conversions = 0;
      deepStrictEqual(
        [
          outcome((): unknown => new BindenAbortError(given(Symbol("s")))),
          outcome(
            (): unknown => new BindenAbortError(given(counting("deadline"))),
          ),
          outcome((): unknown => new BindenAbortError(given("timeout"))),
          new BindenAbortError("client_closed").reason,
          new BindenAbortError("deadline").reason,
          new BindenAbortError("shutdown").reason,
        ],
        [
          refused("Unknown abort reason: (a symbol)"),
          refused("Unknown abort reason: (an object)"),
          refused("Unknown abort reason: timeout"),
          "client_closed",
          "deadline",
          "shutdown",
        ],
      );
      deepStrictEqual(conversions, 0);
    });
  },
);

/**
 * A logger whose proxy throws the error of the test (a new one) from one of
 * its traps only: its methods are read as usual
 */
function oneTrap(trap: "getPrototypeOf" | "has" | "ownKeys"): object {
  const error = new RangeError("A trap of the test");
  own = error;
  const logger = {
    fatal: (): null => null,
    error: (): null => null,
    warn: (): null => null,
    info: (): null => null,
    debug: (): null => null,
    trace: (): null => null,
    child: (): unknown => logger,
  };
  return new Proxy(logger, {
    [trap]: (): never => {
      throw error;
    },
  });
}

suite(
  "What the checks and the copies of the options run once they are read is formatted (R28)",
  () => {
    test("new Binden() checks its logger inside the boundary, as a Context does: a proxy whose one trap throws", () => {
      deepStrictEqual(
        [
          outcome(
            (): unknown =>
              new Binden({ logger: given(oneTrap("getPrototypeOf")) }),
          ),
          outcome((): unknown => new Binden({ logger: given(oneTrap("has")) })),
          outcome(
            (): unknown => new Binden({ logger: given(oneTrap("ownKeys")) }),
          ),
          outcome(
            (): unknown =>
              new Context({
                request: new BindenRequest(new Socket()),
                response: given(null),
                logger: given(oneTrap("getPrototypeOf")),
              }),
          ),
        ],
        [ownError, "returned", "returned", ownError],
      );
    });

    test("the json of a BindenError is copied once by its constructor: what that runs is formatted, and its getter runs no code of the application", () => {
      /** A new error of the test (see `own`) */
      const fresh = (): RangeError => {
        own = new RangeError("A trap of the test");
        return own;
      };
      deepStrictEqual(
        [
          outcome((): unknown => {
            const error = fresh();
            return new BindenError(400, {
              json: {
                get a(): never {
                  throw error;
                },
              },
            });
          }),
          outcome((): unknown => {
            const error = fresh();
            const json = new Proxy(
              { a: 1 },
              {
                ownKeys: (): never => {
                  throw error;
                },
              },
            );
            return new BindenError(400, { json });
          }),
        ],
        [ownError, ownError],
      );
      let reads = 0;
      const json: Record<string, unknown> = {
        get a(): number {
          reads += 1;
          return reads;
        },
      };
      const created = new BindenError(400, { json, expose: true });
      json.b = 2;
      const [first, second] = [created.json, created.json];
      deepStrictEqual([first, second, reads], [{ a: 1 }, { a: 1 }, 1]);
      ok(first !== second);
    });
  },
);

suite("The routing formats what checking its arguments throws (R27-1)", () => {
  test("Router: a method described without converting it, a middleware that a revoked proxy is, and middlewares() of a method that is not a string", () => {
    conversions = 0;
    const router = new Router().get((): void => {
      // Nothing
    });
    deepStrictEqual(
      [
        outcome((): unknown =>
          new Router().on(given(counting("GET")), new Noop()),
        ),
        outcome((): unknown => new Router().on("GET", given(revoked()))),
        outcome((): unknown => new Router().on("GET", given(throwing()))),
        outcome((): unknown => router.middlewares(given(5))),
        outcome((): unknown => router.middlewares(given(counting("GET")))),
        router.middlewares("get").length,
      ],
      [
        refused("Method (an object) is not a valid token"),
        revokedError("getPrototypeOf"),
        ownError,
        refused("The method is not a string: 5"),
        refused("The method is not a string: (an object)"),
        1,
      ],
    );
    deepStrictEqual(conversions, 0);
  });

  test("a stack: use(), route(), mount() and off() of a revoked proxy, or one whose traps throw", () => {
    for (const [name, call] of [
      ["use()", (item: unknown): unknown => new Binden().use(given(item))],
      [
        "use(path)",
        (item: unknown): unknown => new Binden().use("/", given(item)),
      ],
      [
        "route()",
        (item: unknown): unknown => new Binden().route("/", given(item)),
      ],
      [
        "mount()",
        (item: unknown): unknown => new Binden().mount("/", given(item)),
      ],
      ["off()", (item: unknown): unknown => new Binden().off(given(item))],
    ] as const) {
      deepStrictEqual(
        [
          outcome((): unknown => call(revoked())),
          outcome((): unknown => call(throwing())),
        ],
        [revokedError("getPrototypeOf"), ownError],
        name,
      );
    }
  });
});

suite("A request formats what its methods and getters throw (R27-1)", () => {
  /** A request of the application, with headers */
  function requestOf(app: Binden = new Binden()): BindenRequest {
    const { IncomingMessage: Request } = app.serverOptions();
    const request = new Request(new Socket());
    request.headers = { host: "example.com", accept: "text/html" };
    request.url = "/";
    request.method = "GET";
    return request;
  }

  test("new BindenRequest() of a socket that a revoked proxy is, or whose getter throws (as Node.js reads it)", () => {
    deepStrictEqual(
      [
        outcome((): unknown => new BindenRequest(given(revoked()))),
        outcome((): unknown => new BindenRequest(given(throwing()))),
        outcome((): unknown => new BindenRequest(given(none))),
      ],
      [revokedError("get"), ownError, "returned"],
    );
  });

  test("header() of a name that is not a string, and accepts() of an offer that is not one, described without converting them", () => {
    conversions = 0;
    const request = requestOf();
    deepStrictEqual(
      [
        outcome((): unknown => request.header(given(5))),
        outcome((): unknown => request.header(given(counting("host")))),
        outcome((): unknown => request.accepts(given(counting("text/html")))),
        outcome((): unknown => request.acceptsLanguages("en", given(null))),
        request.header("Host"),
        request.accepts("text/html"),
      ],
      [
        refused("The name is not a string: 5"),
        refused("The name is not a string: (an object)"),
        refused("Invalid media type: (an object)"),
        refused("Invalid language tag: null"),
        "example.com",
        "text/html",
      ],
    );
    deepStrictEqual(conversions, 0);
  });

  test("a getter formats what a function of the application throws (e.g. `allowed_hosts` of URL, host and query)", () => {
    const request = requestOf(
      new Binden({
        allowed_hosts: (): boolean => {
          throw own;
        },
      }),
    );
    for (const name of ["URL", "host", "query"] as const) {
      own = new RangeError("A trap of the test");
      deepStrictEqual(
        outcome((): unknown => request[name]),
        ownError,
        name,
      );
    }
  });

  test("every method and getter that binden defines formats what reading the request throws (e.g. its headers or its socket, replaced by the application)", () => {
    const trusting = new Binden({ request_id: { trust_incoming: true } });
    for (const [name, read, replaced, app] of [
      ["accepts()", (r: BindenRequest): unknown => r.accepts("a/b"), "headers"],
      [
        "acceptsCharsets()",
        (r: BindenRequest): unknown => r.acceptsCharsets("utf-8"),
        "headers",
      ],
      [
        "acceptsEncodings()",
        (r: BindenRequest): unknown => r.acceptsEncodings("gzip"),
        "headers",
      ],
      [
        "acceptsLanguages()",
        (r: BindenRequest): unknown => r.acceptsLanguages("en"),
        "headers",
      ],
      ["header()", (r: BindenRequest): unknown => r.header("a"), "headers"],
      [
        "accept_encoding",
        (r: BindenRequest): unknown => r.accept_encoding,
        "headers",
      ],
      [
        "authorization",
        (r: BindenRequest): unknown => r.authorization,
        "headers",
      ],
      [
        "content_encoding",
        (r: BindenRequest): unknown => r.content_encoding,
        "headers",
      ],
      [
        "content_type",
        (r: BindenRequest): unknown => r.content_type,
        "headers",
      ],
      ["cookies", (r: BindenRequest): unknown => r.cookies, "headers"],
      ["forwarded", (r: BindenRequest): unknown => r.forwarded, "headers"],
      [
        "if_modified_since",
        (r: BindenRequest): unknown => r.if_modified_since,
        "headers",
      ],
      ["range", (r: BindenRequest): unknown => r.range, "headers"],
      ["host", (r: BindenRequest): unknown => r.host, "headers"],
      ["URL", (r: BindenRequest): unknown => r.URL, "headers"],
      ["query", (r: BindenRequest): unknown => r.query, "headers"],
      ["ip", (r: BindenRequest): unknown => r.ip, "socket"],
      ["ips", (r: BindenRequest): unknown => r.ips, "socket"],
      ["protocol", (r: BindenRequest): unknown => r.protocol, "socket"],
      ["secure", (r: BindenRequest): unknown => r.secure, "socket"],
      ["id", (r: BindenRequest): unknown => r.id, "headersDistinct", trusting],
    ] as const) {
      const request = requestOf(app);
      const error = new RangeError("A trap of the test");
      own = error;
      Object.defineProperty(request, replaced, {
        configurable: true,
        get: (): never => {
          throw error;
        },
      });
      deepStrictEqual(
        outcome((): unknown => read(request)),
        ownError,
        name,
      );
    }
  });

  test("an allowed host that is not one is described, never converted", () => {
    conversions = 0;
    deepStrictEqual(
      outcome((): unknown =>
        validateRequestOptions({ allowed_hosts: [given(counting("a.test"))] }),
      ),
      refused("`allowed_hosts` has an invalid host: (an object)"),
    );
    deepStrictEqual(conversions, 0);
  });
});

suite("The servers of binden format what their arguments throw (R27-1)", () => {
  test("callback() of a revoked proxy, and its listener of values that are not a request and a response", () => {
    const server = createServer();
    const listener = new Binden().callback(server);
    deepStrictEqual(
      [
        outcome((): unknown => new Binden().callback(given(revoked()))),
        outcome((): void => {
          listener(given(revoked()), given(revoked()));
        }),
      ],
      [revokedError("get"), revokedError("getPrototypeOf")],
    );
  });

  test("shutdown() of a revoked proxy, and the rejection of a value registered as a server that is not one (after the first await too)", async () => {
    const fake = Object.assign(new EventEmitter(), {
      listen: (): unknown => fake,
      listening: false,
    });
    deepStrictEqual(
      [
        outcome((): unknown => shutdown(given(revoked()))),
        await rejection(async (): Promise<unknown> =>
          shutdown(given<IServer>(fake)),
        ),
        isClosing(given(revoked())),
      ],
      [
        revokedError("get"),
        [
          "TypeError",
          "server.closeIdleConnections is not a function",
          true,
          false,
        ],
        false,
      ],
    );
  });

  test("the listen() of a server registered for shutdown() formats what Node.js throws for its arguments", async () => {
    const server = createServer();
    const closing = shutdown(server, { timeout: 1 });
    deepStrictEqual(
      [
        outcome((): unknown => server.listen(given(Symbol("port")))),
        // Without its message, which tells the trap that Node.js runs first
        // (`get` or `getPrototypeOf`, by its version)
        (
          outcome((): unknown => server.listen(given(revoked()))) as unknown[]
        ).filter((_, index) => index !== 1),
        outcome((): unknown => server.listen(given(throwing()))),
      ],
      [
        [
          "TypeError",
          "The argument 'options' is invalid. Received { port: Symbol(port) }",
          true,
          false,
        ],
        ["TypeError", true, false],
        ownError,
      ],
    );
    // Never bound: closed at once
    await within(closing);
  });

  test("the serializer of a context tells the type of a value that a revoked proxy is, without throwing", () => {
    deepStrictEqual(
      [serializers.context(revoked()), createSerializers().context(throwing())],
      [{ type: "object" }, { type: "object" }],
    );
  });

  test("framingLength() refuses a value that is neither a number nor a string (also an element), before it converts it, and formats what reading it throws", () => {
    conversions = 0;
    deepStrictEqual(
      [
        outcome((): unknown => framingLength(given(revoked()))),
        outcome((): unknown => framingLength(given(Symbol("s")))),
        outcome((): unknown => framingLength(given(counting("5")))),
        outcome((): unknown => framingLength(given(["5", counting("5")]))),
        framingLength("5"),
        framingLength(5),
        framingLength(["5", "5"]),
        framingLength(["4", "5"]),
        framingLength([]),
        framingLength(none),
      ],
      [
        revokedError("IsArray"),
        refused("Invalid Content-Length: (a symbol)"),
        refused("Invalid Content-Length: (an object)"),
        refused("Invalid Content-Length: (an object)"),
        5,
        5,
        5,
        null,
        null,
        null,
      ],
    );
    deepStrictEqual(conversions, 0);
  });

  test("formatting() formats what its function throws (also when it is not one), and described() never converts", () => {
    conversions = 0;
    own = new RangeError("A trap of the test");
    deepStrictEqual(
      [
        outcome((): unknown => formatting(given(5))),
        outcome((): unknown =>
          formatting(() => {
            throw own;
          }),
        ),
        described(counting()),
        described(5n),
      ],
      [
        ["TypeError", "run is not a function", true, false],
        ownError,
        "(an object)",
        "5n",
      ],
    );
    deepStrictEqual(conversions, 0);
  });
});
