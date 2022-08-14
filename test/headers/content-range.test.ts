import { deepStrictEqual, ok, throws } from "node:assert";

import { ContentRange } from "../../index.js";

suite("ContentRange", () => {
  test("constructor", () => {
    const start = 0;
    const end = 499;
    const size = 500;
    const range = new ContentRange({ start, end, size });
    deepStrictEqual(range.end, end);
    deepStrictEqual(range.start, start);
    deepStrictEqual(range.size, size);
    deepStrictEqual(range.unit, "bytes");
    deepStrictEqual(range.toString(), `bytes ${start}-${end}/${size}`);
  });

  test("constructor (with errors)", () => {
    const size = 500;
    throws(
      () => new ContentRange({ size, start: 1.5 }),
      new TypeError("`start` is not an integer")
    );
    throws(
      () => new ContentRange({ size, start: -1 }),
      new TypeError("`start` is less than zero")
    );
    throws(
      () => new ContentRange({ size, end: 1.5 }),
      new TypeError("`end` is not an integer")
    );
    throws(
      () => new ContentRange({ size, end: -1 }),
      new TypeError("`end` is less than zero")
    );
    throws(
      () => new ContentRange({ size: 1.5 }),
      new TypeError("`size` is not an integer")
    );
    throws(
      () => new ContentRange({ size: 0 }),
      new TypeError("`size` is less than zero")
    );
    throws(
      () => new ContentRange({ size, end: size }),
      new TypeError("`end` is greater than `size`")
    );
    throws(
      () => new ContentRange({ size, end: 499 }),
      new TypeError("`start` is missing")
    );
    throws(
      () => new ContentRange({ size, start: 0 }),
      new TypeError("`end` is missing")
    );
    throws(
      () => new ContentRange({ size, start: 499, end: 0 }),
      new TypeError("`end` is less than `start`")
    );
  });

  test("constructor (unknown size)", () => {
    const start = 0;
    const end = 499;
    const size = "*";
    const range = new ContentRange({ start, end, size });
    deepStrictEqual(range.end, end);
    deepStrictEqual(range.start, start);
    deepStrictEqual(range.size, size);
    deepStrictEqual(range.unit, "bytes");
    deepStrictEqual(range.toString(), `bytes ${start}-${end}/${size}`);
  });

  test("constructor (no range)", () => {
    const size = 500;
    const range = new ContentRange({ size });
    deepStrictEqual(typeof range.end, "undefined");
    deepStrictEqual(typeof range.start, "undefined");
    deepStrictEqual(range.size, size);
    deepStrictEqual(range.unit, "bytes");
    deepStrictEqual(range.toString(), `bytes */${size}`);
  });

  test(".fromString() (invalid input)", () => {
    deepStrictEqual(ContentRange.fromString(), []);
    deepStrictEqual(ContentRange.fromString(""), []);
    deepStrictEqual(ContentRange.fromString("   "), []);
    deepStrictEqual(ContentRange.fromString("bytes */*"), []);
    deepStrictEqual(ContentRange.fromString("bytes 1-0/500"), []);
    deepStrictEqual(ContentRange.fromString("bytes 1-1000/500"), []);
  });

  test(".fromString()", () => {
    const input = "bytes  200  -  1000   /    67589   / 1 __ignored__ 1";
    const cr = new ContentRange({ start: 200, end: 1000, size: 67589 });
    const parsed = ContentRange.fromString(input);
    const [actual] = parsed;
    ok(actual);
    deepStrictEqual(actual.end, cr.end);
    deepStrictEqual(actual.start, cr.start);
    deepStrictEqual(actual.size, cr.size);
    deepStrictEqual(actual.toString(), cr.toString());
  });

  test(".fromString() (unknown size)", () => {
    const input = "bytes 200-1000/*";
    const cr = new ContentRange({ start: 200, end: 1000, size: "*" });
    const parsed = ContentRange.fromString(input);
    const [actual] = parsed;
    ok(actual);
    deepStrictEqual(actual.end, cr.end);
    deepStrictEqual(actual.start, cr.start);
    deepStrictEqual(actual.size, cr.size);
    deepStrictEqual(actual.toString(), cr.toString());
  });

  test(".fromString() (unknown range)", () => {
    const input = "bytes */500";
    const cr = new ContentRange({ size: 500 });
    const parsed = ContentRange.fromString(input);
    const [actual] = parsed;
    ok(actual);
    deepStrictEqual(actual.end, cr.end);
    deepStrictEqual(actual.start, cr.start);
    deepStrictEqual(actual.size, cr.size);
    deepStrictEqual(actual.toString(), cr.toString());
  });
});
