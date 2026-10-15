import { AcceptEncoding, Authorization, Range } from "../../index.js";
import { deepStrictEqual, ok } from "node:assert";
import { suite, test } from "node:test";

/** The milliseconds that `fn` takes */
function duration(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

/**
 * The length of a header that Node.js accepts (`maxHeaderSize`, 16 KiB): a
 * parser that backtracks polynomially on it takes hundreds of milliseconds
 */
const length = 15_000;

/** A bound far above a linear parse, far below a quadratic one */
const bound = 100;

suite("Header parsers in linear time", () => {
  test("Authorization: a scheme followed by a long run of spaces", () => {
    // A line terminator, which `.` does not match, after the spaces
    const input = `! ${" ".repeat(length)}\u2028x`;
    ok(duration(() => Authorization.fromString(input)) < bound);
    deepStrictEqual(Authorization.fromString(input), null);
    deepStrictEqual(
      Authorization.fromString("Basic   abc")?.toString(),
      "Basic abc",
    );
  });

  test("Range: long runs of tabs around an empty position", () => {
    for (const input of [
      `bytes=${"\t".repeat(length)}x`,
      `bytes=-${"\t".repeat(length)}x`,
    ]) {
      ok(duration(() => Range.fromString(input)) < bound);
      deepStrictEqual(Range.fromString(input), []);
    }
    deepStrictEqual(Range.fromString("bytes= \t1 - 2 \t, \t-5").map(String), [
      "bytes=1-2",
      "bytes=-5",
    ]);
  });

  test("Accept-Encoding: a weight followed by a long run of spaces", () => {
    const input = `gzip;q=${" ".repeat(length)}x`;
    ok(duration(() => AcceptEncoding.fromString(input)) < bound);
    deepStrictEqual(AcceptEncoding.fromString(input), []);
    deepStrictEqual(AcceptEncoding.fromString("gzip; Q = 0.5").map(String), [
      "gzip;q=0.5",
    ]);
  });
});
