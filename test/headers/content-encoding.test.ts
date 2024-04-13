import { deepEqual } from "node:assert/strict";

import { ContentEncoding } from "../../index.js";

suite("ContentEncoding", () => {
  test("constructor", () => {
    const encoding = "br";
    const ac = new ContentEncoding({ encoding });
    deepEqual(ac.encoding, encoding);
    deepEqual(ac.toString(), encoding);
  });

  test("ContentEncoding.fromString()", () => {
    deepEqual(ContentEncoding.fromString(), []);
    deepEqual(ContentEncoding.fromString(""), []);
    const input = " x-gzip , br , deflate , ignored ";
    const parsed = ContentEncoding.fromString(input);
    deepEqual(parsed.length, 3);

    deepEqual(parsed[0].encoding, "deflate");
    deepEqual(parsed[0].toString(), "deflate");

    deepEqual(parsed[1].encoding, "br");
    deepEqual(parsed[1].toString(), "br");

    deepEqual(parsed[2].encoding, "x-gzip");
    deepEqual(parsed[2].toString(), "x-gzip");
  });
});
