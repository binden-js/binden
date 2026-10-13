import { deepEqual, equal, ok } from "node:assert/strict";
import { describe, it } from "node:test";
import pino from "pino";
import log, { Logger } from "../index.js";

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

  it("serializes errors", () => {
    const sink = new Sink();
    const logger = new Logger({ destination: sink, level: "error" });

    logger.error("failed", { error: new Error("boom") });

    const [line] = sink.lines;
    const error = line.error as Line;
    equal(error.type, "Error");
    equal(error.message, "boom");
    equal(typeof error.stack, "string");
  });
});
