import { deepEqual, ok } from "node:assert/strict";

import { IfModifiedSince } from "../../index.js";

suite("If-Modified-Since", () => {
  test("constructor", () => {
    const date = new Date();
    const ac = new IfModifiedSince({ date });
    deepEqual(ac.date, date);
    deepEqual(ac.toString(), date.toUTCString());
  });

  test("constructor (invalid Date)", () => {
    const input = "invalid";
    const date = new Date(input);
    const ac = new IfModifiedSince({ date });
    deepEqual(ac.date.getTime(), NaN);
    deepEqual(ac.toString(), "Invalid Date");
  });

  test("IfModifiedSince.fromString()", () => {
    deepEqual(IfModifiedSince.fromString(), null);
    deepEqual(IfModifiedSince.fromString(""), null);
    deepEqual(IfModifiedSince.fromString("notadate"), null);
    const input = "    Wed, 21 Oct 2015 07:28:00 GMT   ";
    const parsed = IfModifiedSince.fromString(input);
    ok(parsed);
    deepEqual(parsed.date, new Date(input.trim()));
    deepEqual(parsed.toString(), new Date(input.trim()).toUTCString());
  });
});
