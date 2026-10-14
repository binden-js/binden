import { deepStrictEqual, throws } from "node:assert";
import { suite, test } from "node:test";

import { Range } from "../../index.js";

suite("Range", () => {
  test("constructor", () => {
    const start = 0;
    const end = 499;
    const range = new Range({ start, end });
    deepStrictEqual(range.end, end);
    deepStrictEqual(range.start, start);
    deepStrictEqual(range.unit, "bytes");
    deepStrictEqual(range.toString(), `bytes=${start}-${end}`);
  });

  test("constructor (no `start`)", () => {
    const range = new Range({ end: 500 });
    deepStrictEqual(range.start, null);
    deepStrictEqual(range.end, 500);
    deepStrictEqual(range.toString(), "bytes=-500");
  });

  test("constructor (no `end`)", () => {
    const range = new Range({ start: 0 });
    deepStrictEqual(range.start, 0);
    deepStrictEqual(range.end, null);
    deepStrictEqual(range.toString(), "bytes=0-");
  });

  test("constructor (invalid ranges)", () => {
    for (const [range, message] of [
      [{ start: 0.1, end: 500 }, "`start` is not a non-negative integer"],
      [{ start: -1 }, "`start` is not a non-negative integer"],
      [{ start: 0, end: 499.9 }, "`end` is not a non-negative integer"],
      [{ end: Number.NaN }, "`end` is not a non-negative integer"],
      [{ start: 2 ** 53 }, "`start` is not a non-negative integer"],
      [{}, "A range has a `start` or an `end`"],
      [{ start: 5, end: 1 }, "`end` is less than `start`"],
    ] as const) {
      throws(() => new Range(range), new TypeError(message));
    }
  });

  test(".fromString()", () => {
    deepStrictEqual(Range.fromString(), []);
    deepStrictEqual(Range.fromString(" "), []);
    deepStrictEqual(Range.fromString("bytes= -"), []);

    const input = "bytes= 200 - 1000 , 2000 - 6576 , 19000 - ,__unsupported__";

    const first = new Range({ start: 200, end: 1000 });
    const second = new Range({ start: 2000, end: 6576 });
    const third = new Range({ start: 19000 });

    const parsed = Range.fromString(input);

    deepStrictEqual(parsed.length, 3);

    const [one, two, three] = parsed;

    deepStrictEqual(one.end, first.end);
    deepStrictEqual(one.start, first.start);
    deepStrictEqual(one.toString(), first.toString());

    deepStrictEqual(two.end, second.end);
    deepStrictEqual(two.start, second.start);
    deepStrictEqual(two.toString(), second.toString());

    deepStrictEqual(three.end, third.end);
    deepStrictEqual(three.start, third.start);
    deepStrictEqual(three.toString(), third.toString());
  });

  test(".fromString() (no start)", () => {
    const input = "bytes= -500";

    const range = new Range({ end: 500 });

    const parsed = Range.fromString(input);

    deepStrictEqual(parsed.length, 1);

    const [actual] = parsed;

    deepStrictEqual(actual.end, range.end);
    deepStrictEqual(actual.start, range.start);
    deepStrictEqual(actual.toString(), range.toString());
  });

  test(".fromString() (RFC 9110, section 14.1.1)", () => {
    const parse = (input: string): string[] =>
      Range.fromString(input).map((range) => range.toString());

    // The unit is case-insensitive
    deepStrictEqual(parse("Bytes=0-1"), ["bytes=0-1"]);
    // Valid, although it cannot be satisfied
    deepStrictEqual(parse("bytes=-0"), ["bytes=-0"]);
    deepStrictEqual(parse("bytes=\t0-1 , 5-\t"), ["bytes=0-1", "bytes=5-"]);
    // Only plain digits, no control characters
    for (const input of [
      "bytes=0-\r\n1",
      "bytes=\r\n0-1",
      "\r\nbytes=0-1\r\n",
      "bytes=\u00a00-\u00a01",
      "bytes=0x0-0x10",
      "bytes=1e2-",
      "bytes=+5-",
      "bytes=1.5-2",
      "bytes=5-10.5",
      "bytes=0-1-2",
      "bytes=Infinity-",
      "bytes=99999999999999999999-",
      "bytes=-99999999999999999999",
    ]) {
      deepStrictEqual(parse(input), [], JSON.stringify(input));
    }
  });
});
