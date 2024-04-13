import { deepEqual, ok, throws } from "node:assert/strict";
import { describe, it } from "node:test";

import { ContentRange } from "../../index.js";

describe("ContentRange", () => {
  it("constructor", () => {
    const start = 0;
    const end = 499;
    const size = 500;
    const range = new ContentRange({ start, end, size });
    deepEqual(range.end, end);
    deepEqual(range.start, start);
    deepEqual(range.size, size);
    deepEqual(range.unit, "bytes");
    deepEqual(range.toString(), `bytes ${start}-${end}/${size}`);
  });

  it("constructor (with errors)", () => {
    const size = 500;
    throws(
      () => new ContentRange({ size, start: 1.5 }),
      new TypeError("`start` is not an integer"),
    );
    throws(
      () => new ContentRange({ size, start: -1 }),
      new TypeError("`start` is less than zero"),
    );
    throws(
      () => new ContentRange({ size, end: 1.5 }),
      new TypeError("`end` is not an integer"),
    );
    throws(
      () => new ContentRange({ size, end: -1 }),
      new TypeError("`end` is less than zero"),
    );
    throws(
      () => new ContentRange({ size: 1.5 }),
      new TypeError("`size` is not an integer"),
    );
    throws(
      () => new ContentRange({ size: 0 }),
      new TypeError("`size` is less than zero"),
    );
    throws(
      () => new ContentRange({ size, end: size }),
      new TypeError("`end` is greater than `size`"),
    );
    throws(
      () => new ContentRange({ size, end: 499 }),
      new TypeError("`start` is missing"),
    );
    throws(
      () => new ContentRange({ size, start: 0 }),
      new TypeError("`end` is missing"),
    );
    throws(
      () => new ContentRange({ size, start: 499, end: 0 }),
      new TypeError("`end` is less than `start`"),
    );
  });

  it("constructor (unknown size)", () => {
    const start = 0;
    const end = 499;
    const size = "*";
    const range = new ContentRange({ start, end, size });
    deepEqual(range.end, end);
    deepEqual(range.start, start);
    deepEqual(range.size, size);
    deepEqual(range.unit, "bytes");
    deepEqual(range.toString(), `bytes ${start}-${end}/${size}`);
  });

  it("constructor (no range)", () => {
    const size = 500;
    const range = new ContentRange({ size });
    deepEqual(range.end, null);
    deepEqual(range.start, null);
    deepEqual(range.size, size);
    deepEqual(range.unit, "bytes");
    deepEqual(range.toString(), `bytes */${size}`);
  });

  it(".fromString() (invalid input)", () => {
    deepEqual(ContentRange.fromString(), []);
    deepEqual(ContentRange.fromString(""), []);
    deepEqual(ContentRange.fromString("   "), []);
    deepEqual(ContentRange.fromString("bytes */*"), []);
    deepEqual(ContentRange.fromString("bytes 1-0/500"), []);
    deepEqual(ContentRange.fromString("bytes 1-1000/500"), []);
  });

  it(".fromString()", () => {
    const input = "bytes  200  -  1000   /    67589   / 1 __ignored__ 1";
    const cr = new ContentRange({ start: 200, end: 1000, size: 67589 });
    const parsed = ContentRange.fromString(input);
    const [actual] = parsed;
    ok(actual);
    deepEqual(actual.end, cr.end);
    deepEqual(actual.start, cr.start);
    deepEqual(actual.size, cr.size);
    deepEqual(actual.toString(), cr.toString());
  });

  it(".fromString() (unknown size)", () => {
    const input = "bytes 200-1000/*";
    const cr = new ContentRange({ start: 200, end: 1000, size: "*" });
    const parsed = ContentRange.fromString(input);
    const [actual] = parsed;
    ok(actual);
    deepEqual(actual.end, cr.end);
    deepEqual(actual.start, cr.start);
    deepEqual(actual.size, cr.size);
    deepEqual(actual.toString(), cr.toString());
  });

  it(".fromString() (unknown range)", () => {
    const input = "bytes */500";
    const cr = new ContentRange({ size: 500 });
    const parsed = ContentRange.fromString(input);
    const [actual] = parsed;
    ok(actual);
    deepEqual(actual.end, cr.end);
    deepEqual(actual.start, cr.start);
    deepEqual(actual.size, cr.size);
    deepEqual(actual.toString(), cr.toString());
  });
});
