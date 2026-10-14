import { deepStrictEqual, throws } from "node:assert";
import { suite, test } from "node:test";

import { Middleware } from "../index.js";

class CustomMiddleware extends Middleware {
  public i = 0;
  public run(): void {
    this.i += 1;
  }
}

suite("Middleware", () => {
  test("constructor (default values)", () => {
    const middleware = new CustomMiddleware();
    deepStrictEqual(middleware.disabled, false);
    deepStrictEqual(middleware.ignore_errors, false);
  });

  test("constructor (disabled)", () => {
    const middleware = new CustomMiddleware({ disabled: true });
    deepStrictEqual(middleware.disabled, true);
    middleware.disabled = false;
    deepStrictEqual(middleware.disabled, false);
    deepStrictEqual(middleware.ignore_errors, false);
  });

  test("constructor (ignore errors)", () => {
    const middleware = new CustomMiddleware({ ignore_errors: true });
    deepStrictEqual(middleware.ignore_errors, true);
    middleware.ignore_errors = false;
    deepStrictEqual(middleware.ignore_errors, false);
    deepStrictEqual(middleware.disabled, false);
  });

  test("constructor (invalid options)", () => {
    throws(
      () => new CustomMiddleware({ disabled: 1 as unknown as boolean }),
      new TypeError("`disabled` is not a boolean"),
    );
    throws(
      () => new CustomMiddleware({ ignore_errors: "no" as unknown as boolean }),
      new TypeError("`ignore_errors` is not a boolean"),
    );
  });

  test("constructor (ignore errors and disabled)", () => {
    const middleware = new CustomMiddleware({
      disabled: true,
      ignore_errors: true,
    });
    deepStrictEqual(middleware.disabled, true);
    deepStrictEqual(middleware.ignore_errors, true);
    middleware.disabled = false;
    deepStrictEqual(middleware.disabled, false);
    middleware.ignore_errors = false;
    deepStrictEqual(middleware.ignore_errors, false);
  });
});
