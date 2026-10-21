// Run by `public-surface.test.ts` in a process of its own: enumerates at run
// time the public surface of the built entries of the five packages (every
// export, every constructor, and every static and prototype member of an
// exported class, by `Reflect.ownKeys()` and the descriptors: symbol keys
// too), runs a validated baseline call of each entry point (getters read,
// setters set, methods called, classes constructed), then the same call with
// each hostile value in each argument position (and the nested positions that
// its fixture names), each on fresh instances. Every `Error` that a call
// throws, or rejects with, must have its stack formatted before the caller
// gets it (recorded by `Error.prepareStackTrace`), an error that the test
// throws itself (from the traps of a proxy) must be passed on as itself, and a
// refusal must run no conversion of the value (but the documented ones, which
// the fixtures name). Prints a JSON report: `{ entries, probes, findings }`,
// each finding as `<entry> <probe>: <what>` (`--lines` prints one per line,
// `--only=<regex>` probes only the entries whose id matches).
import { type AddressInfo, Socket } from "node:net";
import { EventEmitter, once } from "node:events";
import {
  IncomingMessage,
  type Server,
  ServerResponse,
  createServer as createHttpServer,
} from "node:http";
import { isNativeError, isPromise, isProxy } from "node:util/types";
import { join } from "node:path";

const timer = setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 45_000);
timer.unref();

const HOST = "127.0.0.1";

/** How long a promise that a call returns may stay pending */
const pendingMs = 100;

/** The errors whose stack V8 has formatted (once it is first read) */
const formatted = new WeakSet<object>();
Reflect.set(
  Error,
  "prepareStackTrace",
  (error: Error, frames: readonly unknown[]): string => {
    formatted.add(error);
    return [
      `${error.name}: ${error.message}`,
      ...frames.map((frame) => `    at ${String(frame)}`),
    ].join("\n");
  },
);

const args = process.argv.slice(2);
const only = new RegExp(
  args.find((arg) => arg.startsWith("--only="))?.slice("--only=".length) ?? "",
  "u",
);

/** A function of the public surface */
type IFunction = (...values: unknown[]) => unknown;
/** A module namespace, or an object of the surface */
type IObject = Readonly<Record<PropertyKey, unknown>>;

/** Imports a module by a specifier that is not resolved at compile time */
async function load(specifier: string): Promise<IObject> {
  return (await import(specifier)) as IObject;
}

/** The built entries of the packages, by their names */
const packages: readonly string[] = [
  "binden",
  "@binden/logger",
  "@binden/body",
  "@binden/compression",
  "@binden/multipart",
];
const entries = new Map<string, IObject>();
for (const name of packages) {
  entries.set(name, await load(name));
}
const binden = entries.get("binden") as IObject;
const pino = (await load("pino")).default as IFunction;

/** The error that the traps of the hostile proxy throw */
class OwnError extends Error {}

/** A hostile value for an argument position, created for one probe */
interface IHostile {
  readonly name: string;
  readonly value: unknown;
  /** How many times its `toString()`, `valueOf()` or `@@toPrimitive` ran */
  conversions(): number;
  /** The errors that its traps have thrown */
  readonly thrown: readonly OwnError[];
}

/** The names of the hostile values */
const hostileNames = [
  "symbol",
  "null-prototype",
  "null",
  "revoked",
  "throwing",
  "counting",
] as const;

/** A fresh hostile value */
function hostile(name: (typeof hostileNames)[number]): IHostile {
  const thrown: OwnError[] = [];
  let conversions = 0;
  const none = (): number => 0;
  switch (name) {
    case "symbol":
      return { name, value: Symbol("hostile"), conversions: none, thrown };
    case "null-prototype":
      return { name, value: Object.create(null), conversions: none, thrown };
    case "null":
      return { name, value: null, conversions: none, thrown };
    case "revoked": {
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      return { name, value: proxy, conversions: none, thrown };
    }
    case "throwing": {
      const trap = (): never => {
        const error = new OwnError("A trap of the test");
        thrown.push(error);
        throw error;
      };
      const handler: ProxyHandler<object> = {
        apply: trap,
        construct: trap,
        defineProperty: trap,
        deleteProperty: trap,
        get: trap,
        getOwnPropertyDescriptor: trap,
        getPrototypeOf: trap,
        has: trap,
        isExtensible: trap,
        ownKeys: trap,
        preventExtensions: trap,
        set: trap,
        setPrototypeOf: trap,
      };
      return {
        name,
        value: new Proxy({}, handler),
        conversions: none,
        thrown,
      };
    }
    case "counting":
    default: {
      const value = {
        toString(): string {
          conversions += 1;
          return "a";
        },
        valueOf(): number {
          conversions += 1;
          return 1;
        },
        [Symbol.toPrimitive](): string {
          conversions += 1;
          return "a";
        },
      };
      return { name, value, conversions: () => conversions, thrown };
    }
  }
}

/** A function that does nothing */
function noop(): void {
  // Nothing
}

/** A logger that logs nothing (and so formats no error) */
const silent = {
  fatal: noop,
  error: noop,
  warn: noop,
  info: noop,
  debug: noop,
  trace: noop,
  child: (): unknown => silent,
};

/** A destination of `pino` that keeps nothing */
const sink = { write: noop };

/** What a probe has: what to clean up once it is done */
interface IEnv {
  /** A fresh request, response and context of a connection of their own */
  exchange(): Promise<IExchange>;
  /** A fresh HTTP server, not listening */
  server(): Server;
  /** A fresh HTTP server, listening */
  listening(): Promise<Server>;
  readonly cleanups: (() => unknown)[];
}

/** A request being handled by the application of the fixture */
interface IExchange {
  readonly context: object;
  readonly request: object;
  readonly response: object;
}

const Binden = binden.Binden as new (options: object) => {
  createServer(): Server;
  use(fn: IFunction): unknown;
};
/** The middleware of the exchanges waiting for their probe, by their id */
const waiting = new Map<
  string,
  (exchange: IExchange, release: () => void) => void
>();
const app = new Binden({ logger: silent });
app.use((context: unknown) => {
  const { request, response } = context as {
    request: IncomingMessage;
    response: object;
  };
  const id = String(request.headers["x-probe"]);
  const { promise, resolve } = Promise.withResolvers<null>();
  waiting.get(id)?.({ context: context as object, request, response }, () => {
    resolve(null);
  });
  return promise;
});
const server = app.createServer();
server.listen(0, HOST);
await once(server, "listening");
const { port } = server.address() as AddressInfo;
let exchanges = 0;

/** A fresh environment of a probe */
function environment(): IEnv {
  const cleanups: (() => unknown)[] = [];
  return {
    cleanups,
    async exchange(): Promise<IExchange> {
      exchanges += 1;
      const id = String(exchanges);
      const { promise, resolve } = Promise.withResolvers<IExchange>();
      waiting.set(id, (exchange, release) => {
        waiting.delete(id);
        const response = exchange.response as EventEmitter & {
          readonly closed: boolean;
          destroy(): void;
        };
        cleanups.push(async () => {
          const closed = response.closed ? null : once(response, "close");
          release();
          response.destroy();
          await closed;
        });
        resolve(exchange);
      });
      const socket = new Socket();
      cleanups.push(() => socket.destroy());
      socket.on("error", noop);
      socket.resume();
      socket.connect(port, HOST);
      socket.write(
        [
          "GET /path?a=1 HTTP/1.1",
          `Host: ${HOST}:${port}`,
          "Accept: text/html",
          "Accept-Charset: utf-8",
          "Accept-Encoding: gzip",
          "Accept-Language: en",
          "Authorization: Basic YTpi",
          "Content-Encoding: gzip",
          "Content-Type: text/plain",
          "Cookie: a=b",
          "Forwarded: for=192.0.2.1",
          "If-Modified-Since: Thu, 01 Jan 1970 00:00:00 GMT",
          "Range: bytes=0-1",
          `X-Probe: ${id}`,
          "",
          "",
        ].join("\r\n"),
      );
      return promise;
    },
    server(): Server {
      const created = createHttpServer();
      cleanups.push(() => created.close());
      return created;
    },
    async listening(): Promise<Server> {
      const created = createHttpServer();
      cleanups.push(() => {
        created.closeAllConnections();
        created.close();
      });
      created.listen(0, HOST);
      await once(created, "listening");
      return created;
    },
  };
}

/** The arguments of a valid call, made fresh for each probe */
type ICall = (
  env: IEnv,
  receiver: unknown,
) => Promise<readonly unknown[]> | readonly unknown[];

/** What a fixture adds to its calls */
interface IFixtureOptions {
  /**
   * Nested positions of the arguments probed as well (e.g. `[0, 0]`, the
   * first element of an array given first, or `[0, "key"]`): of every call
   * that has them
   */
  readonly deep?: readonly (readonly (number | string)[])[] | undefined;
  /**
   * The positions (e.g. `"0"` or `"0.key"`) whose conversion is documented
   * (see `headerInit` and `nodeCoercion`)
   */
  readonly converts?: Readonly<Record<string, string>> | undefined;
  /** Whether a baseline throws by design (e.g. `context.throw()`) */
  readonly throws?: boolean | undefined;
}

/** The fixture of an entry point */
interface IFixture extends IFixtureOptions {
  /** Its valid calls (overloads): each is asserted to succeed first */
  readonly calls: readonly ICall[];
}

/**
 * A documented conversion (README, Lifecycle): a value of the init of a
 * header (and the name and the attributes of `clearCookie()`), converted once
 * by `String()`
 */
const headerInit = "String() of a value of the init of a header";
/**
 * A documented conversion of Node.js, whose methods binden overrides (README,
 * Lifecycle): e.g. of the name and the value of a header, of the status code
 * of `writeHead()`, or of the name of an event
 */
const nodeCoercion = "a coercion of Node.js, through an override";

/** A function given as a middleware */
const middleware = (): void => {
  // Nothing
};
/** A function that returns `1` */
const one = (): number => 1;

/** The fixtures of the entry points, by their ids */
const fixtures: Record<string, IFixture> = {};

/** The receivers of the prototype members of the classes, by class id */
const receivers: Record<string, (env: IEnv) => unknown> = {
  "binden:BindenRequest": async (env) => (await env.exchange()).request,
  "binden:BindenResponse": async (env) => (await env.exchange()).response,
  "binden:Context": async (env) => (await env.exchange()).context,
};

/** Adds the fixtures of the members of a class or of an object of a package */
function define(prefix: string, defined: Record<string, IFixture>): void {
  for (const [key, fixture] of Object.entries(defined)) {
    fixtures[`${prefix}${key}`] = fixture;
  }
}

/** A fixture of its valid calls */
function call(...calls: ICall[]): IFixture {
  return { calls };
}

/** A fixture of its valid calls, and of what it adds to them */
function probed(options: IFixtureOptions, ...calls: ICall[]): IFixture {
  return { ...options, calls };
}

// The headers
const headerDate = "Thu, 01 Jan 1970 00:00:00 GMT";
for (const [name, init, input, inputs] of [
  [
    "Accept",
    { type: "text/html", parameters: { level: "1" }, q_value: 0.5 },
    "text/html",
    true,
  ],
  ["AcceptCharset", { charset: "utf-8", q_value: 0.5 }, "utf-8", true],
  ["AcceptEncoding", { encoding: "gzip", q_value: 0.5 }, "gzip", true],
  ["AcceptLanguage", { language: "en", q_value: 0.5 }, "en", true],
  [
    "Authorization",
    { type: "Basic", credentials: "YTpi" },
    "Basic YTpi",
    false,
  ],
  ["ContentEncoding", { encoding: "gzip" }, "gzip", false],
  ["ContentRange", { start: 0, end: 1, size: 2 }, "bytes 0-1/2", false],
  [
    "ContentType",
    {
      type: "multipart/form-data",
      charset: "utf-8",
      boundary: "boundary",
      parameters: { a: "b" },
    },
    "text/plain; charset=utf-8",
    false,
  ],
  [
    "Cookie",
    {
      key: "a",
      value: "b",
      expires: new Date(0),
      max_age: 1,
      domain: "example.com",
      path: "/",
      secure: true,
      http_only: true,
      same_site: "None",
      partitioned: true,
    },
    "a=b",
    false,
  ],
  [
    "Forwarded",
    {
      for: "192.0.2.1",
      by: "192.0.2.2",
      host: "example.com",
      proto: "https",
      secret: "secret",
    },
    "for=192.0.2.1",
    true,
  ],
  ["IfModifiedSince", { date: new Date(0) }, headerDate, false],
  ["Range", { start: 0, end: 1 }, "bytes=0-1", false],
] as const) {
  define(`binden:`, {
    [`new ${name}()`]: probed(
      {
        deep: Object.keys(init).map((key) => [0, key]),
        // The values that the types declare as strings (but the enumeration
        // `same_site` of a `Cookie`)
        converts: Object.fromEntries(
          Object.entries(init)
            .filter(
              ([key, value]) =>
                typeof value === "string" && key !== "same_site",
            )
            .map(([key]) => [`0.${key}`, headerInit]),
        ),
      },
      () => [structuredClone(init)],
    ),
    [`${name}.fromString()`]: inputs
      ? probed(
          { deep: [[0, 0]] },
          () => [input],
          () => [[input, input]],
        )
      : call(() => [input]),
    [`${name}#toString()`]: call(() => []),
  });
}
for (const [name, offer, other] of [
  ["Accept", "text/html", "application/json"],
  ["AcceptCharset", "utf-8", "latin1"],
  ["AcceptEncoding", "gzip", "br"],
  ["AcceptLanguage", "en", "fr"],
] as const) {
  fixtures[`binden:${name}.negotiate()`] = probed(
    {
      deep: [
        [0, 0],
        [1, 0],
      ],
    },
    () => [[offer, other], offer],
    () => [[offer], [offer, other]],
  );
}
define("binden:", {
  "Authorization.isValidType()": call(() => ["Basic"]),
  "Forwarded.parse()": probed(
    { deep: [[0, 0]] },
    () => ["for=192.0.2.1"],
    () => [["for=192.0.2.1"]],
  ),
});

// The errors, the middleware and the stack
define("binden:", {
  "new BindenError()": probed(
    {
      deep: ["message", "expose", "json", "cause", "code", "headers"].map(
        (key) => [1, key],
      ),
    },
    () => [404],
    () => [
      500,
      {
        message: "message",
        expose: true,
        json: { a: 1 },
        cause: 1,
        code: "code",
        headers: { "x-a": "b" },
      },
    ],
  ),
  "new BindenAbortError()": call(() => ["deadline"]),
  "new Middleware()": probed(
    {
      deep: [
        [0, "disabled"],
        [0, "ignore_errors"],
      ],
    },
    () => [],
    () => [{ disabled: false, ignore_errors: false }],
  ),
  "new Stack()": call(() => []),
  "Stack#use()": call(
    () => [middleware],
    () => ["/a", middleware, middleware],
    () => [/^\/a/u, middleware],
  ),
  "Stack#route()": call(() => ["/a/:b", middleware, middleware]),
  "Stack#mount()": call(() => ["/a", middleware, middleware]),
  "Stack#off()": call(
    () => [middleware],
    () => ["/a", middleware],
  ),
  "new Router()": probed(
    { deep: [[0, "guarded"]] },
    () => [],
    () => [{ guarded: true }],
  ),
  "Router#guarded =": call(() => [true]),
  "Router#on()": call(() => ["GET", middleware, middleware]),
  "Router#off()": call(() => ["GET", middleware]),
  "new Binden()": call(
    () => [],
    () => [{ logger: silent, timeout: 1000 }],
  ),
  "Binden#createServer()": call(() => [{}]),
  "Binden#createSecureServer()": call(() => [{}]),
  "Binden#serverOptions()": call(() => []),
  "Binden#callback()": call((env) => [env.server()]),
});
for (const verb of [
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "trace",
]) {
  fixtures[`binden:Router#${verb}()`] = call(() => [middleware, middleware]);
}

// The functions of binden
define("binden:", {
  "createSerializers()": call(() => [{ error_details: true }]),
  "described()": call(() => ["a"]),
  "formatStack()": call(() => [new Error("An error")]),
  "formatting()": call(() => [one]),
  "framingLength()": call(() => ["1"]),
  "isClosing()": call((env) => [env.server()]),
  "shutdown()": call(async (env) => [
    await env.listening(),
    { timeout: 50, cleanup_timeout: 50 },
  ]),
  "validateRequestOptions()": call(() => [
    {
      trust_proxy: false,
      encoded_slashes: false,
      allowed_hosts: ["example.com"],
      request_id: { header: "x-request-id", trust_incoming: false, echo: true },
      query: { max_keys: 10 },
    },
  ]),
  "validateResponseOptions()": call(() => [{ etag: true }]),
  "serializers.body()": call(() => ["body"]),
  "serializers.context()": call(async (env) => [
    (await env.exchange()).context,
  ]),
  "serializers.err()": call(() => [new Error("An error")]),
  "serializers.error()": call(() => [new Error("An error")]),
  "serializers.request()": call(async (env) => [
    (await env.exchange()).request,
  ]),
  "serializers.response()": call(async (env) => [
    (await env.exchange()).response,
  ]),
});

// The request, the response and the context
define("binden:", {
  "new BindenRequest()": call(() => [new Socket()]),
  "BindenRequest#accepts()": call(() => ["text/html", "application/json"]),
  "BindenRequest#acceptsCharsets()": call(() => ["utf-8", "latin1"]),
  "BindenRequest#acceptsEncodings()": call(() => ["gzip", "br"]),
  "BindenRequest#acceptsLanguages()": call(() => ["en", "fr"]),
  "BindenRequest#body =": call(() => [{ a: 1 }]),
  "BindenRequest#header()": call(() => ["accept"]),
  "new BindenResponse()": call(() => [
    new IncomingMessage(new Socket()),
    { etag: true },
  ]),
});

/** The fixtures of the methods that the response and the context share */
const replies: Record<string, IFixture> = {
  "status()": call(() => [201]),
  "type()": call(() => ["text/plain"]),
  "attachment()": call(
    () => [],
    () => ["a.txt"],
  ),
  "vary()": call(() => ["accept", "accept-encoding"]),
  "clearCookie()": probed(
    {
      deep: ["domain", "path", "secure", "same_site", "partitioned"].map(
        (key) => [1, key],
      ),
      converts: { 0: headerInit, "1.domain": headerInit, "1.path": headerInit },
    },
    () => [
      "a",
      {
        domain: "example.com",
        path: "/",
        secure: true,
        same_site: "None",
        partitioned: true,
      },
    ],
  ),
  "setHeader()": probed(
    { converts: { 0: nodeCoercion, 1: nodeCoercion } },
    () => ["x-a", "b"],
  ),
  "send()": call(
    () => [],
    () => ["text"],
  ),
  "json()": call(
    () => [{ a: 1 }],
    () => [{ a: 1 }, (data: unknown): string => JSON.stringify(data)],
  ),
  "text()": call(() => ["text"]),
  "html()": call(() => ["<p>"]),
  "form()": call(() => [new URLSearchParams("a=b")]),
  "redirect()": call(
    () => ["/a"],
    () => ["/a", 302, { allow_external: false }],
  ),
  "sendFile()": probed(
    {
      deep: [
        "root",
        "dotfiles",
        "etag",
        "last_modified",
        "cache_control",
        "content_type",
      ].map((key) => [1, key]),
    },
    () => [join(import.meta.dirname, "public-surface.ts")],
    () => [
      "public-surface.ts",
      {
        root: import.meta.dirname,
        dotfiles: "deny",
        etag: true,
        last_modified: true,
        cache_control: "no-cache",
        content_type: "text/plain",
      },
    ],
  ),
};
define("binden:Context#", {
  ...replies,
  "done =": call(() => [true]),
  "setTimeout()": call(() => [1000]),
  "onCleanup()": call(() => [noop]),
  "throw()": probed(
    { throws: true },
    () => [418],
    () => [418, { message: "message" }],
  ),
});
define("binden:", {
  "new Context()": call(async (env) => {
    const { request, response } = await env.exchange();
    return [{ request, response, logger: silent, state: {}, report: noop }];
  }),
});

/** A fixture of a listener method (whose event name Node.js converts) */
const listening = probed({ converts: { 0: nodeCoercion } }, () => [
  "custom",
  noop,
]);
define("binden:BindenResponse#", {
  ...replies,
  "set()": call(() => [{ "x-a": "b", "x-b": ["c", "d"] }]),
  "send()": call(
    () => [],
    () => ["text"],
    () => ["74657874", "hex"],
  ),
  "writeHead()": probed(
    { converts: { 0: nodeCoercion } },
    () => [200],
    () => [200, "OK", { "x-a": "b" }],
    () => [200, { "x-a": "b" }],
    () => [200, ["x-a", "b"]],
  ),
  "writeHeader()": probed(
    { converts: { 0: nodeCoercion } },
    () => [200],
    () => [200, "OK", { "x-a": "b" }],
    () => [200, { "x-a": "b" }],
  ),
  "write()": call(
    () => ["text"],
    () => ["text", noop],
    () => ["74657874", "hex", noop],
  ),
  "end()": call(
    () => [],
    () => [noop],
    () => ["text", noop],
    () => ["74657874", "hex", noop],
  ),
  "flushHeaders()": call(() => []),
  "getHeader()": call(() => ["x-a"]),
  "getHeaders()": call(() => []),
  "appendHeader()": probed(
    { converts: { 0: nodeCoercion, 1: nodeCoercion } },
    () => ["x-a", "b"],
    () => ["x-a", ["b", "c"]],
  ),
  "setHeaders()": call(
    () => [new Headers({ "x-a": "b" })],
    () => [new Map([["x-a", "b"]])],
  ),
  "setTimeout()": call(() => [1000, noop]),
  "removeHeader()": call(() => ["x-a"]),
  "addTrailers()": call(
    () => [{ "x-a": "b" }],
    () => [[["x-a", "b"]]],
  ),
  "destroy()": call(
    () => [],
    () => [new Error("An error")],
  ),
  "writeContinue()": call(() => [noop]),
  "writeProcessing()": call(() => [noop]),
  "writeEarlyHints()": call(() => [{ link: "</a>; rel=preload" }, noop]),
  // Node.js has it from 24.18.0 (binden throws without it); its overload
  // without headers (`writeInformation(102, callback)`) is refused by Node.js
  // 26.11.1 itself, whose headers must be an object
  "writeInformation()": probed(
    {
      throws:
        typeof Reflect.get(ServerResponse.prototype, "writeInformation") !==
        "function",
    },
    () => [103, { link: "</a>; rel=preload" }, noop],
  ),
  "flush()": call(() => []),
  "statusCode =": call(() => [201]),
  "statusMessage =": call(() => ["Created"]),
  "chunkedEncoding =": call(() => [false]),
  "maxRequestsOnConnectionReached =": call(() => [false]),
  "sendDate =": call(() => [true]),
  "shouldKeepAlive =": call(() => [false]),
  "strictContentLength =": call(() => [false]),
  "useChunkedEncodingByDefault =": call(() => [true]),
  "addListener()": listening,
  "on()": listening,
  "once()": listening,
  "prependListener()": listening,
  "prependOnceListener()": listening,
  "rawListeners()": probed({ converts: { 0: nodeCoercion } }, () => ["custom"]),
  "emit()": probed({ converts: { 0: nodeCoercion } }, () => ["custom", 1]),
  "[binden.saveFraming]()": call(() => []),
  "[binden.restoreFraming]()": call((_, receiver) => [
    Reflect.apply(
      Reflect.get(
        receiver as object,
        binden.kSaveFraming as symbol,
      ) as IFunction,
      receiver,
      [],
    ),
  ]),
  // Checks the arguments of `writeHead()` as Node.js does
  "[binden.validate_head]()": probed({ converts: { 0: nodeCoercion } }, () => [
    200,
    "OK",
    { "x-a": "b" },
  ]),
  "[binden.seal]()": call(() => [(): boolean => true]),
  "[binden.ownership]()": call(() => [
    {
      fail: (): boolean => false,
      guards: (): boolean => false,
      replier: (): null => null,
      native: (): boolean => false,
      debug: noop,
      warn: noop,
      note: noop,
    },
  ]),
  "[binden.revoke]()": call(() => [[{}], null]),
  "[binden.pipe_failure]()": call(() => [
    {},
    new Error("An error"),
    new EventEmitter(),
  ]),
  "[binden.listen]()": call(() => ["close", noop, { once: true }]),
  "[binden.unlisten]()": call(() => ["close", noop]),
  "[binden.cancel]()": call(() => [new Error("A reason")]),
  "[binden.cancelling]()": call(() => [new Error("A reason")]),
  "[binden.framework]()": call(() => [one]),
  "[binden.operation]()": call(() => []),
  "[binden.negotiator]()": call(() => [
    {
      choose: (): object => ({ coding: null, status: null }),
      forget: noop,
    },
  ]),
  "[binden.representation]()": call(() => [10]),
});

// @binden/logger
define("@binden/logger:", {
  "new Logger()": probed(
    {
      deep: [
        [0, "destination"],
        [0, "level"],
        [0, "error_details"],
      ],
    },
    () => [{ destination: sink, level: "info", error_details: true }],
  ),
  "Logger.fromPino()": call(() => [pino({ level: "info" }, sink)]),
  "Logger.getLevel()": call(
    () => [],
    () => ["LOG_LEVEL"],
  ),
  "Logger#level =": call(() => ["debug"]),
  "Logger#isLevelEnabled()": call(() => ["info"]),
  "Logger#flush()": call(() => []),
  "Logger#child()": call(
    () => [{ a: 1 }],
    () => [{ a: 1 }, { level: "debug" }],
  ),
  "createSerializers()": call(() => [{ error_details: true }]),
  "serializers.err()": call(() => [new Error("An error")]),
  "serializers.error()": call(() => [new Error("An error")]),
  "serializers.request()": call(async (env) => [
    (await env.exchange()).request,
  ]),
  "serializers.response()": call(async (env) => [
    (await env.exchange()).response,
  ]),
});
for (const level of ["fatal", "error", "warn", "info", "debug", "trace"]) {
  fixtures[`@binden/logger:Logger#${level}()`] = call(() => [
    "message",
    { a: 1 },
  ]);
}

/** A context of a fresh exchange, as the only argument */
const context = call(async (env) => [(await env.exchange()).context]);
const ContentType = binden.ContentType as new (init: object) => object;

// @binden/body, @binden/compression and @binden/multipart
define("@binden/body:", {
  "new BodyParser()": probed(
    {
      deep: [
        [0, "limit"],
        [0, "strict"],
      ],
    },
    () => [],
    () => [{ limit: 1000, strict: true }],
  ),
  "BodyParser#run()": context,
});
define("@binden/compression:", {
  "new Compression()": probed(
    {
      deep: [
        [0, "format"],
        [0, "threshold"],
      ],
    },
    () => [],
    () => [{ format: "auto", threshold: 0 }],
  ),
  "Compression#run()": context,
  "isCompressible()": call(
    () => [null],
    () => [new ContentType({ type: "text/plain" })],
  ),
  "skipCompression()": call(async (env) => [(await env.exchange()).response]),
});
define("@binden/multipart:", {
  "new Multipart()": call(
    () => [],
    () => [{}],
  ),
  "Multipart#run()": context,
  // The name is converted by the constructor of `File` of Node.js
  "new MultipartFile()": probed(
    { converts: { 1: nodeCoercion } },
    () => [["a"], "a.txt"],
    () => [["a"], "a.txt", { type: "text/plain", truncated: false }],
  ),
  "default()": call(
    () => [],
    () => [{}],
  ),
  "multipartInfo()": context,
});

/** An entry point of the surface */
interface IEntry {
  readonly id: string;
  readonly kind: "construct" | "get" | "method" | "set";
  /** The function: the class, the method, the getter or the setter */
  readonly fn: IFunction;
  /** Its receiver: none for a constructor or a function of a package */
  readonly receiver: ((env: IEnv) => unknown) | null;
}

/** The name of a key, as the ids show it */
function keyName(key: PropertyKey): string {
  return typeof key === "symbol" ? `[${String(key.description)}]` : String(key);
}

/** Whether a function is a class */
function isClass(value: unknown): value is IFunction {
  return (
    typeof value === "function" &&
    Function.prototype.toString.call(value).startsWith("class")
  );
}

/** The entry points of the members of an object (a class, a prototype…) */
function members(
  id: string,
  object: object,
  separator: string,
  receiver: ((env: IEnv) => unknown) | null,
  skipped: readonly PropertyKey[],
): IEntry[] {
  const found: IEntry[] = [];
  for (const key of Reflect.ownKeys(object)) {
    if (!skipped.includes(key)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(
        object,
        key,
      ) as PropertyDescriptor;
      const name = `${id}${separator}${keyName(key)}`;
      for (const [field, kind, suffix] of [
        ["get", "get", ""],
        ["set", "set", " ="],
        ["value", "method", "()"],
      ] as const) {
        const fn: unknown = Reflect.get(descriptor, field);
        if (typeof fn === "function") {
          found.push({
            id: `${name}${suffix}`,
            kind,
            fn: fn as IFunction,
            receiver,
          });
        }
      }
    }
  }
  return found;
}

/** Every entry point of the surface, and the ids of the classes */
function surface(): [IEntry[], Set<string>] {
  const found: IEntry[] = [];
  const classes = new Set<string>();
  const prototypes = new Set<unknown>();
  for (const namespace of entries.values()) {
    for (const value of Object.values(namespace)) {
      if (isClass(value)) {
        prototypes.add(value.prototype);
      }
    }
  }
  for (const [name, namespace] of entries) {
    for (const key of Reflect.ownKeys(namespace)) {
      const value = namespace[key];
      const id = `${name}:${keyName(key)}`;
      if (isClass(value)) {
        classes.add(id);
        found.push({
          id: `${name}:new ${keyName(key)}()`,
          kind: "construct",
          fn: value,
          receiver: null,
        });
        found.push(
          ...members(id, value, ".", () => value, [
            "length",
            "name",
            "prototype",
          ]),
        );
        const constructor = `${name}:new ${keyName(key)}()`;
        // An instance of the first valid call of the constructor
        const make = Object.hasOwn(receivers, id)
          ? receivers[id]
          : async (env: IEnv): Promise<unknown> => {
              if (!Object.hasOwn(fixtures, constructor)) {
                throw new TypeError("No instance without a constructor");
              }
              const [made] = fixtures[constructor].calls;
              return Reflect.construct(value, await made(env, null));
            };
        found.push(
          ...members(id, value.prototype as object, "#", make, ["constructor"]),
        );
      } else if (typeof value === "function") {
        found.push({
          id: `${id}()`,
          kind: "method",
          fn: value as IFunction,
          receiver: null,
        });
      } else if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        !prototypes.has(Object.getPrototypeOf(value))
      ) {
        found.push(...members(id, value, ".", () => value, []));
      }
    }
  }
  return [found, classes];
}

/** What a call has done */
type IOutcome =
  | { readonly kind: "pending" }
  | { readonly kind: "rejected"; readonly error: unknown }
  | { readonly kind: "resolved" }
  | { readonly kind: "returned" }
  | IThrown;
/** A call that has thrown */
interface IThrown {
  readonly kind: "thrown";
  readonly error: unknown;
}

/** Calls an entry point: what it returns, or throws */
function start(
  entry: IEntry,
  receiver: unknown,
  values: readonly unknown[],
): { readonly kind: "started"; readonly result: unknown } | IThrown {
  try {
    return {
      kind: "started",
      result:
        entry.kind === "construct"
          ? Reflect.construct(entry.fn, values)
          : Reflect.apply(entry.fn, receiver, values),
    };
  } catch (error: unknown) {
    return { kind: "thrown", error };
  }
}

/** Runs an entry point once: what it returns, throws or settles with */
async function invoke(
  entry: IEntry,
  receiver: unknown,
  values: readonly unknown[],
): Promise<IOutcome> {
  const started = start(entry, receiver, values);
  if (started.kind === "thrown") {
    return started;
  }
  const { result } = started;
  if (!isPromise(result)) {
    return { kind: "returned" };
  }
  const promise = result;
  const { promise: expired, resolve } = Promise.withResolvers<IOutcome>();
  const timeout = setTimeout(() => {
    resolve({ kind: "pending" });
  }, pendingMs);
  try {
    return await Promise.race([
      promise.then(
        (): IOutcome => ({ kind: "resolved" }),
        (error: unknown): IOutcome => ({ kind: "rejected", error }),
      ),
      expired,
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

/** Describes a thrown value without running code of the application */
function describe(error: unknown): string {
  if (isProxy(error) || typeof error !== "object" || error === null) {
    return `(${typeof error})`;
  }
  if (isNativeError(error)) {
    return `${error.constructor.name}: ${error.message}`;
  }
  return "(an object)";
}

/** The late failures of the process (an uncaught exception or rejection) */
const late: string[] = [];
process.on("uncaughtException", (error) => {
  late.push(`uncaught ${describe(error)}`);
});
process.on("unhandledRejection", (error) => {
  late.push(`unhandled rejection ${describe(error)}`);
});

/** Replaces the value at a path of the arguments (copying what holds it) */
function replaced(
  values: readonly unknown[],
  path: readonly (number | string)[],
  value: unknown,
): unknown[] | null {
  const copy = (
    holder: unknown,
    rest: readonly (number | string)[],
  ): unknown => {
    const [head, ...tail] = rest;
    if (Array.isArray(holder)) {
      const index = Number(head);
      if (index >= holder.length) {
        throw new RangeError("missing");
      }
      const array: unknown[] = [...(holder as unknown[])];
      array[index] = tail.length === 0 ? value : copy(array[index], tail);
      return array;
    }
    if (
      typeof holder !== "object" ||
      holder === null ||
      !Object.hasOwn(holder, head)
    ) {
      throw new RangeError("missing");
    }
    const object = { ...holder } as Record<string, unknown>;
    object[head as string] =
      tail.length === 0 ? value : copy(object[head as string], tail);
    return object;
  };
  try {
    return copy(values, path) as unknown[];
  } catch {
    return null;
  }
}

/** Waits for a turn of the event loop (late failures are reported then) */
function turn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Cleans up the environment of a probe (bounded), then waits for two turns
 * of the event loop: a late failure of the probe is reported by then
 */
async function clean(env: IEnv): Promise<void> {
  const pending: unknown[] = [];
  for (const cleanup of env.cleanups.reverse()) {
    try {
      pending.push(cleanup());
    } catch {
      // E.g. a server that is not listening
    }
  }
  const { promise: expired, resolve } = Promise.withResolvers<null>();
  const timeout = setTimeout(() => {
    resolve(null);
  }, 1000);
  await Promise.race([Promise.allSettled(pending), expired]);
  clearTimeout(timeout);
  await turn();
  await turn();
}

/** A finding: what an entry point has done wrong, in which probe */
interface IFinding {
  readonly entry: string;
  /** `baseline`, or the position and the hostile value (e.g. `0.key null`) */
  readonly probe: string;
  readonly what: string;
}

/** Evaluates what a probe has done (see `probe()`) */
function evaluate(
  fixture: IFixture,
  path: readonly (number | string)[] | null,
  given: IHostile | null,
  outcome: IOutcome,
): string[] {
  const position = path?.join(".") ?? "";
  const converted =
    given !== null &&
    given.conversions() > 0 &&
    !Object.hasOwn(fixture.converts ?? {}, position);
  const conversions = `converted ${String(given?.conversions())}x`;
  switch (outcome.kind) {
    case "pending":
      return [`still pending after ${String(pendingMs)} ms`];
    case "returned":
    case "resolved":
      if (path === null && fixture.throws === true) {
        return ["does not throw"];
      }
      return converted ? [conversions] : [];
    case "thrown":
    case "rejected":
    default: {
      const { error } = outcome;
      const how = outcome.kind === "thrown" ? "throws" : "rejects with";
      const isError = !isProxy(error) && isNativeError(error);
      const isFormatted = isError && formatted.has(error);
      const found: string[] = [];
      if (path === null) {
        if (fixture.throws !== true || !isFormatted) {
          found.push(`${how} ${describe(error)}`);
        }
      } else if (isError && !isFormatted) {
        found.push(`${how} UNFORMATTED ${describe(error)}`);
      }
      if (given !== null) {
        const own = given.thrown.at(-1);
        if (error instanceof OwnError && !given.thrown.includes(error)) {
          found.push(`${how} another error of the test`);
        } else if (typeof own !== "undefined" && !(error instanceof OwnError)) {
          found.push(`${how} ${describe(error)}, not the error of the test`);
        }
        if (converted) {
          found.push(`${conversions} before it ${how.split(" ")[0] ?? ""}`);
        }
      }
      return found;
    }
  }
}

/** Runs a probe on a fresh environment, and cleans it up */
async function probe(
  entry: IEntry,
  fixture: IFixture,
  made: ICall,
  path: readonly (number | string)[] | null,
  given: IHostile | null,
): Promise<IFinding[]> {
  const env = environment();
  const at =
    path === null ? "baseline" : `${path.join(".")} ${given?.name ?? ""}`;
  const found: string[] = [];
  try {
    const receiver = entry.receiver === null ? null : await entry.receiver(env);
    const baseline = entry.kind === "get" ? [] : await made(env, receiver);
    const values =
      path === null ? baseline : replaced(baseline, path, given?.value);
    if (values === null) {
      found.push("the position does not exist");
    } else {
      found.push(
        ...evaluate(
          fixture,
          path,
          given,
          await invoke(entry, receiver, values),
        ),
      );
    }
  } catch (error: unknown) {
    found.push(`the fixture fails: ${describe(error)}`);
  } finally {
    await clean(env);
    found.push(...late.splice(0));
  }
  return found.map((what) => ({ entry: entry.id, probe: at, what }));
}

/** The positions of a baseline that are probed: each argument, and `deep` */
function positions(
  fixture: IFixture,
  baseline: readonly unknown[],
): (readonly (number | string)[])[] {
  return [
    ...baseline.map((_, index) => [index]),
    ...(fixture.deep ?? []).filter(
      (path) => replaced(baseline, path, null) !== null,
    ),
  ];
}

const [all, classes] = surface();
const findings: IFinding[] = [];
let probes = 0;
const ids = new Set(all.map(({ id }) => id));
for (const id of Object.keys(fixtures)) {
  if (!ids.has(id)) {
    findings.push({ entry: id, probe: "-", what: "names nothing" });
  }
}
for (const id of Object.keys(receivers)) {
  if (!classes.has(id)) {
    findings.push({ entry: id, probe: "-", what: "names no class" });
  }
}
for (const entry of all.filter(({ id }) => only.test(id))) {
  const fixture = Object.hasOwn(fixtures, entry.id)
    ? fixtures[entry.id]
    : entry.kind === "get"
      ? call(() => [])
      : null;
  if (fixture === null) {
    findings.push({ entry: entry.id, probe: "-", what: "no baseline" });
  } else {
    /** The positions probed, as the keys of `converts` name them */
    const covered = new Set<string>();
    for (const made of fixture.calls) {
      probes += 1;
      const failures = await probe(entry, fixture, made, null, null);
      findings.push(...failures);
      if (failures.length === 0 && entry.kind !== "get") {
        const env = environment();
        const receiver =
          entry.receiver === null ? null : await entry.receiver(env);
        const baseline = await made(env, receiver);
        await clean(env);
        for (const path of positions(fixture, baseline)) {
          covered.add(path.join("."));
          for (const name of hostileNames) {
            probes += 1;
            findings.push(
              ...(await probe(entry, fixture, made, path, hostile(name))),
            );
          }
        }
      }
    }
    for (const position of Object.keys(fixture.converts ?? {})) {
      if (!covered.has(position)) {
        findings.push({
          entry: entry.id,
          probe: position,
          what: "a documented conversion of a position not probed",
        });
      }
    }
  }
}

server.closeAllConnections();
server.close();
// Exits once the report is written (a pipe may take it asynchronously)
process.stdout.write(
  args.includes("--lines")
    ? `${[
        ...findings.map(
          ({ entry, probe: at, what }) => `${entry} | ${at}: ${what}`,
        ),
        `${String(all.length)} entries, ${String(probes)} probes, ${String(findings.length)} findings`,
      ].join("\n")}\n`
    : `${JSON.stringify({ entries: [...ids], probes, findings })}\n`,
  () => {
    process.exit(0);
  },
);
