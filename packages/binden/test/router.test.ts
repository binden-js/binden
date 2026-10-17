import { Middleware, Router } from "../index.js";
import { deepStrictEqual, throws } from "node:assert";
import { suite, test } from "node:test";

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
      .on("HEAD")
      .on("UNSUBSCRIBE", one)
      .on("GET", three)
      .on("UNSUBSCRIBE", two);

    deepStrictEqual(router.middlewares("GET"), [three]);
    deepStrictEqual(router.middlewares("HEAD"), []);
    deepStrictEqual(router.middlewares("UNSUBSCRIBE"), [one, two]);
    deepStrictEqual(router.methods, new Set(["UNSUBSCRIBE", "GET"]));
  });

  test(".on() (a method in any case)", () => {
    const router = new Router().on("get", one).on("Propfind", two);
    deepStrictEqual(router.methods, new Set(["GET", "PROPFIND"]));
    deepStrictEqual(router.middlewares("get"), [one]);
    deepStrictEqual(router.off("propfind", two), [two]);
    deepStrictEqual(router.methods, new Set(["GET"]));
  });

  test(".on() (with unsupported method)", () => {
    for (const method of ["", "GET POST", "a,b", "(x)", "GÉT", 1]) {
      throws(
        () => new Router().on(method as string, one),
        new TypeError(`Method ${String(method)} is not a valid token`),
      );
      throws(
        () => new Router().off(method as string, one),
        new TypeError(`Method ${String(method)} is not a valid token`),
      );
    }
    // Never reaches the middlewares (a `connect` event of the server)
    for (const method of ["CONNECT", "connect"]) {
      throws(
        () => new Router().on(method, one),
        new TypeError("Method CONNECT is not supported"),
      );
      throws(
        () => new Router().off(method, one),
        new TypeError("Method CONNECT is not supported"),
      );
    }
  });

  test("constructor (an invalid `guarded`)", () => {
    throws(
      () => new Router({ guarded: 1 as unknown as boolean }),
      new TypeError("`guarded` is not a boolean"),
    );
  });

  test(".on() (with unsupported middleware)", () => {
    throws(
      () => new Router().on("GET", {} as Middleware),
      new TypeError("Middleware is not supported"),
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

    throws(() => {
      router.off("not valid");
    }, new TypeError("Method not valid is not a valid token"));
  });

  for (const method of methods) {
    test(`.${method}()`, () => {
      const router = new Router()[method](one, two, three);
      deepStrictEqual(router.middlewares(method), [one, two, three]);
      deepStrictEqual(router.methods, new Set([method.toUpperCase()]));
    });
  }
});
