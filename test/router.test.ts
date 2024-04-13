import { deepEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { Router, Middleware } from "../index.js";

class CustomMiddleware extends Middleware {
  public i = 0;
  public run(): void {
    this.i += 1;
  }
}

const one = new CustomMiddleware();
const two = new CustomMiddleware();
const three = new CustomMiddleware();

const methods = [
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "trace",
] as const;

describe("Router", () => {
  it("constructor", () => {
    const router = new Router();
    deepEqual(router.guarded, false);
    deepEqual(typeof router.middlewares, "function");
    deepEqual(router.methods, new Set());
  });

  it("constructor (`guarded === true`)", () => {
    const guarded = true;
    const router = new Router({ guarded });
    deepEqual(router.guarded, guarded);
    deepEqual(router.middlewares("GET"), []);
    deepEqual(router.methods, new Set());

    router.guarded = null;
    deepEqual(router.guarded, false);

    router.guarded = 1;
    deepEqual(router.guarded, true);
  });

  it(".on()", () => {
    const router = new Router()
      .on("HEAD")
      .on("UNSUBSCRIBE", one)
      .on("GET", three)
      .on("UNSUBSCRIBE", two);

    deepEqual(router.middlewares("GET"), [three]);
    deepEqual(router.middlewares("HEAD"), []);
    deepEqual(router.middlewares("UNSUBSCRIBE"), [one, two]);
    deepEqual(router.methods, new Set(["UNSUBSCRIBE", "GET"]));
  });

  it(".on() (with unsupported method)", () => {
    const unsupportedMethod = "_unsupported_";
    throws(
      () => new Router().on(unsupportedMethod),
      new TypeError(`Method ${unsupportedMethod} is not supported`),
    );
  });

  it(".on() (with unsupported middleware)", () => {
    throws(
      () => new Router().on("GET", {} as Middleware),
      new TypeError("Middleware is not supported"),
    );
  });

  it(".off()", () => {
    const router = new Router().on("UNSUBSCRIBE", one, two).on("GET", three);

    deepEqual(router.off("GET", one, two), []);
    deepEqual(router.middlewares("GET"), [three]);
    deepEqual(router.middlewares("UNSUBSCRIBE"), [one, two]);
    deepEqual(router.methods, new Set(["UNSUBSCRIBE", "GET"]));

    deepEqual(router.off("UNSUBSCRIBE"), []);
    deepEqual(router.middlewares("GET"), [three]);
    deepEqual(router.middlewares("UNSUBSCRIBE"), [one, two]);
    deepEqual(router.methods, new Set(["UNSUBSCRIBE", "GET"]));

    deepEqual(router.off("UNSUBSCRIBE", one), [one]);
    deepEqual(router.middlewares("GET"), [three]);
    deepEqual(router.middlewares("UNSUBSCRIBE"), [two]);
    deepEqual(router.methods, new Set(["UNSUBSCRIBE", "GET"]));

    deepEqual(router.off("UNSUBSCRIBE", two), [two]);
    deepEqual(router.middlewares("GET"), [three]);
    deepEqual(router.middlewares("UNSUBSCRIBE"), []);
    deepEqual(router.methods, new Set(["GET"]));

    deepEqual(router.off("GET", three), [three]);
    deepEqual(router.middlewares("GET"), []);
    deepEqual(router.middlewares("UNSUBSCRIBE"), []);
    deepEqual(router.methods, new Set());

    deepEqual(router.off("GET", three), []);
    deepEqual(router.middlewares("GET"), []);
    deepEqual(router.middlewares("UNSUBSCRIBE"), []);
    deepEqual(router.methods, new Set());

    const method = "unsupported";

    throws(
      () => {
        router.off(method);
      },
      new TypeError(`Method ${method} is not supported`),
    );
  });

  for (const method of methods) {
    it(`.${method}()`, () => {
      const router = new Router()[method](one, two, three);
      deepEqual(router.middlewares(method), [one, two, three]);
      deepEqual(router.methods, new Set([method.toUpperCase()]));
    });
  }
});
