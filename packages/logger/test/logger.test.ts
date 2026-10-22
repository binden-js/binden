import { deepEqual, equal, ok, rejects, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import log, {
  Logger,
  type LoggerOptions,
  createSerializers,
  serializers,
} from "../index.js";
import pino, { type LevelWithSilent, type Logger as PinoLogger } from "pino";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

type Line = Record<string, unknown>;

class Sink {
  public readonly lines: Line[] = [];

  public write(chunk: string): void {
    for (const line of chunk.split("\n")) {
      if (line !== "") {
        this.lines.push(JSON.parse(line) as Line);
      }
    }
  }
}

const methods = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
const levels = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/** An object (or an array) whose values are getters that count their reads */
function countedIn<T extends object>(
  reads: Map<string, number>,
  name: string,
  values: T,
): T {
  return Object.defineProperties(
    Array.isArray(values) ? [] : {},
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        {
          enumerable: true,
          get: (): unknown => {
            const at = `${name}.${key}`;
            reads.set(at, (reads.get(at) ?? 0) + 1);
            return value as unknown;
          },
        },
      ]),
    ),
  ) as T;
}

/**
 * The messages of the records that reach the targets of the tests that post
 * them on a channel (see `fixtures/channel.mjs`), once `last` is among them:
 * a failure after 10 seconds without it
 */
function received(name: string, last: string): Promise<string[]> {
  const channel = new BroadcastChannel(name);
  const messages: string[] = [];
  const { promise, resolve, reject } = Promise.withResolvers<string[]>();
  const timer = setTimeout(() => {
    channel.close();
    reject(new Error(`No "${last}" on ${name}, but: ${messages.join(", ")}`));
  }, 10_000);
  channel.onmessage = ({ data }: MessageEvent<string>): void => {
    messages.push(data);
    if (data === last) {
      clearTimeout(timer);
      channel.close();
      resolve(messages);
    }
  };
  return promise;
}

function withEnv(name: string, value: string | null, fn: () => void): void {
  const previous = process.env[name] ?? null;
  const set = (next: string | null): void => {
    if (next === null) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = next;
    }
  };
  set(value);
  try {
    fn();
  } finally {
    set(previous);
  }
}

describe("Logger", () => {
  it(".ENV_VARIABLE_NAME", () => {
    equal(Logger.ENV_VARIABLE_NAME, "BINDEN_LOG_LEVEL");
  });

  it(".getLevel() defaults to `silent`", () => {
    withEnv(Logger.ENV_VARIABLE_NAME, null, () => {
      equal(Logger.getLevel(), "silent");
    });
  });

  it(".getLevel() reads every level (case and whitespace insensitive)", () => {
    for (const level of methods) {
      withEnv(Logger.ENV_VARIABLE_NAME, ` ${level.toUpperCase()} `, () => {
        equal(Logger.getLevel(), level);
      });
    }
  });

  it(".getLevel() falls back to `silent` for unknown values", () => {
    withEnv(Logger.ENV_VARIABLE_NAME, "verbose", () => {
      equal(Logger.getLevel(), "silent");
    });
  });

  it(".getLevel() reads a custom environment variable", () => {
    withEnv("CUSTOM_BINDEN_LOG_LEVEL", "warn", () => {
      equal(Logger.getLevel("CUSTOM_BINDEN_LOG_LEVEL"), "warn");
    });
  });

  it("writes every level with the message and `extra`", () => {
    const sink = new Sink();
    const logger = new Logger({ destination: sink, level: "trace" });

    for (const method of methods) {
      logger[method](`${method} message`, { method });
      logger[method](`${method} without extra`);
    }

    deepEqual(
      sink.lines.map(({ level, msg, method }) => [level, msg, method ?? null]),
      methods.flatMap((method) => [
        [levels[method], `${method} message`, method],
        [levels[method], `${method} without extra`, null],
      ]),
    );
  });

  it("takes the level from the environment", () => {
    withEnv(Logger.ENV_VARIABLE_NAME, "warn", () => {
      const sink = new Sink();
      const logger = new Logger({ destination: sink });

      logger.info("skipped");
      logger.warn("written");

      deepEqual(
        sink.lines.map(({ msg }) => msg),
        ["written"],
      );
    });
  });

  it(".child() adds bindings", () => {
    const sink = new Sink();
    const logger = new Logger({ destination: sink, level: "info" });

    logger.child({ request_id: "id" }).info("with bindings");
    logger.child().info("without bindings");

    const [withBindings, withoutBindings] = sink.lines;
    equal(sink.lines.length, 2);
    equal(withBindings.msg, "with bindings");
    equal(withBindings.request_id, "id");
    equal(withoutBindings.msg, "without bindings");
    ok(!("request_id" in withoutBindings));
  });

  it("wraps an existing `pino` logger", () => {
    const sink = new Sink();
    const logger = new Logger({ logger: pino({ level: "info" }, sink) });

    logger.info("wrapped", { extra: true });

    const [line] = sink.lines;
    equal(sink.lines.length, 1);
    equal(line.msg, "wrapped");
    equal(line.extra, true);
  });

  it("creates a `pino` logger without a destination", () => {
    ok(new Logger() instanceof Logger);
    ok(new Logger({ level: "silent" }) instanceof Logger);
    ok(log instanceof Logger);
  });

  it("serializes an error by default without its details", () => {
    const sink = new Sink();
    const logger = new Logger({ destination: sink, level: "error" });

    logger.error("failed", {
      error: Object.assign(new RangeError("secret"), { code: "ECONNRESET" }),
    });

    deepEqual(sink.lines[0].error, { type: "RangeError", code: "ECONNRESET" });
  });

  it("serializes an error under `err` (the key of `pino`) as under `error`", () => {
    const sink = new Sink();
    const logger = new Logger({ destination: sink, level: "error" });
    const secret = Object.assign(new Error("password=hunter2"), {
      code: "E_SECRET",
      config: { headers: { authorization: "Bearer SECRET" } },
    });

    logger.error("err", { err: secret });
    // An `Error` as `extra` is logged under `err` by `pino`
    logger.error("extra", secret as unknown as Record<string, unknown>);

    deepEqual(
      sink.lines.map(({ msg, err }) => [msg, err]),
      [
        ["err", { type: "Error" }],
        ["extra", { type: "Error" }],
      ],
    );
    deepEqual(serializers.err(secret), serializers.error(secret));
  });

  it("serializes the details of an error with `error_details`", () => {
    const sink = new Sink();
    const logger = new Logger({
      destination: sink,
      level: "error",
      error_details: true,
    });

    logger.error("failed", {
      error: Object.assign(new Error("boom"), { code: "E_CUSTOM" }),
    });

    const error = sink.lines[0].error as Line;
    equal(error.type, "Error");
    equal(error.message, "boom");
    equal(error.code, "E_CUSTOM");
    equal(typeof error.stack, "string");
  });

  it("refuses invalid options", () => {
    throws(
      () => new Logger({ error_details: 1 as unknown as boolean }),
      new TypeError("`error_details` is not a boolean"),
    );
    throws(
      () => createSerializers({ error_details: "no" as unknown as boolean }),
      new TypeError("`error_details` is not a boolean"),
    );
    for (const level of ["verbose", "INFO", "", 30]) {
      throws(
        () => new Logger({ destination: new Sink(), level: level as string }),
        new TypeError(`Unknown level: ${level}`),
      );
    }
    // The custom levels, and `silent`
    const customLevels = { audit: 35 };
    equal(new Logger({ level: "audit", customLevels }).level, "audit");
    equal(new Logger({ level: "silent" }).level, "silent");
    throws(
      () =>
        new Logger({ level: "info", customLevels, useOnlyCustomLevels: true }),
      new TypeError("Unknown level: info"),
    );
  });

  it("refuses the options combined with `logger`, and a `logger` that is not a `pino` logger", () => {
    const logger = pino({ level: "warn" }, new Sink());
    const combined: [LoggerOptions, string][] = [
      [{ destination: new Sink() }, "destination"],
      [{ level: "debug" }, "level"],
      [{ error_details: true }, "error_details"],
      [{ error_details: false }, "error_details"],
      [{ serializers: {} }, "serializers"],
    ];
    for (const [options, name] of combined) {
      throws(
        () => new Logger({ ...options, logger }),
        new TypeError(`\`logger\` cannot be combined with \`${name}\``),
      );
    }
    // Options that are not set
    const unset: unknown = Reflect.get({}, "unset");
    equal(new Logger({ logger, level: unset } as LoggerOptions).level, "warn");
    for (const invalid of [null, {}, "pino", { ...logger, flush: null }]) {
      throws(
        () => new Logger({ logger: invalid as unknown as PinoLogger }),
        new TypeError("`logger` is not a `pino` logger"),
      );
    }
  });

  it("reads once each nested option that `pino` reads several times: the levels of `customLevels`, the paths of `redact` and the targets of `transport`", () => {
    const reads = new Map<string, number>();
    const counted = <T extends object>(name: string, values: T): T =>
      countedIn(reads, name, values);
    const sink = new Sink();
    const logger = new Logger({
      destination: sink,
      level: "custom",
      customLevels: counted("customLevels", { custom: 35 }),
      redact: counted("redact", {
        paths: counted("paths", ["secret"]),
        censor: "[hidden]",
      }),
    });
    logger.warn("warn", { secret: "s" });
    logger.info("info", { secret: "s" });
    // Without a level (`silent`: nothing is written), and the paths as a list
    new Logger({
      destination: sink,
      customLevels: counted("defaults", { other: 15 }),
      redact: counted("list", ["secret"]),
    }).error("error", { secret: "s" });
    // A URL: also on Windows, where `pino` prefixes a path with `file://`
    const target = new URL("fixtures/discard.mjs", import.meta.url).href;
    new Logger({
      transport: counted("transport", {
        targets: counted("targets", [counted("target", { target })]),
      }),
    }).info("discarded");
    new Logger({
      transport: {
        pipeline: counted("pipeline", [counted("step", { target })]),
      },
    }).info("discarded");
    // What `pino` reads as it is (also inherited): a target, the pipeline of
    // a target and its level (see below), and the options of `redact`
    new Logger({
      transport: {
        targets: [
          Object.create(
            counted("inherited", { target, level: "info" }),
          ) as never,
          counted("piped", {
            level: "warn",
            pipeline: counted("steps", [counted("next", { target })]),
          }),
        ],
      },
    }).info("discarded");
    new Logger({
      destination: sink,
      level: "info",
      redact: Object.create(counted("options", { paths: ["secret"] })) as never,
    }).info("inherited", { secret: "s" });
    deepEqual(
      sink.lines.map(({ level, msg, secret }) => [level, msg, secret]),
      [
        [40, "warn", "[hidden]"],
        [30, "inherited", "[Redacted]"],
      ],
    );
    // What `pino` refuses itself: a target that is not an object, and the
    // options of `redact` without a list of paths
    throws(() => new Logger({ transport: { targets: [null as never] } }), {
      name: "TypeError",
    });
    throws(() => new Logger({ transport: { pipeline: [null as never] } }), {
      name: "TypeError",
    });
    throws(() => new Logger({ destination: sink, redact: {} as never }), {
      message: "pino – redact must contain an array of strings",
    });
    deepEqual(Object.fromEntries(reads), {
      "customLevels.custom": 1,
      "redact.paths": 1,
      "redact.censor": 1,
      "paths.0": 1,
      "defaults.other": 1,
      "list.0": 1,
      "transport.targets": 1,
      "targets.0": 1,
      "target.target": 1,
      "pipeline.0": 1,
      "step.target": 1,
      "inherited.target": 1,
      "piped.level": 1,
      "piped.pipeline": 1,
      "steps.0": 1,
      "next.target": 1,
      "options.paths": 1,
    });
  });

  it("copies the targets and the steps of `transport` as `pino` reads them: an inherited `level` only for a target with a pipeline", async () => {
    const reads = new Map<string, number>();
    const counted = <T extends object>(name: string, values: T): T =>
      countedIn(reads, name, values);
    const target = new URL("fixtures/channel.mjs", import.meta.url).href;
    const named = (key: string): string =>
      `binden-logger-${process.pid}-${key}`;
    const to = (key: string): Record<string, unknown> => ({
      target,
      options: { channel: named(key) },
    });
    const inheriting = (
      key: string,
      inherited: Record<string, unknown>,
      own: Record<string, unknown>,
    ): never =>
      Object.assign(Object.create(counted(key, inherited)), own) as never;
    const transports = [
      // The inherited `level` of a target, and of a step, is ignored
      { targets: [inheriting("target", { level: "error" }, to("target"))] },
      { pipeline: [inheriting("step", { level: "error" }, to("step"))] },
      // Not the one of a target with a pipeline (also inherited): its steps
      // get it
      {
        targets: [
          inheriting("piped", { level: "error" }, { pipeline: [to("piped")] }),
        ],
      },
      {
        targets: [
          inheriting(
            "inherited",
            {
              level: "error",
              pipeline: [to("inherited")],
            },
            {},
          ),
        ],
      },
      // Nor is it spread into the target itself
      {
        targets: [
          inheriting(
            "both",
            { level: "error" },
            {
              ...to("both"),
              pipeline: [to("both-steps")],
            },
          ),
        ],
      },
    ];
    const expected = {
      target: ["info", "error"],
      step: ["info", "error"],
      piped: ["error"],
      inherited: ["error"],
      both: ["info", "error"],
      "both-steps": ["error"],
    };
    const records = Promise.all(
      Object.keys(expected).map((key) => received(named(key), "error")),
    );
    for (const transport of transports) {
      const logger = new Logger({ level: "info", transport });
      logger.info("info");
      logger.error("error");
    }
    deepEqual(await records, Object.values(expected));
    deepEqual(Object.fromEntries(reads), {
      "piped.level": 1,
      "inherited.level": 1,
      "inherited.pipeline": 1,
      "both.level": 1,
    });
  });

  it("reads a `customLevels` that is a function as an object: each of its levels once", () => {
    let reads = 0;
    const customLevels = Object.defineProperty(() => null, "custom", {
      enumerable: true,
      get: (): number => {
        reads += 1;
        return reads === 1 ? 35 : 5;
      },
    });
    const sink = new Sink();
    const logger = new Logger({
      destination: sink,
      level: "custom" as LevelWithSilent,
      customLevels,
    });
    logger.info("below");
    logger.warn("above");
    equal(reads, 1);
    deepEqual(
      sink.lines.map(({ level, msg }) => [level, msg]),
      [[40, "above"]],
    );
  });

  it("copies `hooks` once: its `logMethod` and `streamWrite` (also inherited), read once each", () => {
    const reads = new Map<string, number>();
    const hooks = Object.defineProperties(
      Object.create(
        countedIn(reads, "inherited", {
          logMethod(
            this: PinoLogger,
            args: unknown[],
            method: (...given: unknown[]) => void,
          ): void {
            method.apply(this, [args[0], `hooked ${String(args[1])}`]);
          },
        }),
      ) as object,
      Object.getOwnPropertyDescriptors(
        countedIn(reads, "own", {
          streamWrite: (line: string): string =>
            line.replace("hooked", "written"),
        }),
      ),
    );
    const sink = new Sink();
    const logger = new Logger({
      destination: sink,
      level: "info",
      hooks,
    });
    logger.info("one");
    // `pino` reads `logMethod` at every change of its level
    logger.level = "debug";
    logger.level = "info";
    logger.child({ id: 1 }).info("two");
    logger.warn("three");
    deepEqual(
      sink.lines.map(({ msg }) => msg),
      ["written one", "written two", "written three"],
    );
    deepEqual(Object.fromEntries(reads), {
      "inherited.logMethod": 1,
      "own.streamWrite": 1,
    });
  });

  it("keeps the default serializers that are not replaced", () => {
    const sink = new Sink();
    const logger = new Logger({
      destination: sink,
      level: "info",
      serializers: { body: (): string => "[Redacted]" },
    });

    logger.info("request", {
      body: "secret",
      request: { method: "GET", url: "/x?token=secret" },
      error: new Error("secret"),
    });

    const [line] = sink.lines;
    equal(line.body, "[Redacted]");
    deepEqual(line.request, { method: "GET", path: "/x" });
    deepEqual(line.error, { type: "Error" });
  });

  it("`level` and `isLevelEnabled()`", () => {
    const logger = new Logger({ destination: new Sink(), level: "info" });
    equal(logger.level, "info");
    ok(logger.isLevelEnabled("info"));
    ok(!logger.isLevelEnabled("debug"));

    logger.level = "debug";
    equal(logger.level, "debug");
    ok(logger.isLevelEnabled("debug"));
    throws(() => {
      logger.level = "nope" as LevelWithSilent;
    }, new TypeError("Unknown level: nope"));
    equal(logger.level, "debug");
    const custom = new Logger({ customLevels: { audit: 35 } });
    custom.level = "audit" as LevelWithSilent;
    equal(custom.level, "audit");
  });

  it(".child() with its own level", () => {
    const sink = new Sink();
    const logger = new Logger({ destination: sink, level: "info" });
    const child = logger.child({ id: 1 }, { level: "debug" });

    equal(child.level, "debug");
    equal(logger.level, "info");
    child.debug("written");
    logger.debug("skipped");
    deepEqual(
      sink.lines.map(({ msg, id }) => [msg, id]),
      [["written", 1]],
    );
    throws(
      () => logger.child({}, { level: "verbose" as LevelWithSilent }),
      new TypeError("Unknown level: verbose"),
    );
    const custom = new Logger({ customLevels: { audit: 35 } });
    const audit = "audit" as LevelWithSilent;
    equal(custom.child({}, { level: audit }).level, audit);
  });

  it("Logger.fromPino()", () => {
    const sink = new Sink();
    const logger = Logger.fromPino(pino({ level: "warn" }, sink));
    ok(logger instanceof Logger);
    logger.warn("wrapped");
    equal(sink.lines[0].msg, "wrapped");
    equal(logger.level, "warn");
  });

  it(".flush()", async () => {
    // A destination that buffers nothing
    await new Logger({ destination: new Sink() }).flush();

    let flushed = false;
    const buffered = {
      write: (): void => {
        // Written later
      },
      flush: (callback: (error?: Error) => void): void => {
        flushed = true;
        callback();
      },
    };
    await new Logger({ destination: buffered }).flush();
    ok(flushed);

    const failing = {
      write: (): void => {
        // Written later
      },
      flush: (callback: (error?: Error) => void): void => {
        callback(new Error("The destination has failed"));
      },
    };
    await rejects(
      new Logger({ destination: failing }).flush(),
      new Error("The destination has failed"),
    );
  });

  it("the default logger is created on first use", () => {
    const { status, stdout, stderr } = spawnSync(
      process.execPath,
      ["--import", "tsx", join(import.meta.dirname, "fixtures", "lazy.ts")],
      { encoding: "utf8", timeout: 30_000 },
    );
    deepEqual(
      { status, stdout, stderr },
      { status: 0, stdout: "warn\n", stderr: "" },
    );
  });
});

describe("serializers", () => {
  it("error: the type, a known code and the status only", () => {
    class SECRET_CLASS extends TypeError {}
    deepEqual(serializers.error(new SECRET_CLASS("secret")), {
      type: "TypeError",
    });
    deepEqual(
      serializers.error(
        Object.assign(new Error("secret"), { code: "ECONNRESET", status: 404 }),
      ),
      { type: "Error", code: "ECONNRESET", status: 404 },
    );
    deepEqual(
      serializers.error(
        Object.assign(new Error("secret"), { code: "SECRET", status: 999 }),
      ),
      { type: "Error" },
    );
    deepEqual(serializers.error({ status: 400, message: "secret", code: 1 }), {
      type: "object",
      status: 400,
    });
    const errors = [
      new AggregateError([]),
      new EvalError(),
      new ReferenceError(),
      new SyntaxError(),
      new URIError(),
      new RangeError(),
    ];
    deepEqual(
      errors.map((error) => serializers.error(error).type),
      [
        "AggregateError",
        "EvalError",
        "ReferenceError",
        "SyntaxError",
        "URIError",
        "RangeError",
      ],
    );
    deepEqual(serializers.error(null), { type: "null" });
    deepEqual(serializers.error("secret"), { type: "string" });
    deepEqual(serializers.error(Object.create(null) as object), {
      type: "object",
    });
  });

  it("error: never throws, nor loops forever", () => {
    const getters = new Error("secret");
    for (const key of ["code", "status", "message", "stack"]) {
      Object.defineProperty(getters, key, {
        get(): never {
          throw new Error("getter");
        },
      });
    }
    deepEqual(createSerializers({ error_details: true }).error(getters), {
      type: "Error",
    });

    const thrower = (): never => {
      throw new Error("trap");
    };
    const traps = new Proxy(new Error("secret"), {
      get: thrower,
      getPrototypeOf: thrower,
    });
    deepEqual(serializers.error(traps), { type: "object" });

    // Its prototype is itself, or a new proxy every time
    const cyclic: object = new Proxy(
      {},
      {
        getPrototypeOf(): object {
          return cyclic;
        },
      },
    );
    const endless = (): object =>
      new Proxy(
        {},
        {
          getPrototypeOf(): object {
            return endless();
          },
        },
      );
    const start = performance.now();
    deepEqual(serializers.error(cyclic), { type: "object" });
    deepEqual(serializers.error(endless()), { type: "object" });
    // A bounded walk, not one until the set of the seen prototypes is full
    ok(performance.now() - start < 500);
    deepEqual(serializers.error(thrower), { type: "function" });
  });

  it("request: the method and the path without the query", () => {
    deepEqual(
      serializers.request({
        method: "POST",
        url: "/x?token=secret#fragment",
        headers: { authorization: "secret" },
      }),
      { method: "POST", path: "/x" },
    );
    deepEqual(serializers.request({ url: "http://user:secret@host/x?t=1" }), {
      path: "/x",
    });
    deepEqual(serializers.request({ url: "*" }), { path: "" });
    deepEqual(serializers.request({ method: "GET" }), { method: "GET" });
    deepEqual(serializers.request({ secret: "secret" }), { type: "object" });
    deepEqual(serializers.request("secret"), { type: "string" });
  });

  it("response: the status only", () => {
    deepEqual(
      serializers.response({ statusCode: 201, headers: { "set-cookie": "s" } }),
      { status: 201 },
    );
    deepEqual(serializers.response({ statusCode: 1000 }), { type: "object" });
    deepEqual(serializers.response(Symbol("secret")), { type: "symbol" });
  });
});
