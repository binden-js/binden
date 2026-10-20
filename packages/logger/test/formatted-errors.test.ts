import { Logger, createSerializers } from "../index.js";
import { describe, it } from "node:test";
import { ok, strictEqual } from "node:assert/strict";

/**
 * Runs `run`, which throws, while `Error.prepareStackTrace` is `prepare`:
 * what it throws
 */
function thrown(run: () => unknown, prepare: unknown): unknown {
  const previous: unknown = Reflect.get(Error, "prepareStackTrace");
  Reflect.set(Error, "prepareStackTrace", prepare);
  try {
    run();
  } catch (error: unknown) {
    return error;
  } finally {
    Reflect.set(Error, "prepareStackTrace", previous);
  }
  return null;
}

describe("An error that the logger throws", () => {
  for (const [what, run] of [
    [
      "an invalid `error_details` of the serializers",
      (): unknown => createSerializers({ error_details: 1 as never }),
    ],
    [
      "an unknown level",
      (): unknown => new Logger({ level: "verbose" as never }),
    ],
  ] as const) {
    it(`is formatted when it is created: ${what}`, () => {
      const formatted = new WeakSet<object>();
      const error = thrown(run, (failure: Error): string => {
        formatted.add(failure);
        return `${failure.name}: ${failure.message}`;
      });
      ok(error instanceof TypeError);
      ok(formatted.has(error));
    });
  }

  it("is thrown as it is when a `prepareStackTrace` of the application throws: its stack is left to it", () => {
    const error = thrown(
      () => createSerializers({ error_details: 1 as never }),
      (): never => {
        throw new Error("prepareStackTrace");
      },
    );
    ok(error instanceof TypeError);
    strictEqual(error.message, "`error_details` is not a boolean");
  });
});
