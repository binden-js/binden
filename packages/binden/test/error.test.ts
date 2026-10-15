import { BindenError, type IBindenErrorOptions } from "../index.js";
import { deepStrictEqual, ok, throws } from "node:assert";
import { suite, test } from "node:test";
import { STATUS_CODES } from "node:http";

suite("BindenError", () => {
  test("constructor", () => {
    const expose = false;
    const message = "Something bad happened";
    const status = 500;
    const error = new BindenError(status, { message });
    deepStrictEqual(error.expose, expose);
    deepStrictEqual(error.status, status);
    deepStrictEqual(error.json, null);
    deepStrictEqual(error.message, message);
    deepStrictEqual(error.name, "BindenError");
    ok(typeof error.cause === "undefined");
  });

  test("constructor (with `cause`)", () => {
    const expose = false;
    const message = "Something bad happened";
    const status = 500;
    const cause = new Error("Socket has been closed");
    const error = new BindenError(status, { message, cause });
    deepStrictEqual(error.expose, expose);
    deepStrictEqual(error.status, status);
    deepStrictEqual(error.json, null);
    deepStrictEqual(error.message, message);
    deepStrictEqual(error.name, "BindenError");
    deepStrictEqual(error.cause, cause);
  });

  test("constructor (json)", () => {
    const json = { error: "Something bad happened" };
    const expose = true;
    const status = 400;
    const error = new BindenError(status, { json, expose });
    deepStrictEqual(error.expose, expose);
    deepStrictEqual(error.status, status);
    deepStrictEqual(error.json, json);
    deepStrictEqual(error.message, STATUS_CODES[status]);
    deepStrictEqual(error.name, "BindenError");
  });

  test("constructor (with invalid status)", () => {
    throws(
      () => new BindenError(300),
      new RangeError("Status code is less than 400"),
    );
    throws(
      () => new BindenError(600),
      new RangeError("Status code is greater than 599"),
    );
    // Not an integer (e.g. a string from an untyped caller)
    for (const status of [400.5, Number.NaN, "400"]) {
      throws(
        () => new BindenError(status as number),
        new TypeError("Invalid status code"),
      );
    }
  });

  test("constructor (`code`)", () => {
    deepStrictEqual(
      new BindenError(503, { code: "deadline" }).code,
      "deadline",
    );
    deepStrictEqual(new BindenError(503).code, null);
    throws(
      () => new BindenError(503, { code: 1 as unknown as string }),
      new TypeError("`code` is not a string"),
    );
  });

  test("constructor (`headers`)", () => {
    const headers = {
      "Retry-After": "120",
      "WWW-Authenticate": ["Basic", "Bearer"],
    };
    const error = new BindenError(503, { headers });
    deepStrictEqual(error.headers, headers);
    // A frozen copy
    headers["Retry-After"] = "1";
    deepStrictEqual(error.headers["Retry-After"], "120");
    ok(Object.isFrozen(error.headers));
    ok(Object.isFrozen(error.headers["WWW-Authenticate"]));
    deepStrictEqual(new BindenError(400).headers, {});
  });

  test("constructor (invalid `headers`)", () => {
    const invalid: [unknown, string][] = [
      [null, "`headers` is not an object"],
      ["Allow: GET", "`headers` is not an object"],
      [["Allow", "GET"], "`headers` is not an object"],
      [{ "Bad Name": "x" }, "Invalid header name: Bad Name"],
      [{ "": "x" }, "Invalid header name: "],
      [{ "X-A": "x\r\nSet-Cookie: a=1" }, "Invalid value of the `X-A` header"],
      [{ "X-A": "x\n" }, "Invalid value of the `X-A` header"],
      [{ "X-A": "x\u0000" }, "Invalid value of the `X-A` header"],
      [{ "X-A": ["ok", "x\r"] }, "Invalid value of the `X-A` header"],
      [{ "X-A": 1 }, "Invalid value of the `X-A` header"],
      [{ "X-A": "a", "x-a": "b" }, "Duplicate header: x-a"],
    ];
    for (const name of [
      "Content-Length",
      "transfer-encoding",
      "Content-Encoding",
      "CONTENT-RANGE",
      "Content-Type",
      "Connection",
    ]) {
      invalid.push([
        { [name]: "x" },
        `The \`${name}\` header cannot be set by an error`,
      ]);
    }
    for (const [headers, message] of invalid) {
      throws(
        () =>
          new BindenError(400, {
            headers: headers as Record<string, string>,
          }),
        new TypeError(message),
      );
    }
  });

  test("constructor (invalid `expose`, `json` and `message`)", () => {
    const invalid: [IBindenErrorOptions, string][] = [
      [{ expose: "false" as unknown as boolean }, "`expose` is not a boolean"],
      [{ expose: 1 as unknown as boolean }, "`expose` is not a boolean"],
      [
        {
          expose: true,
          json: [{ field: "name" }] as unknown as Record<string, unknown>,
        },
        "`json` is not a plain object",
      ],
      [
        { json: "abc" as unknown as Record<string, unknown> },
        "`json` is not a plain object",
      ],
      [
        { json: null as unknown as Record<string, unknown> },
        "`json` is not a plain object",
      ],
      [
        { json: new Map() as unknown as Record<string, unknown> },
        "`json` is not a plain object",
      ],
      [{ message: 42 as unknown as string }, "`message` is not a string"],
      [{ message: null as unknown as string }, "`message` is not a string"],
    ];
    for (const [options, message] of invalid) {
      throws(() => new BindenError(400, options), new TypeError(message));
    }
    // A plain object without a prototype, and the defaults
    const json = Object.assign(Object.create(null) as object, { a: 1 });
    deepStrictEqual(new BindenError(400, { json, expose: true }).json, {
      a: 1,
    });
    // Options that are not set
    const unset: unknown = Reflect.get({}, "unset");
    const defaults = new BindenError(400, {
      expose: unset,
      json: unset,
      message: unset,
    } as IBindenErrorOptions);
    deepStrictEqual(
      [defaults.expose, defaults.json, defaults.message],
      [false, null, "Bad Request"],
    );
  });

  test("constructor (an unregistered status code)", () => {
    const error = new BindenError(499);
    deepStrictEqual(error.status, 499);
    deepStrictEqual(error.message, "");
  });
});
