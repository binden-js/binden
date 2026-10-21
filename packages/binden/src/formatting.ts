import { formatStack } from "./exchange.js";

/**
 * Runs the body of an entry point of binden, or of one of its packages (e.g.
 * what reads or calls an argument: the properties of an object, or a
 * function): what it throws is formatted (see `formatStack()`) before the
 * caller gets it, such as the `TypeError` that V8 creates while the frames of
 * binden are on the stack for a revoked proxy, a destructuring of `null`, or
 * a class constructor called as a function. An error of the application's own
 * (e.g. of a getter) is thrown as it is (formatted too), and anything thrown
 * that is not an error is passed on as it is. A hot path (e.g. a write) uses
 * the same `try`/`catch` inline, without the closure. For the packages of
 * binden only.
 *
 * @internal
 */
export function formatting<T>(run: () => T): T {
  try {
    return run();
  } catch (error: unknown) {
    throw formatStack(error as Error);
  }
}

/**
 * A value that an argument error of binden refuses, as its message shows it,
 * without converting it: a string, a number, a boolean, `undefined` or `null`
 * as it is, a `bigint` with its `n`, and anything else by its type (`(a
 * symbol)`, `(a function)` or `(an object)`), so that neither a conversion
 * throws (e.g. of a `Symbol`, or of an object without a primitive value: an
 * error that V8 would create while the frames of the call are on the stack)
 * nor code of the application runs (e.g. a `toString()`). For the packages of
 * binden only.
 *
 * @internal
 */
export function described(value: unknown): string {
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "boolean":
      return `${value}`;
    case "bigint":
      return `${value}n`;
    case "undefined":
      return "undefined";
    case "symbol":
      return "(a symbol)";
    case "function":
      return "(a function)";
    case "object":
    default:
      return value === null ? "null" : "(an object)";
  }
}

/**
 * The init of a header (`name` in the message), checked before any of its
 * properties is read: an object (an array too). Anything else (e.g. `null`,
 * a string, a number, or a function) is refused with a `TypeError` that
 * describes it (see `described()`), formatted (see `formatStack()`):
 * destructuring would read a primitive as an object without the values, and
 * fail (with an error of V8) on `null`.
 */
export function objectOf(value: unknown, name: string): object {
  if (typeof value !== "object" || value === null) {
    throw formatStack(
      new TypeError(`\`${name}\` is not an object: ${described(value)}`),
    );
  }
  return value;
}
