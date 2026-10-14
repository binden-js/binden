import { deepStrictEqual, throws } from "node:assert/strict";
import { suite, test } from "node:test";

import { BodyParser, type IBodyParserOptions } from "../index.js";

/** Options of the wrong type, for the tests */
function options(input: Record<string, unknown>): IBodyParserOptions {
  return input;
}

suite("BodyParser (options)", () => {
  test("`parse` is a function", () => {
    throws(
      () => new BodyParser(options({ parse: 2 })),
      new TypeError("`parse` is not a function"),
    );
  });

  test("the limits are non-negative integers or `Infinity`", () => {
    for (const name of ["limit", "encoded_limit", "parameter_limit"]) {
      for (const value of ["1", null, Number.NaN, 1n]) {
        throws(
          () => new BodyParser(options({ [name]: value })),
          new TypeError(`\`${name}\` is not a number`),
        );
      }
      for (const value of [-1, 1.5, -Infinity, 2 ** 53]) {
        throws(
          () => new BodyParser(options({ [name]: value })),
          new RangeError(
            `\`${name}\` is not a non-negative integer or \`Infinity\``,
          ),
        );
      }
      for (const value of [0, 1, Number.MAX_SAFE_INTEGER, Infinity]) {
        deepStrictEqual(
          new BodyParser(options({ [name]: value })) instanceof BodyParser,
          true,
        );
      }
    }
  });

  test("the flags are booleans", () => {
    for (const name of ["raw", "strict"]) {
      for (const value of [1, "true", null]) {
        throws(
          () => new BodyParser(options({ [name]: value })),
          new TypeError(`\`${name}\` is not a boolean`),
        );
      }
    }
    // The options of every middleware
    throws(
      () => new BodyParser(options({ disabled: 1 })),
      new TypeError("`disabled` is not a boolean"),
    );
    deepStrictEqual(
      new BodyParser({ ignore_errors: true }).ignore_errors,
      true,
    );
  });

  test("`type` is a list of media types or a function", () => {
    throws(
      () => new BodyParser(options({ type: "application/json" })),
      new TypeError("`type` is not an array or a function"),
    );
    for (const entry of [
      "json",
      "",
      "+",
      "application/json; charset=utf-8",
      "application/",
      "/json",
      " text/plain",
      1,
    ]) {
      throws(
        () => new BodyParser(options({ type: [entry] })),
        new TypeError(`Invalid media type in \`type\`: ${String(entry)}`),
      );
    }
    const types = ["text/*", "*/*", "+json", "Application/JSON", "a/b"];
    deepStrictEqual(
      new BodyParser({ type: types }) instanceof BodyParser,
      true,
    );
    deepStrictEqual(new BodyParser({ type: [] }) instanceof BodyParser, true);
    deepStrictEqual(
      new BodyParser({ type: (): null => null }) instanceof BodyParser,
      true,
    );
  });

  test("`raw` cannot be used with a `type` function", () => {
    throws(
      () => new BodyParser({ raw: true, type: (): "raw" => "raw" }),
      new TypeError("`raw` cannot be used with a `type` function"),
    );
    // Without `raw`, or with a list
    deepStrictEqual(
      new BodyParser({ raw: false, type: (): "raw" => "raw" }) instanceof
        BodyParser,
      true,
    );
    deepStrictEqual(
      new BodyParser({ raw: true, type: ["text/plain"] }) instanceof BodyParser,
      true,
    );
  });

  test("the unsupported methods", () => {
    const methods = BodyParser.unsupported_methods;
    deepStrictEqual(methods, new Set(["GET", "HEAD", "OPTIONS", "TRACE"]));
    // A copy
    methods.delete("GET");
    deepStrictEqual(BodyParser.unsupported_methods.has("GET"), true);
  });
});
