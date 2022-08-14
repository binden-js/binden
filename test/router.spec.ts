import { deepStrictEqual, throws } from "node:assert";

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

suite("Router", () => {
  test("constructor", () => {
    const router = new Router();
    deepStrictEqual(router.guarded, false);
    deepStrictEqual(typeof router.middlewares, "function");
    deepStrictEqual(router.methods, new Set());
  });

  test("constructor (`guarded === true`)", () => {
    const guarded = true;
    const router = new Router({ guarded });
    deepStrictEqual(router.guarded, guarded);
    deepStrictEqual(router.middlewares("GET"), []);
    deepStrictEqual(router.methods, new Set());

    router.guarded = null;
    deepStrictEqual(router.guarded, false);

    router.guarded = 1;
    deepStrictEqual(router.guarded, true);
  });

  test(".on()", () => {
    const router = new Router()
      .on("UNSUBSCRIBE", one)
      .on("GET", three)
      .on("UNSUBSCRIBE", two);

    deepStrictEqual(router.middlewares("GET"), [three]);
    deepStrictEqual(router.middlewares("UNSUBSCRIBE"), [one, two]);
    deepStrictEqual(router.methods, new Set(["UNSUBSCRIBE", "GET"]));
  });

  test(".on() (with unsupported method)", () => {
    const unsupportedMethod = "_unsupported_";
    throws(
      () => new Router().on(unsupportedMethod),
      new TypeError(`Method ${unsupportedMethod} is not supported`)
    );
  });

  test(".on() (with unsupported middleware)", () => {
    throws(
      () => new Router().on("GET", {} as Middleware),
      new TypeError("Middleware is not supported")
    );
  });

  test(".off()", () => {
    const router = new Router().on("UNSUBSCRIBE", one, two).on("GET", three);

    deepStrictEqual(router.off("GET", one, two), []);
    deepStrictEqual(router.middlewares("GET"), [three]);
    deepStrictEqual(router.middlewares("UNSUBSCRIBE"), [one, two]);
    deepStrictEqual(router.methods, new Set(["UNSUBSCRIBE", "GET"]));

    deepStrictEqual(router.off("UNSUBSCRIBE"), []);
    deepStrictEqual(router.middlewares("GET"), [three]);
    deepStrictEqual(router.middlewares("UNSUBSCRIBE"), [one, two]);
    deepStrictEqual(router.methods, new Set(["UNSUBSCRIBE", "GET"]));

    deepStrictEqual(router.off("UNSUBSCRIBE", one), [one]);
    deepStrictEqual(router.middlewares("GET"), [three]);
    deepStrictEqual(router.middlewares("UNSUBSCRIBE"), [two]);
    deepStrictEqual(router.methods, new Set(["UNSUBSCRIBE", "GET"]));

    deepStrictEqual(router.off("UNSUBSCRIBE", two), [two]);
    deepStrictEqual(router.middlewares("GET"), [three]);
    deepStrictEqual(router.middlewares("UNSUBSCRIBE"), []);
    deepStrictEqual(router.methods, new Set(["GET"]));

    deepStrictEqual(router.off("GET", three), [three]);
    deepStrictEqual(router.middlewares("GET"), []);
    deepStrictEqual(router.middlewares("UNSUBSCRIBE"), []);
    deepStrictEqual(router.methods, new Set());

    deepStrictEqual(router.off("GET", three), []);
    deepStrictEqual(router.middlewares("GET"), []);
    deepStrictEqual(router.middlewares("UNSUBSCRIBE"), []);
    deepStrictEqual(router.methods, new Set());

    const method = "unsupported";

    throws(() => {
      router.off(method);
    }, new TypeError(`Method ${method} is not supported`));
  });

  for (const method of methods) {
    test(`.${method}()`, () => {
      const router = new Router()[method](one, two, three);
      deepStrictEqual(router.middlewares(method), [one, two, three]);
      deepStrictEqual(router.methods, new Set([method.toUpperCase()]));
    });
  }
});
