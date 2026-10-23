import { deepStrictEqual, ok, throws } from "node:assert";
import { suite, test } from "node:test";

import { IfModifiedSince } from "../../index.js";

suite("If-Modified-Since", () => {
  test("constructor", () => {
    const date = new Date();
    const ac = new IfModifiedSince({ date });
    deepStrictEqual(ac.date, date);
    deepStrictEqual(ac.toString(), date.toUTCString());
  });

  test("constructor (invalid Date)", () => {
    throws(
      () => new IfModifiedSince({ date: new Date("invalid") }),
      new TypeError("Invalid date"),
    );
    // Not an HTTP-date: a year out of 0..9999
    for (const year of [-1, 10000]) {
      const date = new Date(Date.UTC(2000, 0, 1));
      date.setUTCFullYear(year);
      throws(
        () => new IfModifiedSince({ date }),
        new TypeError("The date is not an HTTP-date"),
        `${year}`,
      );
    }
    for (const year of [0, 50, 99, 9999]) {
      const date = new Date(Date.UTC(2000, 0, 1));
      date.setUTCFullYear(year);
      const header = new IfModifiedSince({ date });
      deepStrictEqual(header.date, date);
      // Parsed back, also before the year 100
      deepStrictEqual(
        IfModifiedSince.fromString(header.toString())?.date,
        date,
      );
    }
  });

  test("IfModifiedSince.fromString()", () => {
    deepStrictEqual(IfModifiedSince.fromString(), null);
    deepStrictEqual(IfModifiedSince.fromString(""), null);
    deepStrictEqual(IfModifiedSince.fromString("notadate"), null);
    // Only an HTTP-date (`Date.parse()` reads "3000" as a year)
    deepStrictEqual(IfModifiedSince.fromString("3000"), null);
    const input = "    Wed, 21 Oct 2015 07:28:00 GMT   ";
    const parsed = IfModifiedSince.fromString(input);
    ok(parsed);
    deepStrictEqual(parsed.date, new Date(input.trim()));
    deepStrictEqual(parsed.toString(), new Date(input.trim()).toUTCString());
  });
});
