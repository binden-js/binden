import { Logger, createSerializers } from "../index.js";
import { deepStrictEqual, ok } from "node:assert/strict";
import { describe, it } from "node:test";
import pino from "pino";

/** An error of the application's own (e.g. of a getter, or of a trap) */
class OwnError extends Error {}

/** What a call has thrown, and whether it was formatted then */
interface IOutcome {
  readonly thrown: unknown;
  readonly formatted: boolean;
}

/**
 * Runs a call while `Error.prepareStackTrace` records each error whose stack
 * V8 formats: what it throws, and whether that was formatted before the
 * caller got it (`null` when it does not throw)
 */
function outcome(run: () => unknown): IOutcome | null {
  const formatted = new WeakSet<object>();
  const previous: unknown = Reflect.get(Error, "prepareStackTrace");
  Reflect.set(Error, "prepareStackTrace", (error: Error): string => {
    formatted.add(error);
    return `${error.name}: ${error.message}`;
  });
  try {
    run();
    return null;
  } catch (thrown: unknown) {
    return {
      thrown,
      formatted: typeof thrown === "object" && formatted.has(thrown as object),
    };
  } finally {
    Reflect.set(Error, "prepareStackTrace", previous);
  }
}

/** A revoked proxy */
function revoked(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

/** A proxy whose every trap throws `error` */
function throwing(error: Error): object {
  const trap = (): never => {
    throw error;
  };
  return new Proxy(
    {},
    { get: trap, getOwnPropertyDescriptor: trap, has: trap, ownKeys: trap },
  );
}

/** A destination that keeps nothing */
const sink = {
  write: (): void => {
    // Nothing
  },
};

describe("The entry points of the logger format what they throw (round 27)", () => {
  it("refuses options that are not an object, and formats what reading them throws", () => {
    for (const [run, message] of [
      [
        (): unknown => new Logger(null as never),
        "`options` is not an object: null",
      ],
      [(): unknown => new Logger(5 as never), "`options` is not an object: 5"],
      [
        (): unknown => createSerializers("a" as never),
        "`options` is not an object: a",
      ],
    ] as const) {
      const failed = outcome(run);
      ok(failed?.thrown instanceof TypeError);
      deepStrictEqual(
        [failed.thrown.message, failed.formatted],
        [message, true],
      );
    }
    for (const run of [
      (): unknown => new Logger(revoked()),
      (): unknown => createSerializers(revoked()),
      (): unknown => new Logger({ destination: revoked() as never }),
    ]) {
      const failed = outcome(run);
      ok(failed?.thrown instanceof TypeError);
      ok(failed.formatted);
    }
    for (const run of [
      (own: Error): unknown => new Logger(throwing(own)),
      (own: Error): unknown => createSerializers(throwing(own)),
      // Read as it is: what its trap throws is not a refusal
      (own: Error): unknown => Logger.fromPino(throwing(own) as never),
      (own: Error): unknown =>
        new Logger({ destination: sink }).child(throwing(own)),
      (own: Error): unknown =>
        new Logger({ destination: sink }).child({}, throwing(own)),
    ]) {
      const own = new OwnError("own");
      deepStrictEqual(
        outcome(() => run(own)),
        { thrown: own, formatted: true },
      );
    }
  });

  it("names the first option combined with `logger`, in the order of the options", () => {
    const failed = outcome(
      () =>
        new Logger({
          level: "info",
          logger: pino({ level: "info" }, sink),
          destination: sink,
        }),
    );
    ok(failed?.thrown instanceof TypeError);
    deepStrictEqual(
      failed.thrown.message,
      "`logger` cannot be combined with `level`",
    );
  });

  it("refuses a level, or the name of a variable, that is not a string without converting it", () => {
    let conversions = 0;
    const counting = {
      toString(): string {
        conversions += 1;
        return "info";
      },
    };
    const logger = new Logger({ destination: sink, level: "info" });
    for (const run of [
      (): unknown =>
        new Logger({ destination: sink, level: counting as never }),
      (): unknown => {
        logger.level = counting as never;
        return null;
      },
      (): unknown => logger.child({}, { level: counting as never }),
    ]) {
      const failed = outcome(run);
      ok(failed?.thrown instanceof TypeError);
      deepStrictEqual(
        [failed.thrown.message, failed.formatted],
        ["Unknown level: (an object)", true],
      );
    }
    for (const [level, message] of [
      [1n, "Unknown level: 1n"],
      [({} as { value?: undefined }).value, "Unknown level: undefined"],
      [Symbol("s"), "Unknown level: (a symbol)"],
      [(): null => null, "Unknown level: (a function)"],
      [true, "Unknown level: true"],
    ] as const) {
      const refused = outcome(() => {
        logger.level = level as never;
      });
      ok(refused?.thrown instanceof TypeError);
      deepStrictEqual(refused.thrown.message, message);
    }
    deepStrictEqual(logger.isLevelEnabled(counting as never), false);
    deepStrictEqual(logger.isLevelEnabled("info"), true);
    const failed = outcome(() => Logger.getLevel(counting as never));
    ok(failed?.thrown instanceof TypeError);
    deepStrictEqual(
      [failed.thrown.message, failed.formatted],
      ["`env_name` is not a string: (an object)", true],
    );
    deepStrictEqual(conversions, 0);
    // Without its class as the receiver, the default variable cannot be read
    const getLevel = Reflect.get(Logger, "getLevel") as () => unknown;
    const detached = outcome(() => Reflect.apply(getLevel, null, []));
    ok(detached?.thrown instanceof TypeError);
    ok(detached.formatted);
  });

  it("formats what `pino` throws as it reads the fields of a record", () => {
    const logger = new Logger({ destination: sink, level: "trace" });
    for (const method of [
      "trace",
      "debug",
      "info",
      "warn",
      "error",
      "fatal",
    ] as const) {
      const failed = outcome(() => {
        logger[method]("message", revoked() as never);
      });
      ok(failed?.thrown instanceof TypeError, method);
      ok(failed.formatted, method);
    }
  });
});
