import { deepEqual } from "node:assert/strict";

import { Range } from "../../index.js";

suite("Range", () => {
  test("constructor", () => {
    const start = 0;
    const end = 499;
    const range = new Range({ start, end });
    deepEqual(range.end, end);
    deepEqual(range.start, start);
    deepEqual(range.unit, "bytes");
    deepEqual(range.toString(), `bytes=${start}-${end}`);
  });

  test("constructor (no `start`)", () => {
    const start = 0.1;
    const end = 500;
    const range = new Range({ start, end });
    deepEqual(range.end, end);
    deepEqual(range.start, null);
    deepEqual(range.unit, "bytes");
    deepEqual(range.toString(), `bytes=-${end}`);
  });

  test("constructor (no `end`)", () => {
    const end = 499.9;
    const start = 0;
    const range = new Range({ start, end });
    deepEqual(range.start, start);
    deepEqual(range.end, null);
    deepEqual(range.unit, "bytes");
    deepEqual(range.toString(), `bytes=${start}-`);
  });

  test(".fromString()", () => {
    deepEqual(Range.fromString(), []);
    deepEqual(Range.fromString(" "), []);
    deepEqual(Range.fromString("bytes= -"), []);

    const input = "bytes= 200 - 1000 , 2000 - 6576 , 19000 - ,__unsupported__";

    const first = new Range({ start: 200, end: 1000 });
    const second = new Range({ start: 2000, end: 6576 });
    const third = new Range({ start: 19000 });

    const parsed = Range.fromString(input);

    deepEqual(parsed.length, 3);

    const [one, two, three] = parsed;

    deepEqual(one.end, first.end);
    deepEqual(one.start, first.start);
    deepEqual(one.toString(), first.toString());

    deepEqual(two.end, second.end);
    deepEqual(two.start, second.start);
    deepEqual(two.toString(), second.toString());

    deepEqual(three.end, third.end);
    deepEqual(three.start, third.start);
    deepEqual(three.toString(), third.toString());
  });

  test(".fromString() (no start)", () => {
    const input = "bytes= -500";

    const range = new Range({ end: 500 });

    const parsed = Range.fromString(input);

    deepEqual(parsed.length, 1);

    const [actual] = parsed;

    deepEqual(actual.end, range.end);
    deepEqual(actual.start, range.start);
    deepEqual(actual.toString(), range.toString());
  });
});
