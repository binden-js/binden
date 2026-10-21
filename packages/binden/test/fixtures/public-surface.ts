// Run by `public-surface.test.ts` in a process of its own: enumerates at run
// time the public surface of the built entries of the five packages (every
// export, every constructor, and every static and prototype member of an
// exported class, by `Reflect.ownKeys()` and the descriptors, symbol keys too,
// the functions that an entry point returns or installs on an object, see
// `returned` and `installed`, and the members of the objects that it returns,
// see `members`), runs a validated baseline call of each entry point (getters
// read, on an instance of each valid call of their constructor, setters set,
// methods called, classes constructed), then the same call with each hostile
// value in each argument position (and the nested positions that its fixture
// names), each on fresh instances, the members of a response and of a context
// also once the head of the response is sent, once it has ended and once it is
// destroyed (see `states`). Every `Error` that a call throws, or rejects with,
// and every one that a reader of what it has stored throws (see `readers`),
// must have its stack formatted before the caller gets it (recorded by
// `Error.prepareStackTrace`), an error that the test throws itself (from the
// traps of a proxy) must be passed on as itself, a call must run no conversion
// of a value but the documented ones, which the fixtures name, each as often
// as documented (`String()` once, or as often as plain Node.js does, see
// `headerInit` and `nodeCoercion`), each option, init and argument must be read
// at most once, and each probed position must be examined by a hostile value
// (refused, converted or read), unless its fixture says why it is not. An
// allowance that permits more than happens is a finding too.
// Prints a JSON report: `{ entries, probes, findings }`, each finding as
// `<entry> | <probe>: <what>` with `--lines` (one per line), and
// `--only=<text>` probes only the entries whose id contains it.
import { type AddressInfo, Server as NetServer, Socket } from "node:net";
import { EventEmitter, once } from "node:events";
import {
  IncomingMessage,
  type Server,
  ServerResponse,
  createServer as createHttpServer,
} from "node:http";
import { isNativeError, isPromise, isProxy } from "node:util/types";
import { join } from "node:path";
import { tmpdir } from "node:os";

const timer = setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 100_000);
timer.unref();

const HOST = "127.0.0.1";

/** How long a promise that a call returns may stay pending */
const pendingMs = 100;
/**
 * How long a promise of a call that does I/O (see `io`) may stay pending
 * (e.g. on a loaded machine)
 */
const ioMs = 5000;
/** How long making the receiver or the arguments of a call may take */
const makeMs = 10_000;
/** How long the cleanup of a probe may take */
const cleanMs = 5000;

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
// A plain substring, not a regular expression built from an argument
const only =
  args.find((arg) => arg.startsWith("--only="))?.slice("--only=".length) ?? "";

/** A function of the public surface */
type IFunction = (...values: unknown[]) => unknown;
/** A module namespace, or an object of the surface */
type IObject = Readonly<Record<PropertyKey, unknown>>;

/** Imports a module by a specifier that is not resolved at compile time */
async function load(specifier: string): Promise<IObject> {
  return (await import(specifier)) as IObject;
}

/** Whether a value is an object or a function (what a proxy can wrap) */
function isObject(value: unknown): value is object {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  );
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

/** Whether a function is a class */
function isClass(value: unknown): value is IFunction {
  return (
    typeof value === "function" &&
    Function.prototype.toString.call(value).startsWith("class")
  );
}

/**
 * The prototypes of the language and of Node.js (and `null`), where the
 * members of an object of a package end (see `members`)
 */
const foreign = new Set<unknown>([null]);
/** Adds the prototype chain of a class of the language or of Node.js */
function addForeign(value: unknown): void {
  if (typeof value === "function") {
    let prototype: unknown = Reflect.get(value, "prototype");
    while (isObject(prototype) && !foreign.has(prototype)) {
      foreign.add(prototype);
      prototype = Object.getPrototypeOf(prototype);
    }
  }
}
for (const key of Reflect.ownKeys(globalThis)) {
  // Not a getter of the global object (e.g. a deprecated one)
  addForeign(Reflect.getOwnPropertyDescriptor(globalThis, key)?.value);
}
for (const name of [
  "node:buffer",
  "node:events",
  "node:fs",
  "node:http",
  "node:https",
  "node:net",
  "node:stream",
  "node:tls",
  "node:url",
  "node:zlib",
]) {
  for (const value of Object.values(await load(name))) {
    addForeign(value);
  }
}
/** The prototypes of the exported classes, whose members are probed */
const exported = new Set<unknown>();
for (const namespace of entries.values()) {
  for (const value of Object.values(namespace)) {
    if (isClass(value)) {
      exported.add(value.prototype);
    }
  }
}

/** The error that the traps of the hostile proxies throw */
class OwnError extends Error {}

/** The names of the hostile values */
const hostileNames = [
  "symbol",
  "null-prototype",
  "null",
  "undefined",
  "bigint",
  "revoked",
  "throwing",
  "revoked-function",
  "throwing-function",
  "class",
  "prototype-trap",
  "keys-trap",
  "has-trap",
  "counting",
  "late",
  "late-use",
] as const;
/** The name of a hostile value */
type IHostileName = (typeof hostileNames)[number];

/** A hostile value for an argument position, created for one probe */
interface IHostile {
  readonly name: IHostileName;
  readonly value: unknown;
  /** How many times its `toString()`, `valueOf()` or `@@toPrimitive` ran */
  conversions(): number;
  /** The errors that its traps (or its getter) have thrown */
  readonly thrown: readonly OwnError[];
  /**
   * How it is placed in its holder instead of as a value (`late`: a getter
   * that gives the valid value once, then throws)
   */
  readonly place?: ((valid: unknown) => PropertyDescriptor) | undefined;
  /**
   * Called once the synchronous part of the call has returned (`late-use`:
   * from then on, its traps throw)
   */
  readonly arm?: (() => void) | undefined;
}

/** The traps of a proxy */
const trapNames = [
  "apply",
  "construct",
  "defineProperty",
  "deleteProperty",
  "getOwnPropertyDescriptor",
  "getPrototypeOf",
  "has",
  "isExtensible",
  "ownKeys",
  "preventExtensions",
  "set",
  "setPrototypeOf",
] as const;

/** A function that does nothing */
function noop(): void {
  // Nothing
}

/**
 * A fresh hostile value, made from the valid value of its position (e.g. the
 * proxies of it whose one trap throws, and `late`)
 */
function hostile(name: IHostileName, valid: unknown): IHostile {
  const thrown: OwnError[] = [];
  let conversions = 0;
  const none = (): number => 0;
  const trap = (): never => {
    const error = new OwnError("A trap of the test");
    thrown.push(error);
    throw error;
  };
  /** A handler whose every trap throws */
  const every: ProxyHandler<object> = {
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
  /** A proxy of the valid value (of an object, for a primitive) */
  const one = (handler: ProxyHandler<object>): IHostile => ({
    name,
    value: new Proxy(isObject(valid) ? valid : {}, handler),
    conversions: none,
    thrown,
  });
  switch (name) {
    case "symbol":
      return { name, value: Symbol("hostile"), conversions: none, thrown };
    case "null-prototype":
      return { name, value: Object.create(null), conversions: none, thrown };
    case "null":
      return { name, value: null, conversions: none, thrown };
    case "undefined":
      return {
        name,
        value: Reflect.get({}, "undefined"),
        conversions: none,
        thrown,
      };
    case "bigint":
      return { name, value: 10n, conversions: none, thrown };
    case "revoked": {
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      return { name, value: proxy, conversions: none, thrown };
    }
    case "throwing":
      return { name, value: new Proxy({}, every), conversions: none, thrown };
    case "revoked-function": {
      const { proxy, revoke } = Proxy.revocable(noop, {});
      revoke();
      return { name, value: proxy, conversions: none, thrown };
    }
    case "throwing-function":
      return {
        name,
        value: new Proxy(noop, every),
        conversions: none,
        thrown,
      };
    case "class":
      return {
        name,
        value: class Hostile {
          public readonly created = Date.now();
        },
        conversions: none,
        thrown,
      };
    case "prototype-trap":
      return one({ getPrototypeOf: trap });
    case "keys-trap":
      return one({ ownKeys: trap });
    case "has-trap":
      return one({ has: trap });
    case "late-use": {
      // The valid value, used as it is (its methods bound to it, so that its
      // private fields are read, and the objects that it gives used in the
      // same way, e.g. the response of a context), until the call has
      // returned: a later use (e.g. after an `await`) throws
      let armed = false;
      const proxies = new WeakMap<object, object>();
      const handler: ProxyHandler<object> = {
        get(target: object, key: PropertyKey): unknown {
          if (armed) {
            return trap();
          }
          const value: unknown = Reflect.get(target, key, target);
          const own = Reflect.getOwnPropertyDescriptor(target, key);
          if (
            typeof value !== "object" ||
            value === null ||
            (own?.configurable === false && own.writable === false)
          ) {
            // A function is bound to its object (a class is not called)
            return typeof value === "function" && !isClass(value)
              ? (value as IFunction).bind(target)
              : value;
          }
          const proxy = proxies.get(value) ?? new Proxy(value, handler);
          proxies.set(value, proxy);
          return proxy;
        },
      };
      const forwarded = (key: (typeof trapNames)[number]): IFunction =>
        function forward(...values: unknown[]): unknown {
          if (armed) {
            return trap();
          }
          return Reflect.apply(
            Reflect.get(Reflect, key) as IFunction,
            Reflect,
            values,
          );
        };
      for (const key of trapNames) {
        Reflect.set(handler, key, forwarded(key));
      }
      return {
        name,
        value: new Proxy(valid as object, handler),
        conversions: none,
        thrown,
        arm(): void {
          armed = true;
        },
      };
    }
    case "late":
      return {
        name,
        value: valid,
        conversions: none,
        thrown,
        place(value: unknown): PropertyDescriptor {
          let reads = 0;
          return {
            configurable: true,
            enumerable: true,
            get(): unknown {
              reads += 1;
              return reads > 1 ? trap() : value;
            },
          };
        },
      };
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

/** Waits for a turn of the event loop (late failures are reported then) */
function turn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** Waits for a promise, for `ms` at most: an `Error` that says what expired */
async function bounded<T>(
  promise: Promise<T> | T,
  ms: number,
  what: string,
): Promise<T> {
  const { promise: expired, reject } = Promise.withResolvers<never>();
  const timeout = setTimeout(() => {
    reject(new Error(`${what} has not settled in ${String(ms)} ms`));
  }, ms);
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timeout);
  }
}

/** What a probe has: what to clean up once it is done */
interface IEnv {
  /**
   * A fresh request, response and context of a connection of their own (a
   * `GET`, or a `POST` of a body, see `IBody`)
   */
  exchange(body?: IBody): Promise<IExchange>;
  /** A fresh HTTP server, not listening */
  server(): Server;
  /** A fresh HTTP server, listening */
  listening(): Promise<Server>;
  readonly cleanups: (() => unknown)[];
}

/**
 * The body of the request of an exchange: none (a `GET`), or the body of a
 * `POST` over the limits of the parsers of the fixtures (`text`, chunked, of
 * 10 bytes, and `multipart`, a file of 8 bytes)
 */
type IBody = "multipart" | "none" | "text";

/** The head (and the body) of the request of an exchange */
function requestOf(body: IBody, id: string, at: number): string {
  const form = [
    "--B",
    'Content-Disposition: form-data; name="f"; filename="a.txt"',
    "Content-Type: text/plain",
    "",
    "abcdefgh",
    "--B--",
    "",
  ].join("\r\n");
  const requests: Readonly<
    Record<IBody, readonly [string, readonly string[], string]>
  > = {
    none: ["GET", ["Content-Encoding: gzip", "Content-Type: text/plain"], ""],
    text: [
      "POST",
      ["Content-Type: text/plain", "Transfer-Encoding: chunked"],
      "2\r\nab\r\n8\r\nabcdefgh\r\n0\r\n\r\n",
    ],
    multipart: [
      "POST",
      [
        "Content-Type: multipart/form-data; boundary=B",
        `Content-Length: ${String(form.length)}`,
      ],
      form,
    ],
  };
  const [method, fields, content] = requests[body];
  return [
    `${method} /path?a=1 HTTP/1.1`,
    `Host: ${HOST}:${String(at)}`,
    "Accept: text/html",
    "Accept-Charset: utf-8",
    "Accept-Encoding: gzip",
    "Accept-Language: en",
    "Authorization: Basic YTpi",
    ...fields,
    "Cookie: a=b",
    "Forwarded: for=192.0.2.1",
    "If-Modified-Since: Thu, 01 Jan 1970 00:00:00 GMT",
    "Range: bytes=0-1",
    `X-Probe: ${id}`,
    "",
    content,
  ].join("\r\n");
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

/** Describes a thrown value without running code of the application */
function describe(error: unknown): string {
  if (isProxy(error) || typeof error !== "object" || error === null) {
    return `(${typeof error})`;
  }
  if (isNativeError(error)) {
    // On one line (e.g. a message of Node.js that quotes an object)
    return `${error.constructor.name}: ${error.message.replaceAll(/\s*\n\s*/gu, " ")}`;
  }
  return "(an object)";
}

/**
 * Closes the client side of a connection once the server has closed it (its
 * `close`, bounded): the server closes first, so that the ports of the
 * clients do not wait in `TIME_WAIT` (a run makes thousands of connections,
 * and back-to-back runs would exhaust them)
 */
async function closed(socket: Socket): Promise<void> {
  if (!socket.closed) {
    const { promise: expired, resolve } = Promise.withResolvers<null>();
    const timeout = setTimeout(() => {
      resolve(null);
    }, 1000);
    await Promise.race([once(socket, "close"), expired]);
    clearTimeout(timeout);
  }
  socket.destroy();
}

/** A fresh environment of a probe */
function environment(): IEnv {
  const cleanups: (() => unknown)[] = [];
  return {
    cleanups,
    exchange(body: IBody = "none"): Promise<IExchange> {
      exchanges += 1;
      const id = String(exchanges);
      const { promise, resolve, reject } = Promise.withResolvers<IExchange>();
      const socket = new Socket();
      let arrived = false;
      // Before its request has arrived, a failure of its socket fails the
      // exchange (and so the probe), instead of leaving it pending
      const failed = (why: string): void => {
        if (!arrived) {
          waiting.delete(id);
          reject(new Error(`The connection of an exchange ${why}`));
        }
      };
      socket.on("error", (error) => {
        failed(`has failed (${describe(error)})`);
      });
      socket.on("close", () => {
        failed("has closed before its request");
      });
      cleanups.push(() => closed(socket));
      waiting.set(id, (exchange, release) => {
        arrived = true;
        waiting.delete(id);
        const response = exchange.response as EventEmitter & {
          readonly closed: boolean;
          destroy(): void;
        };
        // The socket of the server (also once a response that has ended is
        // detached from it)
        const { socket: own } = exchange.request as IncomingMessage;
        // Run before the cleanup of the socket: the server closes first
        cleanups.push(async () => {
          const ended = response.closed ? null : once(response, "close");
          release();
          own.destroy();
          try {
            response.destroy();
          } catch {
            // E.g. once a probe has given it hostile handlers
          }
          await ended;
        });
        resolve(exchange);
      });
      socket.resume();
      socket.connect(port, HOST);
      socket.write(requestOf(body, id, port));
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

/**
 * The states of a response (also of a context) that its members are probed
 * in, besides a fresh one: its head sent, ended, destroyed
 */
const states = ["sent", "ended", "destroyed"] as const;
/** The state of a response */
type IState = "fresh" | (typeof states)[number];

/** Puts a fresh response in a state */
function enter(response: unknown, state: IState): void {
  const target = response as ServerResponse;
  if (state === "sent") {
    target.writeHead(200);
    target.flushHeaders();
  } else if (state === "ended") {
    target.end();
  } else if (state === "destroyed") {
    target.destroy();
  }
}

/** A plain response of Node.js (of no connection), in a state */
function plainResponse(state: IState): ServerResponse {
  const response = new ServerResponse(new IncomingMessage(new Socket()));
  enter(response, state);
  return response;
}

/** A receiver of the members of a class (or of what a package installs) */
interface IReceiver {
  /** What it is, `""` for the default one (e.g. `sent` or `instance 1`) */
  readonly name: string;
  /** The state of the response that it is, or has */
  readonly state: IState;
  make(env: IEnv): unknown;
}

/** The default receiver, made by a function */
function fresh(make: (env: IEnv) => unknown): IReceiver {
  return { name: "", state: "fresh", make };
}

/**
 * The receivers of the members of a response (or of an object that has one,
 * whose response `of()` gives): a fresh one, and one in each state
 */
function stated(
  make: (env: IEnv) => unknown,
  of: (made: unknown) => unknown,
): readonly IReceiver[] {
  return [
    fresh(make),
    ...states.map((state): IReceiver => ({
      name: state,
      state,
      async make(env: IEnv): Promise<unknown> {
        const made = await make(env);
        enter(of(made), state);
        await turn();
        return made;
      },
    })),
  ];
}

/** The arguments of a valid call, made fresh for each probe */
type ICall = (
  env: IEnv,
  receiver: unknown,
) => Promise<readonly unknown[]> | readonly unknown[];

/** What the plain call of Node.js gets (see `node`) */
interface IPlain {
  readonly env: IEnv;
  /** A plain response of Node.js, in the state of the receiver of the probe */
  response(): ServerResponse;
}

/**
 * The same call on plain Node.js (e.g. of `setHeader()` on a plain response),
 * with the same values
 */
type INode = (values: readonly unknown[], plain: IPlain) => unknown;

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
  /**
   * The same call on plain Node.js: a position of `nodeCoercion` is
   * converted as many times by the call as by it
   */
  readonly node?: INode | undefined;
  /**
   * The fixtures of the functions and accessors that its first valid call
   * installs as own properties of its receiver, of an argument, or of the
   * request or the response of a `Context` given (e.g. `0.response.write` of
   * `Compression#run()`): probed as entry points of their own
   */
  readonly installed?: Readonly<Record<string, IFixture>> | undefined;
  /**
   * The fixture of the function that its first valid call returns (e.g. the
   * listener of `callback()`): probed as an entry point of its own
   */
  readonly returned?: IFixture | undefined;
  /**
   * The fixtures of the members (methods, classes and accessors) of the
   * object that its first valid call returns, by their names (e.g. `add()`
   * and `active`): probed as entry points of their own (an accessor without
   * one is read)
   */
  readonly members?: Readonly<Record<string, IFixture>> | undefined;
  /**
   * The readers of what a valid call stores (e.g. `[kRepresentation]()` of
   * the negotiator that `[kNegotiator]()` stores), by their names: called on
   * its receiver once a call has succeeded
   */
  readonly readers?:
    Readonly<Record<string, (receiver: unknown) => unknown>> | undefined;
  /**
   * Whether its baselines throw by design (e.g. `context.throw()`), or the
   * indexes of those that do: a formatted error
   */
  readonly throws?: boolean | readonly number[] | undefined;
  /**
   * Whether it does I/O (e.g. reads a file, or codes a body): its calls may
   * stay pending for `ioMs`
   */
  readonly io?: boolean | undefined;
  /**
   * The positions that no hostile value is examined at (each is accepted as
   * it is), and why
   */
  readonly untouched?: Readonly<Record<string, string>> | undefined;
  /**
   * The positions of a callback that is called later, and why a function of
   * the test that throws there is uncaught (as with Node.js)
   */
  readonly callbacks?: Readonly<Record<string, string>> | undefined;
  /**
   * Whether its receiver (a response, see `installed`) is probed in the
   * states of a response too (see `states`)
   */
  readonly states?: boolean | undefined;
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
 * of `writeHead()`, or of the name of an event, as many times as plain
 * Node.js does it (see `node`)
 */
const nodeCoercion = "a coercion of Node.js, through an override";
/**
 * A documented conversion of the constructor of `File` of Node.js, which
 * `MultipartFile` extends (README of @binden/multipart, Lifecycle): of its
 * name, `type` and `lastModified`, as many times as a plain `File` does it
 * (see `node`)
 */
const fileCoercion = "a coercion of the constructor of File of Node.js";

/**
 * A documented conversion of a check of binden of the arguments of
 * `writeHead()` (`[kValidateHead]()`, internal), which checks them as Node.js
 * does: at most as many times as plain Node.js converts them in that call
 * (see `node`)
 */
const nodeCheck = "a check of the arguments of writeHead(), as Node.js does";

/** Why a field of Node.js that binden guards examines no value */
const nodeField =
  "a field of Node.js, stored as it is, as on a plain response (Node.js reads it as it writes the head)";
/** Why a callback position examines no value */
const ignoredCallback =
  "a callback that is not a function is ignored, as by Node.js";

/** A function given as a middleware */
const middleware = (): void => {
  // Nothing
};
/** A function that returns `1` */
const one = (): number => 1;

/** The fixtures of the entry points, by their ids */
const fixtures: Record<string, IFixture> = {};

/** The receivers of the prototype members of the classes, by class id */
const receivers: Record<string, readonly IReceiver[]> = {
  "binden:BindenRequest": [
    fresh(async (env) => (await env.exchange()).request),
  ],
  "binden:BindenResponse": stated(
    async (env) => (await env.exchange()).response,
    (made) => made,
  ),
  "binden:Context": stated(
    async (env) => (await env.exchange()).context,
    (made) => Reflect.get(made as object, "response"),
  ),
};

/**
 * The exports that are instances of an exported class (and not probed: they
 * are not entry points of their own), and why
 */
const instances: Readonly<Record<string, string>> = {
  "@binden/logger:default":
    "the default logger, a Logger whose members are probed on instances of their own",
  "@binden/body:default":
    "the default parser, a BodyParser whose members are probed on instances of their own",
  "@binden/compression:default":
    "the default compression, a Compression whose members are probed on instances of their own",
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

/** The nested paths of the keys of an object given at a position */
function keysAt(
  position: number,
  object: object,
  nested: readonly string[] = [],
): (readonly (number | string)[])[] {
  return [
    ...Object.keys(object).map((key) => [position, key]),
    ...nested.map((path) => [position, ...path.split(".")]),
  ];
}

/** The same call of a method on a plain response of Node.js (see `node`) */
function plainly(name: string): INode {
  return (values, plain) => {
    const response = plain.response();
    return Reflect.apply(
      Reflect.get(response, name) as IFunction,
      response,
      values,
    );
  };
}

/** Every option of `Binden` that its requests share with `validateRequestOptions()` */
function requestOptions(): Record<string, unknown> {
  return {
    trust_proxy: false,
    encoded_slashes: false,
    allowed_hosts: ["example.com"],
    request_id: { header: "x-request-id", trust_incoming: false, echo: true },
    query: { max_keys: 10 },
  };
}
/** Their nested options */
const requestNested = [
  "allowed_hosts.0",
  "request_id.header",
  "request_id.trust_incoming",
  "request_id.echo",
  "query.max_keys",
];

/** Every option of `Binden` */
function bindenOptions(): Record<string, unknown> {
  return {
    auto_head: true,
    error_handler: noop,
    error_handler_timeout: 1000,
    timeout: 1000,
    logger: silent,
    log_error_details: false,
    routing: { case_sensitive: false, strict: false },
    access_log: { level: "info", path: "path" },
    etag: true,
    state: (): object => ({}),
    ...requestOptions(),
  };
}

/**
 * The values of the init of a header that are converted once by `String()`,
 * as README lists them (Headers), but the values of the parameters
 */
const stringInits: Readonly<Partial<Record<string, readonly string[]>>> = {
  Accept: ["type"],
  AcceptCharset: ["charset"],
  AcceptLanguage: ["language"],
  Authorization: ["credentials"],
  ContentType: ["type"],
  Cookie: ["key", "value", "domain", "path"],
};

/**
 * The `listen()` that the registration of a server for `shutdown()` installs
 * on it (on a free port of the host), whose host and backlog Node.js converts
 * (as on a plain server, which `server()` makes)
 */
function listen(make: (env: IEnv) => Promise<Server> | Server): IFixture {
  /** It returns its server, whose `listen()` is itself */
  const returns: Record<string, IFixture> = {};
  const fixture = probed(
    {
      converts: { 1: nodeCoercion, 2: nodeCoercion },
      async node(values, plain): Promise<unknown> {
        const created = await make(plain.env);
        // E.g. of a host that it does not find
        created.on("error", noop);
        return Reflect.apply(
          Reflect.get(created, "listen") as IFunction,
          created,
          values,
        );
      },
      members: returns,
    },
    () => [0, HOST],
    () => [0, HOST, noop],
  );
  returns["listen()"] = fixture;
  return fixture;
}

// The headers
const headerDate = "Thu, 01 Jan 1970 00:00:00 GMT";
for (const [name, inits, input, inputs] of [
  [
    "Accept",
    [{ type: "text/html", parameters: { level: "1" }, q_value: 0.5 }],
    "text/html",
    true,
  ],
  ["AcceptCharset", [{ charset: "utf-8", q_value: 0.5 }], "utf-8", true],
  ["AcceptEncoding", [{ encoding: "gzip", q_value: 0.5 }], "gzip", true],
  ["AcceptLanguage", [{ language: "en", q_value: 0.5 }], "en", true],
  [
    "Authorization",
    [{ type: "Basic", credentials: "YTpi" }],
    "Basic YTpi",
    false,
  ],
  ["ContentEncoding", [{ encoding: "gzip" }], "gzip", false],
  ["ContentRange", [{ start: 0, end: 1, size: 2 }], "bytes 0-1/2", false],
  [
    "ContentType",
    [
      {
        type: "multipart/form-data",
        charset: "utf-8",
        boundary: "boundary",
        parameters: { a: "b" },
      },
      // A charset of a type that has no boundary
      { type: "text/plain", charset: "utf-8", parameters: { a: "b" } },
    ],
    "text/plain; charset=utf-8",
    false,
  ],
  [
    "Cookie",
    [
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
    ],
    "a=b",
    false,
  ],
  [
    "Forwarded",
    [
      {
        for: "192.0.2.1",
        by: "192.0.2.2",
        host: "example.com",
        proto: "https",
        secret: "secret",
      },
    ],
    "for=192.0.2.1",
    true,
  ],
  ["IfModifiedSince", [{ date: new Date(0) }], headerDate, false],
  ["Range", [{ start: 0, end: 1 }], "bytes=0-1", false],
] as const) {
  /** The keys of the inits, and of their parameters (e.g. `parameters.level`) */
  const keys = new Set<string>();
  for (const init of inits) {
    for (const key of Object.keys(init)) {
      keys.add(key);
    }
    if ("parameters" in init) {
      for (const key of Object.keys(init.parameters)) {
        keys.add(`parameters.${key}`);
      }
    }
  }
  const parameters = [...keys].filter((key) => key.startsWith("parameters."));
  define(`binden:`, {
    [`new ${name}()`]: probed(
      {
        deep: [...keys].map((key) => [0, ...key.split(".")]),
        // The values that README lists (Headers), and those of the parameters
        converts: Object.fromEntries(
          [...(stringInits[name] ?? []), ...parameters].map((key) => [
            `0.${key}`,
            headerInit,
          ]),
        ),
        untouched: {
          ...(name === "Cookie"
            ? Object.fromEntries(
                ["secure", "http_only", "partitioned"].map((key) => [
                  `0.${key}`,
                  "read by Boolean() (README, Lifecycle), which runs no code of the application",
                ]),
              )
            : {}),
        },
      },
      ...inits.map((init) => (): readonly unknown[] => [structuredClone(init)]),
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
  "Authorization.isValidType()": probed(
    {
      untouched: {
        0: "a predicate of any value (whether it is a valid type): it gives `false` for anything but a string",
      },
    },
    () => ["Basic"],
  ),
  "Forwarded.parse()": probed(
    { deep: [[0, 0]] },
    () => ["for=192.0.2.1"],
    () => [["for=192.0.2.1"]],
  ),
});

/** The options of a `BindenError` (also of `context.throw()`), and their paths */
function errorOptions(): Record<string, unknown> {
  return {
    message: "message",
    expose: true,
    json: { a: 1 },
    cause: 1,
    code: "code",
    headers: { "x-a": "b", "x-b": ["c"] },
  };
}
const errorPaths: readonly (readonly (number | string)[])[] = [
  ...keysAt(1, errorOptions()),
  [1, "json", "a"],
  [1, "headers", "x-a"],
  [1, "headers", "x-b"],
  [1, "headers", "x-b", 0],
];
/** A cause is any value: it is kept as it is */
const errorUntouched = {
  "1.cause": "the cause, any value, kept as it is (as by `Error`)",
  "1.json.a": "a value of the JSON body, any value, copied as it is",
};

/**
 * The constructor of a response, given the options of Node.js (as by
 * `node:http`), which it keeps as they are
 */
const responseConstructor = probed(
  {
    deep: [[1, "highWaterMark"]],
    untouched: {
      "1.highWaterMark":
        "an option of Node.js, which Node.js keeps as it is (as for a plain response)",
    },
  },
  () => [new IncomingMessage(new Socket()), { highWaterMark: 1024 }],
);

// The errors, the middleware and the stack
define("binden:", {
  "new BindenError()": probed(
    { deep: errorPaths, untouched: errorUntouched },
    () => [404],
    () => [500, errorOptions()],
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
  "Stack#off()": probed(
    {
      untouched: {
        1: "the middleware to remove, compared by identity: any other value removes nothing",
      },
    },
    () => [middleware],
    () => ["/a", middleware],
  ),
  "new Router()": probed(
    { deep: [[0, "guarded"]] },
    () => [],
    () => [{ guarded: true }],
  ),
  "Router#guarded =": probed(
    {
      untouched: {
        0: "read by Boolean() (README, Lifecycle), which runs no code of the application",
      },
    },
    () => [true],
  ),
  // A function of the middlewares of a method
  "Router#middlewares": probed({ returned: call(() => ["GET"]) }, () => []),
  "Router#on()": call(() => ["GET", middleware, middleware]),
  "Router#off()": probed(
    {
      untouched: {
        1: "the middleware to remove, compared by identity: any other value removes nothing",
      },
    },
    () => ["GET", middleware],
  ),
  "new Binden()": probed(
    {
      deep: keysAt(0, bindenOptions(), [
        "routing.case_sensitive",
        "routing.strict",
        "access_log.level",
        "access_log.path",
        ...requestNested,
      ]),
    },
    // The instance of the prototype members: one that logs nothing
    () => [{ logger: silent }],
    () => [],
    () => [bindenOptions()],
  ),
  // A server registered for `shutdown()` (see `listen()`)
  "Binden#createServer()": probed(
    { members: { "listen()": listen((env) => env.server()) } },
    () => [{}],
  ),
  "Binden#createSecureServer()": probed(
    { members: { "listen()": listen((env) => env.server()) } },
    () => [{}],
  ),
  "Binden#serverOptions()": probed(
    {
      // The classes of the application, of its requests and responses
      members: {
        "IncomingMessage()": call(() => [new Socket()]),
        "ServerResponse()": responseConstructor,
      },
    },
    () => [],
  ),
});

/**
 * The objects that a call has returned, by what has made them (the receiver
 * of the call): e.g. the application of the listener of `callback()`
 */
const origins = new WeakMap<object, unknown>();

/** The application of the listener of `callback()` (see `origins`) */
function applicationOf(listener: unknown): {
  serverOptions(): Record<
    "IncomingMessage" | "ServerResponse",
    new (...values: unknown[]) => IncomingMessage
  >;
} {
  return origins.get(listener as object) as ReturnType<typeof applicationOf>;
}

/** The serializers of @binden/logger (its `serializers`, and of `createSerializers()`) */
const loggerSerializing: Record<string, IFixture> = {
  "err()": call(() => [new Error("An error")]),
  "error()": call(() => [new Error("An error")]),
  "request()": call(async (env) => [(await env.exchange()).request]),
  "response()": call(async (env) => [(await env.exchange()).response]),
};
/** The serializers of binden (its `serializers`, and of `createSerializers()`) */
const serializing: Record<string, IFixture> = {
  ...loggerSerializing,
  "body()": probed(
    { untouched: { 0: "redacts any body: it never reads it" } },
    () => ["body"],
  ),
  "context()": call(async (env) => [(await env.exchange()).context]),
};
/** The fixtures of the members of `serializers` */
function serializersOf(
  defined: Record<string, IFixture>,
): Record<string, IFixture> {
  return Object.fromEntries(
    Object.entries(defined).map(([name, fixture]) => [
      `serializers.${name}`,
      fixture,
    ]),
  );
}

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
define("binden:", {
  // Its listener of the requests of the server (given a request and a
  // response of the classes of the application, so that it handles them),
  // and the `listen()` of the server that it registers for `shutdown()`
  "Binden#callback()": probed(
    {
      installed: { "0.listen": listen((env) => env.server()) },
      returned: call((_, listener) => {
        const { IncomingMessage: Request, ServerResponse: Response } =
          applicationOf(listener).serverOptions();
        const request = new Request(new Socket());
        request.method = "GET";
        request.url = "/";
        return [request, new Response(request)];
      }),
    },
    (env) => [env.server()],
  ),
});

// The functions of binden
define("binden:", {
  "createSerializers()": probed(
    { deep: [[0, "error_details"]], members: serializing },
    () => [{ error_details: true }],
  ),
  "described()": probed(
    {
      untouched: {
        0: "describes any value, without running code of the application",
      },
    },
    () => ["a"],
  ),
  "formatStack()": call(() => [new Error("An error")]),
  "formatting()": call(() => [one]),
  "framingLength()": call(() => ["1"]),
  "isClosing()": probed(
    {
      untouched: {
        0: "a predicate of any value (whether it is a server that shuts down)",
      },
    },
    (env) => [env.server()],
  ),
  "shutdown()": probed(
    {
      io: true,
      // Of a server that has shut down
      installed: { "0.listen": listen((env) => env.server()) },
      deep: [
        [1, "timeout"],
        [1, "cleanup_timeout"],
      ],
    },
    async (env) => [
      await env.listening(),
      { timeout: 50, cleanup_timeout: 50 },
    ],
  ),
  "validateRequestOptions()": probed(
    { deep: keysAt(0, requestOptions(), requestNested) },
    () => [requestOptions()],
  ),
  "validateResponseOptions()": probed({ deep: [[0, "etag"]] }, () => [
    { etag: true },
  ]),
  ...serializersOf(serializing),
});

// The request, the response and the context
define("binden:", {
  "new BindenRequest()": call(() => [new Socket()]),
  "BindenRequest#accepts()": call(() => ["text/html", "application/json"]),
  "BindenRequest#acceptsCharsets()": call(() => ["utf-8", "latin1"]),
  "BindenRequest#acceptsEncodings()": call(() => ["gzip", "br"]),
  "BindenRequest#acceptsLanguages()": call(() => ["en", "fr"]),
  "BindenRequest#body =": probed(
    {
      untouched: {
        0: "the body, any value (e.g. of a parser), kept as it is",
      },
    },
    () => [{ a: 1 }],
  ),
  "BindenRequest#header()": call(() => ["accept"]),
  "new BindenResponse()": responseConstructor,
});

const Cookie = binden.Cookie as new (init: object) => object;
/** The members of the cookies of a response (a `Set` of `Cookie`) */
const cookieMembers: Record<string, IFixture> = {
  "delete()": probed(
    {
      untouched: {
        0: "the cookie to delete, compared by identity (a `Set`): any other value deletes nothing",
      },
    },
    () => [new Cookie({ key: "a", value: "b" })],
  ),
  "clear()": call(() => []),
};
// It returns the cookies
cookieMembers["add()"] = probed({ members: cookieMembers }, () => [
  new Cookie({ key: "a", value: "b" }),
]);
const cookies = probed({ members: cookieMembers }, () => []);

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
      untouched: Object.fromEntries(
        ["1.secure", "1.partitioned"].map((key) => [
          key,
          "read by Boolean() (README, Lifecycle), which runs no code of the application",
        ]),
      ),
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
    {
      converts: { 0: nodeCoercion, 1: nodeCoercion },
      node: plainly("setHeader"),
    },
    () => ["x-a", "b"],
  ),
  "send()": probed(
    { io: true },
    () => [],
    () => ["text"],
  ),
  "json()": probed(
    {
      io: true,
      deep: [
        [0, "a"],
        [0, "b", 0],
      ],
    },
    () => [{ a: 1, b: [1] }],
    () => [{ a: 1, b: [1] }, (data: unknown): string => JSON.stringify(data)],
  ),
  "text()": probed({ io: true }, () => ["text"]),
  "html()": probed({ io: true }, () => ["<p>"]),
  "form()": probed({ io: true }, () => [new URLSearchParams("a=b")]),
  "redirect()": probed(
    { io: true, deep: [[2, "allow_external"]] },
    () => ["/a"],
    () => ["/a", 302, { allow_external: false }],
  ),
  "sendFile()": probed(
    {
      io: true,
      deep: [
        "root",
        "dotfiles",
        "etag",
        "validator",
        "last_modified",
        "cache_control",
        "max_age",
        "immutable",
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
    () => [
      "public-surface.ts",
      {
        root: import.meta.dirname,
        etag: false,
        validator: '"tag"',
        max_age: 60,
        immutable: true,
      },
    ],
  ),
};

/** Why an argument of the logger of a context examines no value */
const logged =
  "given as it is to the logger of the application: a call of the logger of a context never fails (README, Context)";
/** The methods of the logger of a context (whose calls never fail) */
const contextLogger: Record<string, IFixture> = Object.fromEntries(
  ["fatal", "error", "warn", "info", "debug", "trace"].map((level) => [
    `${level}()`,
    probed({ untouched: { 0: logged, 1: logged } }, () => [
      "message",
      { a: 1 },
    ]),
  ]),
);
// A child is a logger of the same kind
contextLogger["child()"] = probed(
  { members: contextLogger, untouched: { 0: logged } },
  () => [{ a: 1 }],
);

define("binden:Context#", {
  ...replies,
  "done =": probed(
    {
      untouched: {
        0: "read by Boolean() (README, Lifecycle), which runs no code of the application",
      },
    },
    () => [true],
  ),
  "setTimeout()": call(() => [1000]),
  "onCleanup()": call(() => [noop]),
  "throw()": probed(
    { throws: true, deep: errorPaths, untouched: errorUntouched },
    () => [418],
    () => [418, errorOptions()],
  ),
  log: probed({ members: contextLogger }, () => []),
});
define("binden:", {
  "new Context()": probed(
    {
      deep: ["request", "response", "logger", "state", "report"].map((key) => [
        0,
        key,
      ]),
      untouched: {
        "0.state": "the state of the application, any value, kept as it is",
      },
    },
    async (env) => {
      const { request, response } = await env.exchange();
      return [{ request, response, logger: silent, state: {}, report: noop }];
    },
  ),
});

/**
 * A fixture of a listener method (whose event name Node.js converts, as for
 * the method of a plain response)
 */
function listening(name: string): IFixture {
  return probed({ converts: { 0: nodeCoercion }, node: plainly(name) }, () => [
    "custom",
    noop,
  ]);
}
/** The callbacks of `write()` and `end()` (by position) */
const written = {
  1: "the callback, which Node.js calls as it is",
  2: "the callback, which Node.js calls as it is",
};

/** The same calls of `writeHead()` (also of an installed one, see `installed`) */
const heads: readonly ICall[] = [
  (): readonly unknown[] => [200],
  (): readonly unknown[] => [200, "OK", { "x-a": "b" }],
  (): readonly unknown[] => [200, { "x-a": "b" }],
  (): readonly unknown[] => [200, ["x-a", "b"]],
];
/** Why the reason of a cancellation examines no value */
const cancelled =
  "the reason of the cancellation, any value, which the sends reject with as it is";
/** Whether Node.js has `writeInformation()` (from 24.18.0) */
const writeInformation =
  typeof Reflect.get(ServerResponse.prototype, "writeInformation") ===
  "function";
/** What Node.js does with a reason of `writeHead()` that is not a string */
const reasonUntouched =
  "a reason that is not a string is taken as the headers, as Node.js does, which ignores headers that are not an object";

define("binden:BindenResponse#", {
  ...replies,
  cookies,
  "set()": probed(
    {
      deep: [
        [0, "x-a"],
        [0, "x-b"],
        [0, "x-b", 0],
      ],
      // Set by `setHeader()` of Node.js
      converts: {
        "0.x-a": nodeCoercion,
        "0.x-b": nodeCoercion,
        "0.x-b.0": nodeCoercion,
      },
      node([headers], plain): void {
        const response = plain.response();
        for (const [name, value] of Object.entries(headers as object)) {
          response.setHeader(name, value as string);
        }
      },
    },
    () => [{ "x-a": "b", "x-b": ["c", "d"] }],
  ),
  "send()": probed(
    { io: true },
    () => [],
    () => ["text"],
    () => ["74657874", "hex"],
  ),
  "writeHead()": probed(
    {
      deep: [
        [1, "x-a"],
        [2, "x-a"],
        [1, 0],
        [1, 1],
      ],
      converts: {
        0: nodeCoercion,
        "1.x-a": nodeCoercion,
        "2.x-a": nodeCoercion,
        "1.0": nodeCoercion,
        1.1: nodeCoercion,
      },
      node: plainly("writeHead"),
      untouched: { 1: reasonUntouched },
    },
    ...heads,
  ),
  "writeHeader()": probed(
    {
      deep: [
        [1, "x-a"],
        [2, "x-a"],
      ],
      converts: {
        0: nodeCoercion,
        "1.x-a": nodeCoercion,
        "2.x-a": nodeCoercion,
      },
      // An alias of `writeHead()` (which Node.js 26 no longer has)
      node: plainly("writeHead"),
      untouched: { 1: reasonUntouched },
    },
    ...heads.slice(0, 3),
  ),
  "write()": probed(
    { callbacks: written, untouched: { 2: ignoredCallback } },
    () => ["text"],
    () => ["text", noop],
    () => ["74657874", "hex", noop],
  ),
  "end()": probed(
    {
      callbacks: {
        0: "the callback, which Node.js calls as it is",
        ...written,
      },
      untouched: { 2: ignoredCallback },
    },
    () => [],
    () => [noop],
    () => ["text", noop],
    () => ["74657874", "hex", noop],
  ),
  "flushHeaders()": call(() => []),
  "getHeader()": call(() => ["x-a"]),
  "getHeaders()": call(() => []),
  "appendHeader()": probed(
    {
      converts: { 0: nodeCoercion, 1: nodeCoercion },
      node: plainly("appendHeader"),
    },
    () => ["x-a", "b"],
    () => ["x-a", ["b", "c"]],
  ),
  "setHeaders()": call(
    () => [new Headers({ "x-a": "b" })],
    () => [new Map([["x-a", "b"]])],
  ),
  "setTimeout()": call(() => [1000, noop]),
  "removeHeader()": call(() => ["x-a"]),
  "addTrailers()": probed(
    {
      deep: [
        [0, "x-a"],
        [0, 0, 0],
        [0, 0, 1],
      ],
      converts: {
        "0.x-a": nodeCoercion,
        "0.0.0": nodeCoercion,
        "0.0.1": nodeCoercion,
      },
      node: plainly("addTrailers"),
    },
    () => [{ "x-a": "b" }],
    () => [[["x-a", "b"]]],
  ),
  "destroy()": call(
    () => [],
    () => [new Error("An error")],
  ),
  "writeContinue()": probed(
    {
      callbacks: { 0: "the callback, which Node.js calls as it is" },
      untouched: { 0: ignoredCallback },
    },
    () => [noop],
  ),
  "writeProcessing()": probed(
    {
      callbacks: { 0: "the callback, which Node.js calls as it is" },
      untouched: { 0: ignoredCallback },
    },
    () => [noop],
  ),
  "writeEarlyHints()": probed(
    {
      deep: [[0, "link"]],
      callbacks: { 1: "the callback, which Node.js calls as it is" },
      untouched: { 1: ignoredCallback },
    },
    () => [{ link: "</a>; rel=preload" }, noop],
  ),
  // Of Node.js from 24.18.0: binden refuses it before (both overloads), and
  // sends the one without headers as `(102, null, callback)`
  "writeInformation()": probed(
    writeInformation
      ? {
          callbacks: {
            1: "the callback, which Node.js calls as it is",
            2: "the callback, which Node.js calls as it is",
          },
          untouched: { 2: ignoredCallback },
        }
      : {
          throws: true,
          untouched: Object.fromEntries(
            ["0", "1", "2"].map((position) => [
              position,
              "binden refuses it on a Node.js without it, before reading its arguments",
            ]),
          ),
        },
    () => [103, { link: "</a>; rel=preload" }, noop],
    () => [102, noop],
  ),
  "flush()": call(() => []),
  "statusCode =": probed({ untouched: { 0: nodeField } }, () => [201]),
  "statusMessage =": probed({ untouched: { 0: nodeField } }, () => ["Created"]),
  "chunkedEncoding =": probed({ untouched: { 0: nodeField } }, () => [false]),
  "maxRequestsOnConnectionReached =": probed(
    { untouched: { 0: nodeField } },
    () => [false],
  ),
  "sendDate =": probed({ untouched: { 0: nodeField } }, () => [true]),
  "shouldKeepAlive =": probed({ untouched: { 0: nodeField } }, () => [false]),
  "strictContentLength =": probed({ untouched: { 0: nodeField } }, () => [
    false,
  ]),
  "useChunkedEncodingByDefault =": probed(
    { untouched: { 0: nodeField } },
    () => [true],
  ),
  "addListener()": listening("addListener"),
  "on()": listening("on"),
  "once()": listening("once"),
  "prependListener()": listening("prependListener"),
  "prependOnceListener()": listening("prependOnceListener"),
  "rawListeners()": probed(
    { converts: { 0: nodeCoercion }, node: plainly("rawListeners") },
    () => ["custom"],
  ),
  "emit()": probed(
    {
      converts: { 0: nodeCoercion },
      node: plainly("emit"),
      untouched: { 1: "an argument of the listeners, given as it is" },
    },
    () => ["custom", 1],
  ),
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
  "[binden.validate_head]()": probed(
    {
      deep: [[2, "x-a"]],
      converts: { 0: nodeCheck, "2.x-a": nodeCheck },
      node: plainly("writeHead"),
      untouched: { 1: reasonUntouched },
    },
    () => [200, "OK", { "x-a": "b" }],
  ),
  "[binden.seal]()": probed(
    {
      untouched: {
        0: "a check, called (guarded) as the response is mutated: one that is not a function (or that throws) refuses every mutation",
      },
    },
    () => [(): boolean => true],
  ),
  "[binden.ownership]()": probed(
    {
      untouched: {
        0: "the handlers of the framework, kept as they are, and called (guarded) as it replies",
      },
    },
    () => [
      {
        fail: (): boolean => false,
        guards: (): boolean => false,
        replier: (): null => null,
        native: (): boolean => false,
        debug: noop,
        warn: noop,
        note: noop,
      },
    ],
  ),
  "[binden.revoke]()": call(() => [[{}], null]),
  "[binden.pipe_failure]()": probed(
    {
      untouched: Object.fromEntries(
        ["0", "1", "2"].map((position) => [
          position,
          "a failure of a pipe that the framework reports (its source, its error and its emitter), kept as it is",
        ]),
      ),
    },
    () => [{}, new Error("An error"), new EventEmitter()],
  ),
  // Returns what removes the observer
  "[binden.listen]()": probed(
    {
      deep: [[2, "once"]],
      returned: call(() => []),
      callbacks: { 1: "the observer, called as it is" },
      untouched: {
        0: "the event, compared by identity with those that the framework observes",
        "2.once": "read by Boolean(), which runs no code of the application",
      },
    },
    () => ["close", noop, { once: true }],
  ),
  "[binden.unlisten]()": probed(
    {
      untouched: {
        0: "the event, compared by identity: any other value removes nothing",
        1: "the observer, compared by identity: any other value removes nothing",
      },
    },
    () => ["close", noop],
  ),
  "[binden.cancel]()": probed({ untouched: { 0: cancelled } }, () => [
    new Error("A reason"),
  ]),
  "[binden.cancelling]()": probed({ untouched: { 0: cancelled } }, () => [
    new Error("A reason"),
  ]),
  "[binden.framework]()": call(() => [one]),
  // An operation of the current work (with its methods)
  "[binden.operation]()": probed(
    {
      members: {
        "run()": call(() => [one]),
        "transfer()": call(() => []),
      },
    },
    () => [],
  ),
  // The negotiator is read by `[binden.representation]()`
  "[binden.negotiator]()": probed(
    {
      readers: {
        "[binden.representation]()": (receiver) =>
          Reflect.apply(
            Reflect.get(
              receiver as object,
              binden.kRepresentation as symbol,
            ) as IFunction,
            receiver,
            [10],
          ),
      },
    },
    () => [
      {
        choose: (): object => ({ coding: null, status: null }),
        forget: noop,
      },
    ],
  ),
  "[binden.representation]()": probed(
    {
      untouched: {
        0: "the length, any value, given as it is to the negotiator (`choose()`), if any",
      },
    },
    () => [10],
  ),
});

// @binden/logger
define("@binden/logger:", {
  "new Logger()": probed(
    {
      deep: [
        [0, "destination"],
        [0, "level"],
        [0, "error_details"],
        // An option of `pino`
        [0, "name"],
      ],
    },
    // At the lowest level: every method reads its arguments
    () => [
      { destination: sink, level: "trace", error_details: true, name: "name" },
    ],
  ),
  "Logger.fromPino()": call(() => [pino({ level: "trace" }, sink)]),
  "Logger.getLevel()": call(
    () => [],
    () => ["LOG_LEVEL"],
  ),
  "Logger#level =": call(() => ["debug"]),
  "Logger#isLevelEnabled()": probed(
    {
      untouched: {
        0: "a predicate of any value (whether it is a level that is enabled)",
      },
    },
    () => ["info"],
  ),
  "Logger#flush()": call(() => []),
  "Logger#child()": probed(
    { deep: [[1, "level"]] },
    () => [{ a: 1 }],
    () => [{ a: 1 }, { level: "debug" }],
  ),
  "createSerializers()": probed(
    { deep: [[0, "error_details"]], members: loggerSerializing },
    () => [{ error_details: true }],
  ),
  ...serializersOf(loggerSerializing),
});
for (const level of ["fatal", "error", "warn", "info", "debug", "trace"]) {
  fixtures[`@binden/logger:Logger#${level}()`] = call(() => [
    "message",
    { a: 1 },
  ]);
}

/** A context of a fresh exchange, as the only argument */
const context = call(async (env) => [(await env.exchange()).context]);
/**
 * The same, for a parser (that reads the body), also of a request whose body
 * is over its limits
 */
function parsing(body: IBody): IFixture {
  return probed(
    // The body over the limits is refused
    { io: true, throws: [1] },
    async (env) => [(await env.exchange()).context],
    async (env) => [(await env.exchange(body)).context],
  );
}
const ContentType = binden.ContentType as new (init: object) => object;

/** Every option of `BodyParser` */
function bodyOptions(): Record<string, unknown> {
  return {
    parse: (input: string): unknown => input,
    limit: 1000,
    encoded_limit: 2000,
    type: ["text/plain"],
    raw: false,
    strict: true,
    parameter_limit: 10,
    verify: noop,
    verify_encoded: false,
    zstd: false,
    disabled: false,
    ignore_errors: false,
  };
}

/** Every option of `Compression` */
function compressionOptions(): Record<string, unknown> {
  return {
    format: "auto",
    encodings: ["gzip", "br", "deflate", "zstd"],
    threshold: 0,
    filter: (): boolean => true,
    gzip: { level: 1 },
    deflate: { level: 1 },
    brotli: { params: {} },
    zstd: { params: {} },
    disabled: false,
    ignore_errors: false,
  };
}

/** Every option of `Multipart` (but its `storage`) */
function multipartOptions(): Record<string, unknown> {
  return {
    config: { limits: { files: 1 } },
    throw_limits: false,
    limit: 1000,
    file_filter: (): boolean => true,
    filtered: "skip",
    storage: "memory",
    disabled: false,
    ignore_errors: false,
  };
}

/** The fixture of the options of `Multipart` (also of its default export) */
const multipart = probed(
  {
    deep: keysAt(0, multipartOptions(), [
      "config.limits",
      "config.limits.files",
      "storage.dir",
      "storage.on_file",
    ]),
  },
  () => [],
  () => [multipartOptions()],
  () => [{ ...multipartOptions(), storage: { dir: tmpdir() } }],
  () => [{ ...multipartOptions(), storage: { on_file: noop } }],
);

/** A method that @binden/compression installs on a response */
function compressing(options: IFixtureOptions, ...calls: ICall[]): IFixture {
  return probed({ ...options, io: true, states: true }, ...calls);
}

// @binden/body, @binden/compression and @binden/multipart
define("@binden/body:", {
  "new BodyParser()": probed(
    { deep: keysAt(0, bodyOptions(), ["type.0"]) },
    // The instance of the prototype members: one of small limits
    () => [{ limit: 4, encoded_limit: 4 }],
    () => [],
    () => [bodyOptions()],
    () => [{ ...bodyOptions(), type: (): string => "text" }],
  ),
  "BodyParser#run()": parsing("text"),
});
define("@binden/compression:", {
  "new Compression()": probed(
    {
      deep: keysAt(0, compressionOptions(), [
        "encodings.0",
        "encodings.2",
        "encodings.3",
        "gzip.level",
        "deflate.level",
        "brotli.params",
        "zstd.params",
      ]),
    },
    // The instance of the prototype members: one that codes any body
    () => [{ threshold: 0 }],
    () => [],
    () => [compressionOptions()],
  ),
  // Installs its own methods on the response
  "Compression#run()": probed(
    {
      io: true,
      installed: {
        "0.response.writeHead": compressing(
          {
            deep: [
              [1, "x-a"],
              [2, "x-a"],
            ],
            converts: {
              0: nodeCoercion,
              "1.x-a": nodeCoercion,
              "2.x-a": nodeCoercion,
            },
            node: plainly("writeHead"),
            untouched: { 1: reasonUntouched },
          },
          ...heads.slice(0, 3),
        ),
        "0.response.write": compressing(
          { callbacks: written, untouched: { 2: ignoredCallback } },
          () => ["text"],
          () => ["text", noop],
          () => ["74657874", "hex", noop],
        ),
        "0.response.end": compressing(
          {
            callbacks: {
              0: "the callback, which Node.js calls as it is",
              ...written,
            },
            untouched: { 2: ignoredCallback },
          },
          () => [],
          () => [noop],
          () => ["text", noop],
          () => ["74657874", "hex", noop],
        ),
        "0.response.flush": compressing({}, () => []),
        "0.response.writableEnded": compressing({}, () => []),
      },
    },
    async (env) => [(await env.exchange()).context],
  ),
  "isCompressible()": call(
    () => [null],
    () => [new ContentType({ type: "text/plain" })],
  ),
  "skipCompression()": call(async (env) => [(await env.exchange()).response]),
});
define("@binden/multipart:", {
  "new Multipart()": {
    ...multipart,
    // The instance of the prototype members: one of a small file size
    calls: [
      (): readonly unknown[] => [{ config: { limits: { fileSize: 2 } } }],
      ...multipart.calls,
    ],
  },
  "Multipart#run()": parsing("multipart"),
  // The name and the options are read by the constructor of `File` of
  // Node.js, which converts its name, `type` and `lastModified`
  "new MultipartFile()": probed(
    {
      deep: [
        [2, "type"],
        [2, "truncated"],
        [2, "lastModified"],
      ],
      converts: {
        1: fileCoercion,
        "2.type": fileCoercion,
        "2.lastModified": fileCoercion,
      },
      node: (values): File =>
        new File(...(values as ConstructorParameters<typeof File>)),
    },
    () => [["a"], "a.txt"],
    () => [
      ["a"],
      "a.txt",
      { type: "text/plain", truncated: false, lastModified: 0 },
    ],
  ),
  "default()": multipart,
  "multipartInfo()": context,
});

/** A reader of what an entry point stores (see `readers`) */
type IReader = (receiver: unknown, result: unknown) => unknown;

/** An entry point of the surface */
interface IEntry {
  readonly id: string;
  readonly kind: "construct" | "get" | "method" | "set";
  /** The function: the class, the method, the getter or the setter */
  readonly fn: IFunction;
  /**
   * Its receivers, the first being the default one: none for a constructor
   * or a function of a package
   */
  readonly receivers: readonly IReceiver[] | null;
  /**
   * The readers of what it stores, by their names: the getter of a setter,
   * and the getters (and `toString()`) of what a constructor makes
   */
  readonly readers: Readonly<Record<string, IReader>>;
}

/** The name of a key, as the ids show it */
function keyName(key: PropertyKey): string {
  return typeof key === "symbol" ? `[${String(key.description)}]` : String(key);
}

/**
 * The getters (and `toString()`) of the prototypes of the packages, from a
 * prototype up to one of Node.js or of the language: the readers of the
 * instances that a constructor makes
 */
function readersOf(prototype: unknown): Record<string, IReader> {
  const found: Record<string, IReader> = {};
  let current = prototype;
  while (isObject(current) && !foreign.has(current)) {
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(current, key);
      const get: unknown = Reflect.get(descriptor ?? {}, "get");
      const value: unknown = Reflect.get(descriptor ?? {}, "value");
      const name = keyName(key);
      if (typeof get === "function" && !Object.hasOwn(found, name)) {
        found[name] = (_, result): unknown => Reflect.apply(get, result, []);
      } else if (
        key === "toString" &&
        typeof value === "function" &&
        !Object.hasOwn(found, "toString()")
      ) {
        found["toString()"] = (_, result): unknown =>
          Reflect.apply(value as IFunction, result, []);
      }
    }
    current = Object.getPrototypeOf(current);
  }
  return found;
}

/** The entry points of the members of an object (a class, a prototype…) */
function members(
  id: string,
  object: object,
  separator: string,
  receiversOf: (kind: IEntry["kind"]) => readonly IReceiver[],
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
          const get: unknown = Reflect.get(descriptor, "get");
          found.push({
            id: `${name}${suffix}`,
            kind,
            fn: fn as IFunction,
            receivers: receiversOf(kind),
            // A setter is read by its getter
            readers:
              kind === "set" && typeof get === "function"
                ? {
                    [keyName(key)]: (receiver): unknown =>
                      Reflect.apply(get, receiver, []),
                  }
                : {},
          });
        }
      }
    }
  }
  return found;
}

/**
 * The exports that are instances of an exported class (see `instances`),
 * by their ids
 */
const exportedInstances = new Set<string>();

/** Every entry point of the surface, and the ids of the classes */
function surface(): [IEntry[], Set<string>] {
  const found: IEntry[] = [];
  const classes = new Set<string>();
  for (const [name, namespace] of entries) {
    for (const key of Reflect.ownKeys(namespace)) {
      const value = namespace[key];
      const id = `${name}:${keyName(key)}`;
      if (isClass(value)) {
        classes.add(id);
        const constructor = `${name}:new ${keyName(key)}()`;
        found.push({
          id: constructor,
          kind: "construct",
          fn: value,
          receivers: null,
          readers: readersOf(value.prototype),
        });
        found.push(
          ...members(id, value, ".", () => [fresh(() => value)], [
            "length",
            "name",
            "prototype",
          ]),
        );
        // An instance of a valid call of the constructor
        const instance = (overload: number): IReceiver => ({
          name: overload === 0 ? "" : `instance ${String(overload)}`,
          state: "fresh",
          async make(env: IEnv): Promise<unknown> {
            if (!Object.hasOwn(fixtures, constructor)) {
              throw new TypeError("No instance without a constructor");
            }
            const made = fixtures[constructor].calls[overload];
            return Reflect.construct(value, await made(env, null));
          },
        });
        const overloads = Object.hasOwn(fixtures, constructor)
          ? fixtures[constructor].calls.length
          : 1;
        found.push(
          ...members(
            id,
            value.prototype as object,
            "#",
            (kind) => {
              if (Object.hasOwn(receivers, id)) {
                return receivers[id];
              }
              // A getter is read on an instance of each valid call
              return kind === "get"
                ? Array.from({ length: overloads }, (_, index) =>
                    instance(index),
                  )
                : [instance(0)];
            },
            ["constructor"],
          ),
        );
      } else if (typeof value === "function") {
        found.push({
          id: `${id}()`,
          kind: "method",
          fn: value as IFunction,
          receivers: null,
          readers: {},
        });
      } else if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
      ) {
        if (exported.has(Object.getPrototypeOf(value))) {
          exportedInstances.add(id);
        } else {
          found.push(
            ...members(id, value, ".", () => [fresh(() => value)], []),
          );
        }
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
  | { readonly kind: "returned"; readonly value: unknown }
  | IThrown;
/** A call that has thrown */
interface IThrown {
  readonly kind: "thrown";
  readonly error: unknown;
}

/** Calls a function: what it returns, or throws */
function start(
  fn: () => unknown,
): { readonly kind: "started"; readonly result: unknown } | IThrown {
  try {
    return { kind: "started", result: fn() };
  } catch (error: unknown) {
    return { kind: "thrown", error };
  }
}

/**
 * Runs a function once: what it returns, throws or settles with (bounded),
 * calling `returned` once its synchronous part has returned (or thrown)
 */
async function outcomeOf(
  fn: () => unknown,
  ms: number,
  returned: () => void = noop,
): Promise<IOutcome> {
  const started = start(fn);
  returned();
  if (started.kind === "thrown") {
    return started;
  }
  const { result } = started;
  if (!isPromise(result)) {
    return { kind: "returned", value: result };
  }
  const promise = result;
  const { promise: expired, resolve } = Promise.withResolvers<IOutcome>();
  const timeout = setTimeout(() => {
    resolve({ kind: "pending" });
  }, ms);
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

/** Calls an entry point (constructs a class) */
function called(
  entry: IEntry,
  receiver: unknown,
  values: readonly unknown[],
): unknown {
  return entry.kind === "construct"
    ? Reflect.construct(entry.fn, values)
    : Reflect.apply(entry.fn, receiver, values);
}

/** The late failures of the process (an uncaught exception or rejection) */
const late: { readonly how: string; readonly error: unknown }[] = [];
process.on("uncaughtException", (error) => {
  late.push({ how: "uncaught", error });
});
process.on("unhandledRejection", (error) => {
  late.push({ how: "unhandled rejection", error });
});

/** The value at a path of the arguments (`undefined` when there is none) */
function valueAt(
  values: readonly unknown[],
  path: readonly (number | string)[],
): unknown {
  let value: unknown = values;
  for (const key of path) {
    value = isObject(value) ? Reflect.get(value, key) : null;
  }
  return value;
}

/**
 * Replaces the value at a path of the arguments (copying what holds it) by
 * a hostile value (or places it, see `place`): `null` when the path does
 * not exist
 */
function replaced(
  values: readonly unknown[],
  path: readonly (number | string)[],
  given: IHostile | null,
): unknown[] | null {
  const copy = (
    holder: unknown,
    rest: readonly (number | string)[],
  ): unknown => {
    const [head = "", ...tail] = rest;
    const missing = Array.isArray(holder)
      ? !Number.isInteger(Number(head)) || Number(head) >= holder.length
      : typeof holder !== "object" ||
        holder === null ||
        !Object.hasOwn(holder, head);
    if (missing) {
      throw new RangeError("missing");
    }
    const object: object = Array.isArray(holder)
      ? [...(holder as unknown[])]
      : { ...(holder as object) };
    const inner: unknown = Reflect.get(object, head);
    if (tail.length > 0) {
      Reflect.set(object, head, copy(inner, tail));
    } else if (typeof given?.place === "function") {
      Object.defineProperty(object, head, given.place(inner));
    } else {
      Reflect.set(object, head, given?.value);
    }
    return object;
  };
  try {
    return copy(values, path) as unknown[];
  } catch {
    return null;
  }
}

/** Whether a path of the arguments exists */
function exists(
  values: readonly unknown[],
  path: readonly (number | string)[],
): boolean {
  return replaced(values, path, null) !== null;
}

/**
 * Copies the holders (plain objects and arrays) of the nested positions of
 * the arguments, each property a getter that counts its reads (by its path)
 */
function counted(
  values: readonly unknown[],
  paths: readonly (readonly (number | string)[])[],
  reads: Map<string, number>,
): unknown[] {
  /** The paths of the holders (e.g. `0` and `0.headers`) */
  const holders = new Set<string>();
  for (const path of paths) {
    for (let length = 1; length < path.length; length += 1) {
      holders.add(path.slice(0, length).join("."));
    }
  }
  const wrap = (value: unknown, at: string): unknown => {
    const plain =
      Array.isArray(value) ||
      (typeof value === "object" &&
        value !== null &&
        Object.getPrototypeOf(value) === Object.prototype);
    if (!holders.has(at) || !plain) {
      return value;
    }
    const copy: object = Array.isArray(value) ? [] : {};
    for (const key of Object.keys(value)) {
      const where = `${at}.${key}`;
      const inner = wrap(Reflect.get(value, key), where);
      Object.defineProperty(copy, key, {
        configurable: true,
        enumerable: true,
        get(): unknown {
          reads.set(where, (reads.get(where) ?? 0) + 1);
          return inner;
        },
      });
    }
    return copy;
  };
  return values.map((value, index) => wrap(value, String(index)));
}

/**
 * Cleans up the environment of a probe (bounded), then waits for two turns
 * of the event loop: a late failure of the probe is reported by then
 */
async function clean(env: IEnv): Promise<string[]> {
  const pending: unknown[] = [];
  for (const cleanup of env.cleanups.reverse()) {
    try {
      pending.push(cleanup());
    } catch {
      // E.g. a server that is not listening
    }
  }
  const { promise: expired, resolve } = Promise.withResolvers<boolean>();
  const timeout = setTimeout(() => {
    resolve(true);
  }, cleanMs);
  const expiredClean = await Promise.race([
    Promise.allSettled(pending).then(() => false),
    expired,
  ]);
  clearTimeout(timeout);
  await turn();
  await turn();
  return expiredClean
    ? [`its cleanup has not settled in ${String(cleanMs)} ms`]
    : [];
}

/** A finding: what an entry point has done wrong, in which probe */
interface IFinding {
  readonly entry: string;
  /** `baseline`, or the position and the hostile value (e.g. `0.key null`) */
  readonly probe: string;
  readonly what: string;
}

/**
 * What a thrown (or rejected) value shows: an `Error` must be formatted (a
 * baseline must throw an `Error`), and a hostile value whose trap has
 * thrown must get the error of the test
 */
function judged(
  how: string,
  error: unknown,
  given: IHostile | null,
  unexpected: boolean,
  baseline: boolean,
): string[] {
  const isError = !isProxy(error) && isNativeError(error);
  const isFormatted = isError && formatted.has(error);
  const own = !isProxy(error) && error instanceof OwnError;
  const found: string[] = [];
  if (unexpected) {
    found.push(`${how} ${describe(error)}`);
  } else if (!isFormatted && (isError || baseline)) {
    found.push(`${how} UNFORMATTED ${describe(error)}`);
  }
  if (given !== null) {
    if (own && !given.thrown.includes(error)) {
      found.push(`${how} another error of the test`);
    } else if (given.thrown.length > 0 && !own) {
      found.push(`${how} ${describe(error)}, not the error of the test`);
    }
  }
  return found;
}

/** Evaluates what a probe has done (see `probe()`) */
function evaluate(
  fixture: IFixture,
  must: boolean,
  may: boolean,
  path: readonly (number | string)[] | null,
  given: IHostile | null,
  outcome: IOutcome,
  ms: number,
): string[] {
  switch (outcome.kind) {
    case "pending":
      return [`still pending after ${String(ms)} ms`];
    case "returned":
    case "resolved":
      if (path === null && must) {
        return ["does not throw"];
      }
      if (
        path === null &&
        outcome.kind === "returned" &&
        typeof outcome.value === "function" &&
        !isClass(outcome.value) &&
        typeof fixture.returned === "undefined"
      ) {
        return ["returns a function that has no fixture (`returned`)"];
      }
      return [];
    case "thrown":
    case "rejected":
    default:
      return judged(
        outcome.kind === "thrown" ? "throws" : "rejects with",
        outcome.error,
        given,
        path === null && !may,
        path === null,
      );
  }
}

/**
 * The positions whose hostile value has been converted (as `<entry>
 * <position>`): each documented conversion (see `converts`) must be one, so
 * that the list names only conversions that happen
 */
const converting = new Set<string>();
/**
 * The callback positions (see `callbacks`, as `<entry> <position>`) where a
 * function of the test has been called later
 */
const calledBack = new Set<string>();

const Context = binden.Context as IFunction;

/** The own keys of the functions and the accessors of an object */
function functionKeys(object: object): ReadonlySet<PropertyKey> {
  return new Set(
    Reflect.ownKeys(object).filter((key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(
        object,
        key,
      ) as PropertyDescriptor;
      return (
        typeof descriptor.value === "function" ||
        typeof descriptor.get === "function" ||
        typeof descriptor.set === "function"
      );
    }),
  );
}

/**
 * The objects that a call may install functions on, by their names: its
 * receiver (`this`), each argument (by its index), and the request and the
 * response of a `Context` given (e.g. `0.response`), each with the own keys
 * of its functions and accessors
 */
function owned(
  receiver: unknown,
  values: readonly unknown[],
): Map<string, readonly [object, ReadonlySet<PropertyKey>]> {
  const found = new Map<string, readonly [object, ReadonlySet<PropertyKey>]>();
  const add = (name: string, value: unknown): void => {
    if (typeof value === "object" && value !== null && !isProxy(value)) {
      found.set(name, [value, functionKeys(value)]);
    }
  };
  add("this", receiver);
  for (const [index, value] of values.entries()) {
    add(String(index), value);
    if (!isProxy(value) && value instanceof Context) {
      add(`${String(index)}.request`, Reflect.get(value, "request"));
      add(`${String(index)}.response`, Reflect.get(value, "response"));
    }
  }
  return found;
}

/**
 * The functions and accessors installed since `owned()` (e.g.
 * `0.response.write`)
 */
function installedSince(
  before: ReadonlyMap<string, readonly [object, ReadonlySet<PropertyKey>]>,
): string[] {
  return [...before].flatMap(([name, [object, keys]]) =>
    [...functionKeys(object)]
      .filter((key) => !keys.has(key))
      .map((key) => `${name}.${keyName(key)}`),
  );
}

/** A member of an object: its kind, its key, and whether it is a class */
type IMember = readonly [IEntry["kind"], PropertyKey, boolean];

/**
 * The members (functions and accessors) of an object of a package that a
 * call returns, by their names (e.g. `add()` or `active`): its own ones, and
 * those of its prototypes up to one of Node.js or of the language (none for
 * an instance of an exported class, whose members are probed, nor for an
 * array)
 */
function membersOf(value: unknown): Map<string, IMember> {
  const found = new Map<string, IMember>();
  if (
    typeof value !== "object" ||
    value === null ||
    isProxy(value) ||
    Array.isArray(value) ||
    isNativeError(value)
  ) {
    return found;
  }
  const chain: object[] = [value];
  let prototype: unknown = Object.getPrototypeOf(value);
  while (!foreign.has(prototype)) {
    if (exported.has(prototype)) {
      return new Map();
    }
    chain.push(prototype as object);
    prototype = Object.getPrototypeOf(prototype);
  }
  /** The own keys of a plain instance of the same class of Node.js */
  let plain: ReadonlySet<PropertyKey> = new Set();
  if (
    chain.length === 1 &&
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    if (!(value instanceof NetServer)) {
      // An instance of Node.js (or of the language), whose members are its own
      return found;
    }
    // A server (e.g. of `createServer()`): what binden installs on it
    plain = new Set(
      Reflect.ownKeys(
        Reflect.construct(value.constructor as IFunction, []) as object,
      ),
    );
  }
  for (const holder of chain) {
    for (const key of Reflect.ownKeys(holder).filter(
      (own) => !plain.has(own),
    )) {
      const descriptor = Reflect.getOwnPropertyDescriptor(
        holder,
        key,
      ) as PropertyDescriptor;
      for (const [field, kind, suffix] of [
        ["get", "get", ""],
        ["set", "set", " ="],
        ["value", "method", "()"],
      ] as const) {
        const fn: unknown = Reflect.get(descriptor, field);
        const name = `${keyName(key)}${suffix}`;
        if (
          typeof fn === "function" &&
          (holder === value || key !== "constructor") &&
          !found.has(name)
        ) {
          found.set(name, [kind, key, field === "value" && isClass(fn)]);
        }
      }
    }
  }
  return found;
}

/** What a probe has found, and whether its hostile value was examined */
interface IProbed {
  readonly findings: IFinding[];
  readonly examined: boolean;
  /** The kind of the error that it throws (or rejects with), if any */
  readonly failure: string | null;
}

/** The kind of an error (its class), without running code of the application */
function kindOf(error: unknown): string {
  return !isProxy(error) && isNativeError(error)
    ? error.constructor.name
    : `(${typeof error})`;
}

/** Whether a late failure is the call of a function of the test (see `callbacks`) */
function calledOut(error: unknown, given: IHostile): boolean {
  return (
    (!isProxy(error) &&
      error instanceof OwnError &&
      given.thrown.includes(error)) ||
    (!isProxy(error) &&
      isNativeError(error) &&
      error.name === "TypeError" &&
      /^(?:Cannot perform 'apply' on a proxy that has been revoked|Class constructor \w+ cannot be invoked without 'new')$/u.test(
        error.message,
      ))
  );
}

/** Runs a probe on a fresh environment, and cleans it up */
async function probe(
  entry: IEntry,
  fixture: IFixture,
  receiving: IReceiver | null,
  index: number,
  path: readonly (number | string)[] | null,
  name: IHostileName | null,
  expected: string | null = null,
): Promise<IProbed> {
  const env = environment();
  const isDefault = receiving === null || receiving.name === "";
  const state = receiving?.state ?? "fresh";
  const position = path?.join(".") ?? "";
  const at = `${isDefault ? "" : `${receiving.name}: `}${
    path === null ? "baseline" : `${position} ${name ?? ""}`
  }`;
  const found: string[] = [];
  const made = fixture.calls[index];
  const { throws = false } = fixture;
  const throwing =
    typeof throws === "boolean" ? throws : throws.includes(index);
  const ms = fixture.io === true ? ioMs : pendingMs;
  let given: IHostile | null = null;
  let examined = true;
  let failure: string | null = null;
  try {
    const receiver =
      receiving === null
        ? null
        : await bounded(receiving.make(env), makeMs, "Its receiver");
    const baseline =
      entry.kind === "get"
        ? []
        : await bounded(made(env, receiver), makeMs, "Its arguments");
    given =
      path === null || name === null
        ? null
        : hostile(name, valueAt(baseline, path));
    const values = path === null ? baseline : replaced(baseline, path, given);
    if (values === null) {
      found.push("the position does not exist");
    } else {
      const before = path === null ? owned(receiver, values) : null;
      const outcome = await outcomeOf(
        () => called(entry, receiver, values),
        ms,
        () => given?.arm?.(),
      );
      const conversions = given?.conversions() ?? 0;
      failure =
        outcome.kind === "thrown" || outcome.kind === "rejected"
          ? kindOf(outcome.error)
          : null;
      if (before !== null && isDefault) {
        for (const installed of installedSince(before)) {
          if (!Object.hasOwn(fixture.installed ?? {}, installed)) {
            found.push(
              `installs ${installed}, which has no fixture (\`installed\`)`,
            );
          }
        }
      }
      if (path === null && isDefault && outcome.kind === "returned") {
        for (const [member, [kind]] of membersOf(outcome.value)) {
          if (kind !== "get" && !Object.hasOwn(fixture.members ?? {}, member)) {
            found.push(
              `returns an object whose ${member} has no fixture (\`members\`)`,
            );
          }
        }
      }
      found.push(
        ...evaluate(
          fixture,
          throwing && isDefault,
          throwing || !isDefault,
          path,
          given,
          outcome,
          ms,
        ),
      );
      if (outcome.kind === "returned" || outcome.kind === "resolved") {
        const result = outcome.kind === "returned" ? outcome.value : null;
        const readers: Record<string, IReader> = { ...entry.readers };
        for (const [reader, read] of Object.entries(fixture.readers ?? {})) {
          readers[reader] = (target): unknown => read(target);
        }
        for (const [reader, read] of Object.entries(readers)) {
          const readOutcome = await outcomeOf(() => read(receiver, result), ms);
          if (readOutcome.kind === "pending") {
            found.push(
              `its reader ${reader} is still pending after ${String(ms)} ms`,
            );
          } else if (
            readOutcome.kind === "thrown" ||
            readOutcome.kind === "rejected"
          ) {
            found.push(
              ...judged(
                `its reader ${reader} ${readOutcome.kind === "thrown" ? "throws" : "rejects with"}`,
                readOutcome.error,
                given,
                false,
                false,
              ),
            );
          }
        }
      }
      if (given !== null) {
        const total = given.conversions();
        const allowed = fixture.converts?.[position];
        const succeeded =
          outcome.kind === "returned" || outcome.kind === "resolved";
        // A call that throws by design examines a value that makes it
        // throw something else
        examined =
          (!succeeded && failure !== expected) ||
          total > 0 ||
          given.thrown.length > 0;
        if (total > 0) {
          converting.add(`${entry.id} ${position}`);
        }
        if (typeof allowed === "undefined") {
          if (total > 0) {
            found.push(
              `converted ${String(total)}x${succeeded ? "" : ` before it ${outcome.kind === "thrown" ? "throws" : "rejects"}`}`,
            );
          }
        } else {
          if (total > conversions) {
            found.push(
              `converted ${String(total - conversions)}x by its readers`,
            );
          }
          if (allowed === headerInit && conversions > 1) {
            found.push(`converted ${String(conversions)}x, documented once`);
          } else if (
            allowed === headerInit &&
            name === "counting" &&
            isDefault &&
            succeeded &&
            conversions === 0
          ) {
            found.push("not converted, documented once");
          }
          if (
            name === "counting" &&
            (allowed === nodeCoercion ||
              allowed === fileCoercion ||
              allowed === nodeCheck)
          ) {
            if (typeof fixture.node === "undefined") {
              found.push(
                "a coercion of Node.js without the same call on plain Node.js (`node`)",
              );
            } else {
              const reference = hostile("counting", null);
              const again = replaced(
                await bounded(made(env, receiver), makeMs, "Its arguments"),
                path as readonly (number | string)[],
                reference,
              );
              const { node } = fixture;
              await outcomeOf(
                () =>
                  node(again ?? [], {
                    env,
                    response: () => plainResponse(state),
                  }),
                ms,
              );
              const byNode = reference.conversions();
              if (
                allowed === nodeCheck
                  ? conversions > byNode
                  : conversions !== byNode
              ) {
                found.push(
                  `converted ${String(conversions)}x, plain Node.js ${String(byNode)}x${allowed === nodeCheck ? " (at most)" : ""}`,
                );
              }
            }
          }
        }
      }
    }
  } catch (error: unknown) {
    found.push(`the fixture fails: ${describe(error)}`);
  } finally {
    found.push(...(await clean(env)));
    const callback =
      given !== null && Object.hasOwn(fixture.callbacks ?? {}, position);
    for (const { how, error } of late.splice(0)) {
      if (callback && given !== null && calledOut(error, given)) {
        calledBack.add(`${entry.id} ${position}`);
      } else {
        found.push(`${how} ${describe(error)}`);
      }
    }
  }
  return {
    findings: found.map((what) => ({ entry: entry.id, probe: at, what })),
    examined,
    failure,
  };
}

/** The positions of a baseline that are probed: each argument, and `deep` */
function positions(
  fixture: IFixture,
  baseline: readonly unknown[],
): (readonly (number | string)[])[] {
  return [
    ...baseline.map((_, index) => [index]),
    ...(fixture.deep ?? []).filter((path) => exists(baseline, path)),
  ];
}

/**
 * Runs the first valid call of an entry point (on its default receiver):
 * its receiver, its arguments and what it returns
 */
async function first(
  entry: IEntry,
  fixture: IFixture,
  env: IEnv,
): Promise<{
  readonly receiver: unknown;
  readonly values: readonly unknown[];
  readonly result: unknown;
}> {
  const [made] = fixture.calls;
  const receiving = entry.receivers?.[0] ?? null;
  const receiver =
    receiving === null
      ? null
      : await bounded(receiving.make(env), makeMs, "Its receiver");
  const values =
    entry.kind === "get" || typeof made === "undefined"
      ? []
      : await bounded(made(env, receiver), makeMs, "Its arguments");
  const result = called(entry, receiver, values);
  if (result instanceof NetServer) {
    env.cleanups.push(() => result.close());
  }
  return { receiver, values, result };
}

/**
 * Checks that each option, init and argument of the nested positions of a
 * valid call is read at most once (see `counted()`), by the call and the
 * readers of what it stores
 */
async function readOnce(
  entry: IEntry,
  fixture: IFixture,
  receiving: IReceiver | null,
  index: number,
): Promise<IFinding[]> {
  const env = environment();
  const found: string[] = [];
  const made = fixture.calls[index];
  const ms = fixture.io === true ? ioMs : pendingMs;
  try {
    const receiver =
      receiving === null
        ? null
        : await bounded(receiving.make(env), makeMs, "Its receiver");
    const reads = new Map<string, number>();
    const values = counted(
      await bounded(made(env, receiver), makeMs, "Its arguments"),
      fixture.deep ?? [],
      reads,
    );
    const outcome = await outcomeOf(() => called(entry, receiver, values), ms);
    if (outcome.kind === "returned" || outcome.kind === "resolved") {
      const result = outcome.kind === "returned" ? outcome.value : null;
      for (const read of Object.values(entry.readers)) {
        await outcomeOf(() => read(receiver, result), ms);
      }
      for (const read of Object.values(fixture.readers ?? {})) {
        await outcomeOf(() => read(receiver), ms);
      }
    }
    for (const [key, count] of reads) {
      if (count > 1) {
        found.push(`reads ${key} ${String(count)}x`);
      }
    }
  } catch (error: unknown) {
    found.push(`the fixture fails: ${describe(error)}`);
  } finally {
    found.push(...(await clean(env)));
    for (const { how, error } of late.splice(0)) {
      found.push(`${how} ${describe(error)}`);
    }
  }
  return found.map((what) => ({
    entry: entry.id,
    probe: `reads (call ${String(index)})`,
    what,
  }));
}

// A relative path (of `sendFile()`) is of this directory, also without the
// `root` of its options (e.g. once a probe has replaced them)
const cwd = process.cwd();
process.chdir(import.meta.dirname);
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
for (const id of exportedInstances) {
  if (!Object.hasOwn(instances, id)) {
    findings.push({
      entry: id,
      probe: "-",
      what: "an instance of an exported class that is not probed, without a reason (`instances`)",
    });
  }
}
for (const id of Object.keys(instances)) {
  if (!exportedInstances.has(id)) {
    findings.push({ entry: id, probe: "-", what: "names no instance" });
  }
}

/**
 * The function that the first valid call of an entry point returns, as an
 * entry point of its own (see `returned`): called by a function of the test
 * on the function that a fresh call has returned (whose origin is the
 * receiver of that call, see `origins`)
 */
function returnedBy(entry: IEntry, fixture: IFixture): IEntry {
  return {
    id: `${entry.id}=>()`,
    kind: "method",
    fn(this: unknown, ...values: unknown[]): unknown {
      return Reflect.apply(this as IFunction, null, values);
    },
    receivers: [
      fresh(async (env) => {
        const { receiver, result } = await first(entry, fixture, env);
        if (isObject(result)) {
          origins.set(result, receiver);
        }
        return result;
      }),
    ],
    readers: {},
  };
}

/**
 * A function or an accessor that the first valid call of an entry point
 * installs (see `installed`, e.g. `0.response.write`), as an entry point of
 * its own: called (or read) by a function of the test on the object that a
 * fresh call has installed it on, once that call has settled (also once the
 * response that it is installed on is in a state, see `states`)
 */
async function installedBy(
  entry: IEntry,
  fixture: IFixture,
  name: string,
  own: IFixture,
): Promise<IEntry> {
  const parts = name.split(".");
  const key = parts.at(-1) ?? "";
  const holder = async (env: IEnv): Promise<object> => {
    const { receiver, values, result } = await first(entry, fixture, env);
    if (isPromise(result)) {
      await bounded(result, ioMs, "Its first valid call");
    }
    const [head = "", ...rest] = parts.slice(0, -1);
    let object: unknown = head === "this" ? receiver : values[Number(head)];
    for (const part of rest) {
      object = Reflect.get(object as object, part);
    }
    return object as object;
  };
  const env = environment();
  const method = await holder(env)
    .then((object) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(object, key);
      if (typeof descriptor === "undefined") {
        // A fixture that names nothing
        throw new TypeError(`${name} is not installed`);
      }
      return typeof descriptor.value === "function";
    })
    .finally(async () => {
      findings.push(
        ...(await clean(env)).map((what) => ({
          entry: entry.id,
          probe: name,
          what,
        })),
      );
    });
  return {
    id: `${entry.id}=>${name}${method ? "()" : ""}`,
    kind: method ? "method" : "get",
    fn(this: object, ...values: unknown[]): unknown {
      return method
        ? Reflect.apply(Reflect.get(this, key) as IFunction, this, values)
        : Reflect.get(this, key);
    },
    receivers:
      own.states === true ? stated(holder, (made) => made) : [fresh(holder)],
    readers: {},
  };
}

/**
 * A member of the object that the first valid call of an entry point returns
 * (see `members`, e.g. `add()` of `response.cookies`), as an entry point of
 * its own: called (constructed, read or set) by a function of the test on
 * the object that a fresh call has returned
 */
function memberBy(
  entry: IEntry,
  fixture: IFixture,
  name: string,
  [kind, key, constructs]: IMember,
): IEntry {
  return {
    id: `${entry.id}=>.${name}`,
    kind,
    fn(this: object, ...values: unknown[]): unknown {
      if (kind === "get") {
        return Reflect.get(this, key);
      }
      if (kind === "set") {
        return Reflect.set(this, key, values[0]);
      }
      const member = Reflect.get(this, key) as IFunction;
      return constructs
        ? Reflect.construct(member, values)
        : Reflect.apply(member, this, values);
    },
    receivers: [
      fresh(async (env) => (await first(entry, fixture, env)).result),
    ],
    readers: {},
  };
}

/**
 * The fixtures of members that are being probed (see `members`): a fixture
 * whose members are its own (e.g. of `child()` of a logger) is probed once
 */
const probing = new Set<object>();

/**
 * Probes an entry point with its fixture (on each of its receivers), and the
 * functions that it returns or installs, and the members of what it returns
 * (see `returned`, `installed` and `members`)
 */
async function run(entry: IEntry, fixture: IFixture): Promise<void> {
  /** The positions probed, as the keys of `converts` name them */
  const covered = new Set<string>();
  /** Whether a position (`<call> <position>`) is examined by a hostile value */
  const examined = new Map<string, boolean>();
  for (const receiving of entry.receivers ?? [null]) {
    const isDefault = receiving === null || receiving.name === "";
    for (const [index, made] of fixture.calls.entries()) {
      probes += 1;
      const { findings: failures, failure } = await probe(
        entry,
        fixture,
        receiving,
        index,
        null,
        null,
      );
      findings.push(...failures);
      if ((failures.length === 0 || !isDefault) && entry.kind !== "get") {
        const env = environment();
        let baseline: readonly unknown[] | null = null;
        try {
          const receiver =
            receiving === null
              ? null
              : await bounded(receiving.make(env), makeMs, "Its receiver");
          baseline = await bounded(
            made(env, receiver),
            makeMs,
            "Its arguments",
          );
        } catch {
          // The baseline has reported it
        }
        findings.push(
          ...(await clean(env)).map((what) => ({
            entry: entry.id,
            probe: "positions",
            what,
          })),
        );
        const valid = baseline ?? [];
        for (const path of positions(fixture, valid)) {
          const position = path.join(".");
          covered.add(position);
          // A holder that is read late is of a nested position, and a use
          // after the call of an object (or a function)
          const value = valueAt(valid, path);
          for (const name of hostileNames.filter(
            (hostileName) =>
              (hostileName !== "late" || path.length > 1) &&
              (hostileName !== "late-use" || isObject(value)),
          )) {
            probes += 1;
            const outcomeOfHostile = await probe(
              entry,
              fixture,
              receiving,
              index,
              path,
              name,
              failure,
            );
            findings.push(...outcomeOfHostile.findings);
            if (isDefault && name !== "late" && name !== "late-use") {
              const key = `${String(index)} ${position}`;
              examined.set(
                key,
                (examined.get(key) ?? false) || outcomeOfHostile.examined,
              );
            }
          }
        }
        if (
          isDefault &&
          (fixture.deep ?? []).some((path) => exists(valid, path))
        ) {
          probes += 1;
          findings.push(...(await readOnce(entry, fixture, receiving, index)));
        }
      }
    }
  }
  const untouched = fixture.untouched ?? {};
  const needed = new Set<string>();
  for (const [key, was] of examined) {
    const [index = "", position = ""] = key.split(" ");
    if (!was && Object.hasOwn(untouched, position)) {
      needed.add(position);
    } else if (!was) {
      findings.push({
        entry: entry.id,
        probe: position,
        what: `no hostile value is examined there (call ${index})`,
      });
    }
  }
  for (const position of Object.keys(untouched)) {
    if (!needed.has(position)) {
      findings.push({
        entry: entry.id,
        probe: position,
        what: "listed as untouched, but a hostile value is examined there in every call",
      });
    }
  }
  for (const position of Object.keys(fixture.callbacks ?? {})) {
    if (!calledBack.has(`${entry.id} ${position}`)) {
      findings.push({
        entry: entry.id,
        probe: position,
        what: "listed as a callback, but no function given there is called later",
      });
    }
  }
  for (const position of Object.keys(fixture.converts ?? {})) {
    if (!covered.has(position)) {
      findings.push({
        entry: entry.id,
        probe: position,
        what: "a documented conversion of a position not probed",
      });
    } else if (!converting.has(`${entry.id} ${position}`)) {
      findings.push({
        entry: entry.id,
        probe: position,
        what: "a documented conversion that no probe runs",
      });
    }
  }
  if (typeof fixture.returned !== "undefined") {
    const returned = returnedBy(entry, fixture);
    ids.add(returned.id);
    await run(returned, fixture.returned);
  }
  for (const [name, own] of Object.entries(fixture.installed ?? {})) {
    let installed: IEntry | null = null;
    try {
      installed = await installedBy(entry, fixture, name, own);
    } catch (error: unknown) {
      findings.push({
        entry: entry.id,
        probe: name,
        what: `the fixture fails: ${describe(error)}`,
      });
    }
    if (installed !== null) {
      ids.add(installed.id);
      await run(installed, own);
    }
  }
  const { members: memberFixtures } = fixture;
  if (typeof memberFixtures !== "undefined" && !probing.has(memberFixtures)) {
    probing.add(memberFixtures);
    const env = environment();
    let result: unknown = null;
    try {
      ({ result } = await first(entry, fixture, env));
    } catch (error: unknown) {
      findings.push({
        entry: entry.id,
        probe: "members",
        what: `the fixture fails: ${describe(error)}`,
      });
    } finally {
      findings.push(
        ...(await clean(env)).map((what) => ({
          entry: entry.id,
          probe: "members",
          what,
        })),
      );
    }
    const found = membersOf(result);
    for (const [name, own] of Object.entries(memberFixtures)) {
      const member = found.get(name);
      if (typeof member === "undefined") {
        findings.push({
          entry: `${entry.id}=>.${name}`,
          probe: "-",
          what: "names nothing",
        });
      } else {
        const probedMember = memberBy(entry, fixture, name, member);
        ids.add(probedMember.id);
        await run(probedMember, own);
      }
    }
    // An accessor without a fixture is read
    for (const [name, member] of found) {
      if (member[0] === "get" && !Object.hasOwn(memberFixtures, name)) {
        const probedMember = memberBy(entry, fixture, name, member);
        ids.add(probedMember.id);
        await run(
          probedMember,
          call(() => []),
        );
      }
    }
    probing.delete(memberFixtures);
  }
}

for (const entry of all.filter(({ id }) => id.includes(only))) {
  if (Object.hasOwn(fixtures, entry.id)) {
    await run(entry, fixtures[entry.id]);
  } else if (entry.kind === "get") {
    // A getter takes no argument: it is read on a fresh receiver
    await run(
      entry,
      call(() => []),
    );
  } else {
    findings.push({ entry: entry.id, probe: "-", what: "no baseline" });
  }
}

process.chdir(cwd);
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
