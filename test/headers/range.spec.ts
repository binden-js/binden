import { deepStrictEqual } from "assert";

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
    const start = 0.1;
    const end = 500;
    const range = new Range({ start, end });
    deepStrictEqual(range.end, end);
    deepStrictEqual(typeof range.start, "undefined");
    deepStrictEqual(range.unit, "bytes");
    deepStrictEqual(range.toString(), `bytes=-${end}`);
  });

  test("constructor (no `end`)", () => {
    const end = 499.9;
    const start = 0;
    const range = new Range({ start, end });
    deepStrictEqual(range.start, start);
    deepStrictEqual(typeof range.end, "undefined");
    deepStrictEqual(range.unit, "bytes");
    deepStrictEqual(range.toString(), `bytes=${start}-`);
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
});
