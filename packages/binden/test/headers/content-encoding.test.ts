import { ContentEncoding, type IEncodings } from "../../index.js";
import { deepStrictEqual, throws } from "node:assert";
import { suite, test } from "node:test";

suite("ContentEncoding", () => {
  test("constructor", () => {
    const encoding = "br";
    const ac = new ContentEncoding({ encoding });
    deepStrictEqual(ac.encoding, encoding);
    deepStrictEqual(ac.toString(), encoding);
  });

  test("constructor (invalid input)", () => {
    // Like the parser: a known coding (in lowercase)
    for (const encoding of ["identity", "GZIP", "gzip, br", "*", ""]) {
      throws(
        () => new ContentEncoding({ encoding: encoding as IEncodings }),
        new TypeError(`Unknown content coding: ${encoding}`),
      );
    }
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
    // RFC 8878
    deepStrictEqual(parse("gzip, Zstd"), ["zstd", "gzip"]);
    deepStrictEqual(
      new ContentEncoding({ encoding: "zstd" }).toString(),
      "zstd",
    );
    // An unknown or malformed coding: the content cannot be decoded
    for (const input of ["gzip, ignored", "gzip;q=1", "gzip br", "identity"]) {
      deepStrictEqual(parse(input), null, input);
    }
  });
});
