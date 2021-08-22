import { deepStrictEqual, ok } from "node:assert";

import { IfModifiedSince } from "../../index.js";

suite("If-Modified-Since", () => {
  test("constructor", () => {
    const date = new Date();
    const ac = new IfModifiedSince({ date });
    deepStrictEqual(ac.date, date);
    deepStrictEqual(ac.toString(), date.toUTCString());
  });

  test("constructor (invalid Date)", () => {
    const input = "invalid";
    const date = new Date(input);
    const ac = new IfModifiedSince({ date });
    deepStrictEqual(ac.date.getTime(), NaN);
    deepStrictEqual(ac.toString(), "Invalid Date");
  });

  test("IfModifiedSince.fromString()", () => {
    deepStrictEqual(IfModifiedSince.fromString(), null);
    deepStrictEqual(IfModifiedSince.fromString(""), null);
    deepStrictEqual(IfModifiedSince.fromString("notadate"), null);
    const input = "    Wed, 21 Oct 2015 07:28:00 GMT   ";
    const parsed = IfModifiedSince.fromString(input);
    ok(parsed);
    deepStrictEqual(parsed.date, new Date(input.trim()));
    deepStrictEqual(parsed.toString(), new Date(input.trim()).toUTCString());
  });
});
