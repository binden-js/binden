import { deepEqual, ok, throws } from "node:assert/strict";
import { STATUS_CODES } from "node:http";

import { BindenError } from "../index.js";

suite("BindenError", () => {
  test("constructor", () => {
    const expose = false;
    const message = "Something bad happened";
    const status = 500;
    const error = new BindenError(status, { message });
    deepEqual(error.expose, expose);
    deepEqual(error.status, status);
    deepEqual(error.json, null);
    deepEqual(error.message, message);
    deepEqual(error.name, "BindenError");
    ok(typeof error.cause === "undefined");
  });

  test("constructor (with `cause`)", () => {
    const expose = false;
    const message = "Something bad happened";
    const status = 500;
    const cause = new Error("Socket has been closed");
    const error = new BindenError(status, { message, cause });
    deepEqual(error.expose, expose);
    deepEqual(error.status, status);
    deepEqual(error.json, null);
    deepEqual(error.message, message);
    deepEqual(error.name, "BindenError");
    deepEqual(error.cause, cause);
  });

  test("constructor (json)", () => {
    const json = { error: "Something bad happened" };
    const expose = true;
    const status = 400;
    const error = new BindenError(status, { json, expose });
    deepEqual(error.expose, expose);
    deepEqual(error.status, status);
    deepEqual(error.json, json);
    deepEqual(error.message, STATUS_CODES[status]);
    deepEqual(error.name, "BindenError");
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
    throws(() => new BindenError(499), new TypeError("Invalid status code"));
  });
});
