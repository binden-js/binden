import { deepStrictEqual } from "node:assert";
import { suite, test } from "node:test";

import { ContentEncoding } from "../../index.js";

suite("ContentEncoding", () => {
  test("constructor", () => {
    const encoding = "br";
    const ac = new ContentEncoding({ encoding });
    deepStrictEqual(ac.encoding, encoding);
    deepStrictEqual(ac.toString(), encoding);
  });

  test("ContentEncoding.fromString()", () => {
    const parse = (input?: string): string[] | null =>
      ContentEncoding.fromString(input)?.map((e) => e.toString()) ?? null;

    deepStrictEqual(parse(), []);
    deepStrictEqual(parse(""), []);
    // In the order to remove them; case-insensitive; empty elements ignored
    deepStrictEqual(parse(" x-gzip , BR ,, deflate "), [
      "deflate",
      "br",
      "x-gzip",
    ]);
    // An unknown or malformed coding: the content cannot be decoded
    for (const input of ["gzip, ignored", "gzip;q=1", "gzip br", "identity"]) {
      deepStrictEqual(parse(input), null, input);
    }
  });
});
