import { deepStrictEqual, throws } from "node:assert";
import { STATUS_CODES } from "node:http";

import { BindenError } from "../index.js";

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
      new RangeError("Status code is less than 400")
    );
    throws(
      () => new BindenError(600),
      new RangeError("Status code is greater than 599")
    );
    throws(() => new BindenError(499), new TypeError("Invalid status code"));
  });
});
