import { deepEqual } from "node:assert/strict";

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
    deepEqual(middleware.disabled, false);
    deepEqual(middleware.ignore_errors, false);
  });

  test("constructor (disabled)", () => {
    const middleware = new CustomMiddleware({ disabled: true });
    deepEqual(middleware.disabled, true);
    middleware.disabled = false;
    deepEqual(middleware.disabled, false);
    deepEqual(middleware.ignore_errors, false);
  });

  test("constructor (ignore errors)", () => {
    const middleware = new CustomMiddleware({ ignore_errors: true });
    deepEqual(middleware.ignore_errors, true);
    middleware.ignore_errors = false;
    deepEqual(middleware.ignore_errors, false);
    deepEqual(middleware.disabled, false);
  });

  test("constructor (ignore errors and disabled)", () => {
    const middleware = new CustomMiddleware({
      disabled: true,
      ignore_errors: true,
    });
    deepEqual(middleware.disabled, true);
    deepEqual(middleware.ignore_errors, true);
    middleware.disabled = false;
    deepEqual(middleware.disabled, false);
    middleware.ignore_errors = false;
    deepEqual(middleware.ignore_errors, false);
  });
});
