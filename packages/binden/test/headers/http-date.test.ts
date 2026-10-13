import { deepStrictEqual } from "node:assert";
import { suite, test } from "node:test";

import { parseHttpDate } from "../../src/headers/http-date.js";

suite("HTTP-date", () => {
  const expected = new Date(Date.UTC(1994, 10, 6, 8, 49, 37));

  test("the three formats (RFC 9110, section 5.6.7)", () => {
    deepStrictEqual(parseHttpDate("Sun, 06 Nov 1994 08:49:37 GMT"), expected);
    deepStrictEqual(
      parseHttpDate("Sunday, 06-Nov-94 08:49:37 GMT", Date.UTC(2026, 0)),
      expected,
    );
    // In UTC, not local time
    deepStrictEqual(parseHttpDate("Sun Nov  6 08:49:37 1994"), expected);
    deepStrictEqual(
      parseHttpDate("Thu Nov 17 08:49:37 1994"),
      new Date(Date.UTC(1994, 10, 17, 8, 49, 37)),
    );
  });

  test("a two-digit year is at most 50 years in the future", () => {
    const now = Date.UTC(2026, 0);
    deepStrictEqual(
      parseHttpDate("Monday, 06-Nov-76 08:49:37 GMT", now)?.getUTCFullYear(),
      2076,
    );
    deepStrictEqual(
      parseHttpDate("Monday, 06-Nov-77 08:49:37 GMT", now)?.getUTCFullYear(),
      1977,
    );
  });

  test("anything else", () => {
    for (const input of [
      "",
      "3000",
      "2015-10-21T07:28:00Z",
      "Sun, 06 Nov 1994 08:49:37 UTC",
      "sun, 06 Nov 1994 08:49:37 GMT",
      "Sun, 06 nov 1994 08:49:37 GMT",
      "Sun, 06 Foo 1994 08:49:37 GMT",
      "Sun, 6 Nov 1994 08:49:37 GMT",
      "Sun, 30 Feb 1994 08:49:37 GMT",
      "Sun, 06 Nov 1994 24:00:00 GMT",
      "Sun, 06 Nov 0099 08:49:37 GMT",
      " Sun, 06 Nov 1994 08:49:37 GMT",
    ]) {
      deepStrictEqual(parseHttpDate(input), null, JSON.stringify(input));
    }
  });
});
