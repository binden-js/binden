import {
  BindenAbortError,
  BindenError,
  BindenRequest,
  BindenResponse,
  Context,
} from "../index.js";
import { type ILogger, Logger } from "@binden/logger";
import {
  childLogger,
  createSerializers,
  isLogger,
  logTo,
  record,
  safe,
  serializers,
  snapshot,
} from "../src/logger.js";
import { deepStrictEqual, ok, throws } from "node:assert/strict";
import { suite, test } from "node:test";
import { Socket } from "node:net";

const secrets = [
  "secret-token",
  "secret-cookie",
  "secret-query",
  "secret-set-cookie",
  "secret-api-key",
  "secret-header",
  "secret-session",
  "secret-body",
  "secret-message",
  "secret-cause",
  "secret-json",
];

function createContext(): Context {
  const request = new BindenRequest(new Socket());
  request.method = "GET";
  request.url = "/path?token=secret-query";
  request.headers = {
    host: "localhost",
    "user-agent": "test",
    authorization: "Bearer secret-token",
    cookie: "session=secret-cookie",
    "x-api-key": "secret-api-key",
  };
  const response = new BindenResponse(request);
  response.setHeader("Set-Cookie", "session=secret-set-cookie");
  response.setHeader("X-Header", "secret-header");
  // A field that the application has set on the context
  return Object.assign(new Context({ request, response }), {
    privateSession: "secret-session",
  });
}

function assertNoSecrets(output: string): void {
  for (const secret of secrets) {
    ok(!output.includes(secret), `${secret} leaked: ${output}`);
  }
}

/** A logger whose methods record their calls */
function recorder(
  method: (message: string, extra?: Record<string, unknown>) => unknown,
): ILogger {
  const logger: ILogger = {
    fatal: method,
    error: method,
    warn: method,
    info: method,
    debug: method,
    trace: method,
    child: (): ILogger => logger,
  };
  return logger;
}

suite("serializers", () => {
  test("request and response: an allowlist of details", () => {
    const { request, response } = createContext();

    deepStrictEqual(serializers.request(request), {
      method: "GET",
      path: "/path",
    });
    deepStrictEqual(serializers.response(response), { status: 200 });
    deepStrictEqual(serializers.request("secret"), { type: "string" });
  });

  test("context: not its own fields", () => {
    const context = createContext();

    deepStrictEqual(serializers.context(context), {
      id: context.id,
      request: { method: "GET", path: "/path" },
      response: { status: 200 },
    });
    assertNoSecrets(JSON.stringify(serializers.context(context)));
    deepStrictEqual(serializers.context("secret"), { type: "string" });
  });

  test("error: the type, a known code and the status only", () => {
    const cause = new SyntaxError("secret-cause");
    const error = new BindenError(400, {
      expose: true,
      message: "secret-message",
      json: { message: "secret-json" },
      cause,
    });
    deepStrictEqual(serializers.error(error), {
      type: "BindenError",
      status: 400,
    });
    deepStrictEqual(
      serializers.error(new BindenError(503, { code: "deadline" })),
      { type: "BindenError", code: "deadline", status: 503 },
    );
    deepStrictEqual(
      serializers.error(new BindenError(400, { code: "secret-code" })),
      { type: "BindenError", status: 400 },
    );
    deepStrictEqual(
      serializers.error(
        Object.assign(new Error("secret-message"), { code: "ECONNRESET" }),
      ),
      { type: "Error", code: "ECONNRESET" },
    );
    deepStrictEqual(serializers.error(new BindenAbortError("deadline")), {
      type: "BindenAbortError",
    });
    class SECRET_CLASS extends RangeError {}
    deepStrictEqual(serializers.error(new SECRET_CLASS()), {
      type: "RangeError",
    });
    deepStrictEqual(serializers.error(null), { type: "null" });
    deepStrictEqual(serializers.error("secret"), { type: "string" });
    const thrower = (): never => {
      throw new Error("trap");
    };
    // A proxy that refuses to tell anything
    const traps = new Proxy(new Error("secret-message"), {
      get: thrower,
      getPrototypeOf: thrower,
    });
    deepStrictEqual(serializers.error(traps), { type: "object" });
  });

  test("body", () => {
    deepStrictEqual(serializers.body(), "[Redacted]");
  });

  test("framework logs do not leak credentials", () => {
    const lines: string[] = [];
    const destination = {
      write: (line: string): void => {
        lines.push(line);
      },
    };
    const log = new Logger({ serializers, destination, level: "debug" });

    log.debug("Not found", {
      context: createContext(),
      body: { password: "secret-body" },
      error: new BindenError(404, {
        message: "secret-message",
        cause: new Error("secret-cause"),
      }),
    });

    deepStrictEqual(lines.length, 1);
    assertNoSecrets(lines.join(""));
    ok(lines.join("").includes("[Redacted]"));
  });
});

suite("createSerializers()", () => {
  /** The records that a logger with the serializers writes */
  const records = (
    options: ConstructorParameters<typeof Logger>[0],
  ): Record<string, unknown>[] => {
    const lines: string[] = [];
    const log = new Logger({
      ...options,
      level: "debug",
      destination: {
        write: (line: string): void => {
          lines.push(line);
        },
      },
    });
    const error = Object.assign(new TypeError("the message"), {
      code: "E_APP",
      cause: new Error("the cause"),
    });
    log.debug("Failed", { error, body: { field: "value" } });
    return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  };

  test("the details of the errors, only with `error_details`", () => {
    const error = Object.assign(new TypeError("the message"), {
      code: "E_APP",
      status: 409,
      cause: new Error("the cause"),
    });
    const detailed = createSerializers({ error_details: true }).error(error);
    const { stack } = detailed;
    const cause = detailed.cause as Record<string, unknown>;
    deepStrictEqual(
      { ...detailed, stack: typeof stack, cause: cause.message },
      {
        type: "TypeError",
        code: "E_APP",
        status: 409,
        message: "the message",
        stack: "string",
        cause: "the cause",
      },
    );
    for (const plain of [createSerializers(), serializers]) {
      deepStrictEqual(plain.error(error), { type: "TypeError", status: 409 });
      // `err`, the key of `pino`, as well
      deepStrictEqual(plain.err(error), { type: "TypeError", status: 409 });
    }
    deepStrictEqual(
      createSerializers({ error_details: true }).err(error),
      detailed,
    );
    // The other serializers are the same
    const { body, context, request, response } = createSerializers({
      error_details: true,
    });
    deepStrictEqual(body({ password: "secret" }), "[Redacted]");
    const created = createContext();
    deepStrictEqual(context(created), serializers.context(created));
    deepStrictEqual(request(created.request), { method: "GET", path: "/path" });
    deepStrictEqual(response(created.response), { status: 200 });
  });

  test("invalid `error_details`", () => {
    for (const error_details of [1, "true", null]) {
      throws(
        () =>
          createSerializers({
            error_details: error_details as unknown as boolean,
          }),
        new TypeError("`error_details` is not a boolean"),
      );
    }
  });

  test("a logger with them logs the details of the errors", () => {
    const [detailed] = records({
      serializers: {
        ...createSerializers({ error_details: true }),
        body: (body: unknown): unknown => body,
      },
    });
    const error = detailed.error as Record<string, unknown>;
    deepStrictEqual(
      [error.type, error.message, detailed.body],
      ["TypeError", "the message", { field: "value" }],
    );
    // The serializers of binden replace the `error_details` of the logger
    const [plain] = records({ error_details: true, serializers });
    deepStrictEqual(
      [plain.error, plain.body],
      [{ type: "TypeError" }, "[Redacted]"],
    );
  });
});

suite("snapshot()", () => {
  test("an allowlist of details, with the location and the request id", () => {
    const error = Object.assign(new TypeError("secret-message"), {
      code: "ERR_SECRET",
      status: 409,
      cause: new Error("secret-cause"),
    });
    deepStrictEqual(
      snapshot(error, {
        location: "middleware",
        request_id: "id",
        details: false,
      }),
      {
        type: "TypeError",
        status: 409,
        location: "middleware",
        request_id: "id",
      },
    );
    // The status of the reply
    deepStrictEqual(
      snapshot(error, { location: "send", details: false, status: 500 }),
      { type: "TypeError", status: 500, location: "send" },
    );
    deepStrictEqual(
      snapshot(Object.assign(new Error(), { status: 99 }), {
        location: "cleanup",
        details: false,
      }),
      { type: "Error", location: "cleanup" },
    );
  });

  test("the message, the stack, the cause and any code with `details`", () => {
    const error = new Error("first", {
      cause: Object.assign(new RangeError("second"), {
        code: "E_SECOND",
        cause: new Error("third", {
          cause: new Error("fourth", { cause: "fifth" }),
        }),
      }),
    });
    const result = snapshot(error, { location: "middleware", details: true });
    const second = result.cause as Record<string, unknown>;
    const third = second.cause as Record<string, unknown>;
    const fourth = third.cause as Record<string, unknown>;
    deepStrictEqual(
      [
        result.message,
        second.message,
        second.code,
        third.message,
        fourth.message,
      ],
      ["first", "second", "E_SECOND", "third", "fourth"],
    );
    ok(typeof result.stack === "string");
    // Bounded, and without the location in a cause
    ok(!("cause" in fourth));
    ok(!("location" in second));
    // `null` is no cause
    ok(
      !(
        "cause" in
        snapshot(new Error("x", { cause: null }), {
          location: "middleware",
          details: true,
        })
      ),
    );
  });
});

suite("safe()", () => {
  test("a logger that throws, or that rejects, is ignored", async () => {
    const calls: unknown[][] = [];
    const throwing = safe(
      recorder((...args: unknown[]): never => {
        calls.push(args);
        throw new Error("A failing logger");
      }),
    );
    throwing.fatal("fatal");
    throwing.error("error", { a: 1 });
    throwing.warn("warn");
    throwing.info("info");
    throwing.debug("debug");
    throwing.trace("trace");
    deepStrictEqual(calls, [
      ["fatal"],
      ["error", { a: 1 }],
      ["warn"],
      ["info"],
      ["debug"],
      ["trace"],
    ]);

    let observed = false;
    const rejecting = safe(
      recorder(() => ({
        then(_resolve: unknown, reject: (error: Error) => void): void {
          observed = true;
          reject(new Error("A rejecting logger"));
        },
      })),
    );
    rejecting.error("error");
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    ok(observed);
    // Not wrapped twice
    ok(safe(rejecting) === rejecting);
  });

  test("a `child()` that fails gives a new logger of binden over the logger itself", () => {
    const logged: string[] = [];
    const base = recorder((message: string) => {
      logged.push(message);
    });
    const throwing = safe({
      ...base,
      child: (): never => {
        throw new Error("No child");
      },
    });
    const invalid = safe({
      ...base,
      child: (): ILogger => ({}) as ILogger,
    });
    for (const logger of [throwing, invalid]) {
      const child = logger.child({ id: 1 });
      // Never the logger itself, whose methods the application may replace
      ok(child !== logger && safe(child) === child);
      child.info("itself");
    }
    const valid = safe(base).child({ id: 1 });
    valid.info("child");
    deepStrictEqual(logged, ["itself", "itself", "child"]);
  });

  test("an object derived from a logger of binden, or a proxy of one, is wrapped: it logs through that logger, and a method that it overrides is used", () => {
    const logged: string[] = [];
    const base = safe(
      recorder((message: string) => {
        logged.push(message);
      }),
    );
    const derived = Object.assign(Object.create(base) as ILogger, {
      warn(message: string): void {
        logged.push(`overridden ${message}`);
      },
    });
    const traps: string[] = [];
    const handler = new Proxy(
      {},
      {
        // No trap at all: each is read from the handler, and recorded
        get(_target: object, trap: string): null {
          traps.push(trap);
          return null;
        },
      },
    );
    const proxy = new Proxy(base, handler);
    const wrapped = [safe(derived), safe(proxy)];
    // Told by its brand: no trap of the proxy has run
    deepStrictEqual(traps, []);
    ok(wrapped.every((logger) => logger !== derived && logger !== proxy));
    for (const logger of wrapped) {
      logger.error("error");
      logger.warn("warn");
      logger.child({ id: 1 }).info("child");
    }
    // Also its inherited methods, called on it
    derived.debug("inherited");
    derived.child({ id: 2 }).trace("inherited child");
    deepStrictEqual(logged, [
      "error",
      "overridden warn",
      "child",
      "error",
      "warn",
      "child",
      "inherited",
      "inherited child",
    ]);
  });

  test("a `child()` that gives a logger that throws gives a logger of binden over it, whose calls never fail", () => {
    const calls: string[] = [];
    const throwing = recorder((message: string): never => {
      calls.push(message);
      throw new Error("A failing child");
    });
    const parent = safe({ ...recorder(() => null), child: () => throwing });
    const child = parent.child({ id: 1 });
    child.error("error");
    childLogger(parent, { id: 2 }).warn("warn");
    // Another logger is wrapped first, and so is a value that is not one
    const wrapped = childLogger(throwing, { id: 3 });
    wrapped.info("info");
    const nothing = childLogger(null as unknown as ILogger, { id: 4 });
    nothing.error("nowhere");
    ok(safe(nothing) === nothing);
    // A level that is not one drops the record, without converting it
    record(throwing, "verbose" as "info", "dropped");
    // A logger of binden, told by its brand
    ok(safe(child) === child && safe(wrapped) === wrapped);
    deepStrictEqual(calls, ["error", "warn", "info"]);
  });

  test("binden writes its own records by the private paths of its loggers: the methods (and `child()`) replaced on one are never used, and the class has no property to replace", () => {
    const calls: unknown[][] = [];
    const base = safe(
      recorder((...args: unknown[]) => {
        calls.push(args);
      }),
    );
    const log = base.child({ id: 1 });
    const thrower = (): never => {
      throw new Error("A replaced method");
    };
    for (const method of [
      "fatal",
      "error",
      "warn",
      "info",
      "debug",
      "trace",
      "child",
    ]) {
      Object.assign(log, { [method]: thrower });
    }
    record(log, "info", "info");
    record(log, "error", "error", { a: 1 });
    const child = childLogger(log, { id: 2 });
    ok(safe(child) === child);
    record(child, "debug", "child");
    // A new logger of binden over a logger of binden that a `child()` gives:
    // also its own methods reach it by its private path
    const over = safe({ ...recorder(thrower), child: () => log }).child({});
    ok(over !== log && safe(over) === over);
    over.warn("over");
    record(over, "trace", "recorded over");
    // Its child: by the private path of the logger of binden under it
    over.child({ id: 3 }).info("over child");
    record(childLogger(over, { id: 4 }), "fatal", "recorded over child");
    // The application wraps them, and calls its own methods
    throws(() => {
      log.info("replaced");
    });
    deepStrictEqual(calls, [
      ["info"],
      ["error", { a: 1 }],
      ["child"],
      ["over"],
      ["recorded over"],
      ["over child"],
      ["recorded over child"],
    ]);
    deepStrictEqual(Object.getOwnPropertyNames(log.constructor).sort(), [
      "length",
      "name",
      "prototype",
    ]);
  });

  test("record() and logTo() never throw: another logger is called guarded, and what getting the logger of a context throws drops the record", async () => {
    const logged: string[] = [];
    const base = safe(
      recorder((message: string) => {
        logged.push(message);
      }),
    );
    const thrower = (): never => {
      throw new Error("A failing logger");
    };
    record(null, "info", "nothing");
    record(recorder(thrower), "info", "thrown");
    let observed = false;
    record(
      recorder(() => ({
        then(_resolve: unknown, reject: (error: Error) => void): void {
          observed = true;
          reject(new Error("A rejecting logger"));
        },
      })),
      "warn",
      "rejected",
    );
    // An object derived from a logger of binden: through its own methods
    const derived = Object.assign(Object.create(base) as ILogger, {
      warn(message: string): void {
        logged.push(`overridden ${message}`);
      },
    });
    record(derived, "warn", "derived");
    record(derived, "debug", "inherited");
    logTo(
      {
        get log(): ILogger {
          return thrower();
        },
      },
      "info",
      "dropped",
    );
    class Unlogged extends Context {
      // eslint-disable-next-line class-methods-use-this -- a getter that fails
      public override get log(): ILogger {
        return thrower();
      }
    }
    const request = new BindenRequest(new Socket());
    const response = new BindenResponse(request);
    logTo(new Unlogged({ request, response }), "error", "dropped");
    const context = new Context({ request, response, logger: base });
    logTo(context, "error", "through the context", { a: 1 });
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    ok(observed);
    deepStrictEqual(logged, [
      "overridden derived",
      "inherited",
      "through the context",
    ]);
  });

  test("a logger of binden over another one is flat: nested 20000 times (by its constructor, or by a `child()` that gives the last child), it writes every record and never throws", () => {
    const logged: string[] = [];
    const base = recorder((message: string) => {
      logged.push(message);
    });
    // The class of the loggers of binden, which the application reaches
    const Safe = safe(base).constructor as new (logger: ILogger) => ILogger;
    let nested: ILogger = base;
    for (let index = 0; index < 20_000; index += 1) {
      nested = new Safe(nested);
    }
    let last: ILogger | null = null;
    // E.g. a cache that keeps the last `context.log`
    const caching: ILogger = { ...base, child: (): ILogger => last ?? base };
    for (let index = 0; index < 20_000; index += 1) {
      last = childLogger(caching, { index });
    }
    for (const logger of [nested, last as unknown as ILogger]) {
      logger.info("method");
      record(logger, "warn", "record");
      logger.child({ id: 1 }).error("method child");
      record(childLogger(logger, { id: 2 }), "debug", "record child");
      const request = new BindenRequest(new Socket());
      const response = new BindenResponse(request);
      new Context({ request, response, logger }).log.trace("context");
    }
    deepStrictEqual(logged, [
      ...["method", "record", "method child", "record child", "context"],
      ...["method", "record", "method child", "record child", "context"],
    ]);
  });

  test("isLogger()", () => {
    ok(isLogger(new Logger({ level: "silent" })));
    ok(isLogger(recorder(() => null)));
    ok(!isLogger(null));
    ok(!isLogger("logger"));
    ok(!isLogger({ ...recorder(() => null), child: null }));
  });
});
