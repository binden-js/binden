import { deepStrictEqual, throws } from "node:assert";
import { STATUS_CODES } from "node:http";

import { KauaiError } from "../index.js";

suite("KauaiError", () => {
  test("constructor", () => {
    const expose = false;
    const message = "Something bad happened";
    const status = 500;
    const error = new KauaiError(status, { message });
    deepStrictEqual(error.expose, expose);
    deepStrictEqual(error.status, status);
    deepStrictEqual(error.json, null);
    deepStrictEqual(error.message, message);
    deepStrictEqual(error.name, "KauaiError");
  });

  test("constructor (json)", () => {
    const json = { error: "Something bad happened" };
    const expose = true;
    const status = 400;
    const error = new KauaiError(status, { json, expose });
    deepStrictEqual(error.expose, expose);
    deepStrictEqual(error.status, status);
    deepStrictEqual(error.json, json);
    deepStrictEqual(error.message, STATUS_CODES[status]);
    deepStrictEqual(error.name, "KauaiError");
  });

  test("constructor (with invalid status)", () => {
    throws(
      () => new KauaiError(300),
      new RangeError("Status code is less than 400")
    );
    throws(
      () => new KauaiError(600),
      new RangeError("Status code is greater than 599")
    );
    throws(() => new KauaiError(499), new TypeError("Invalid status code"));
  });
});
