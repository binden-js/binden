import { deepStrictEqual } from "assert";

import { ContentEncoding } from "../../index.js";

suite("ContentEncoding", () => {
  test("constructor", () => {
    const encoding = "br";
    const ac = new ContentEncoding({ encoding });
    deepStrictEqual(ac.encoding, encoding);
    deepStrictEqual(ac.toString(), encoding);
  });

  test("ContentEncoding.fromString()", () => {
    const input = " x-gzip , br , deflate , ignored ";
    const parsed = ContentEncoding.fromString(input);
    deepStrictEqual(parsed.length, 3);

    deepStrictEqual(parsed[0].encoding, "deflate");
    deepStrictEqual(parsed[0].toString(), "deflate");

    deepStrictEqual(parsed[1].encoding, "br");
    deepStrictEqual(parsed[1].toString(), "br");

    deepStrictEqual(parsed[2].encoding, "x-gzip");
    deepStrictEqual(parsed[2].toString(), "x-gzip");
  });
});
