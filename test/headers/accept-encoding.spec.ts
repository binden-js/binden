import { deepStrictEqual } from "assert";

import { AcceptEncoding } from "../../index.js";

suite("AcceptEncoding", () => {
  test("constructor", () => {
    const encoding = "br";
    const q_value = 0.02;
    const ac = new AcceptEncoding({ encoding, q_value });
    deepStrictEqual(ac.encoding, encoding);
    deepStrictEqual(ac.q_value, q_value);
    deepStrictEqual(ac.toString(), `${encoding};q=${q_value}`);
  });

  test("constructor (no `q_value`)", () => {
    const encoding = "br";
    const ac = new AcceptEncoding({ encoding });
    deepStrictEqual(ac.encoding, encoding);
    deepStrictEqual(typeof ac.q_value, "undefined");
    deepStrictEqual(ac.toString(), encoding);
  });

  test("AcceptEncoding.fromString()", () => {
    const input =
      " deflate , gzip;q=0.3,x-gzip ;q= 0.4 , *;q=0.54 , identity;q=0.1, br;q=1,compress;q=0.7, ignored;q=2";
    const parsed = AcceptEncoding.fromString(input);
    deepStrictEqual(parsed.length, 7);

    deepStrictEqual(parsed[0].encoding, "deflate");
    deepStrictEqual(typeof parsed[0].q_value, "undefined");
    deepStrictEqual(parsed[0].toString(), "deflate");

    deepStrictEqual(parsed[1].encoding, "br");
    deepStrictEqual(parsed[1].q_value, 1);
    deepStrictEqual(parsed[1].toString(), "br;q=1");

    deepStrictEqual(parsed[2].encoding, "compress");
    deepStrictEqual(parsed[2].q_value, 0.7);
    deepStrictEqual(parsed[2].toString(), "compress;q=0.7");

    deepStrictEqual(parsed[3].encoding, "*");
    deepStrictEqual(parsed[3].q_value, 0.54);
    deepStrictEqual(parsed[3].toString(), "*;q=0.54");

    deepStrictEqual(parsed[4].encoding, "x-gzip");
    deepStrictEqual(parsed[4].q_value, 0.4);
    deepStrictEqual(parsed[4].toString(), "x-gzip;q=0.4");

    deepStrictEqual(parsed[5].encoding, "gzip");
    deepStrictEqual(parsed[5].q_value, 0.3);
    deepStrictEqual(parsed[5].toString(), "gzip;q=0.3");

    deepStrictEqual(parsed[6].encoding, "identity");
    deepStrictEqual(parsed[6].q_value, 0.1);
    deepStrictEqual(parsed[6].toString(), "identity;q=0.1");
  });
});
