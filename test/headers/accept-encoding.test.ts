import { deepEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { AcceptEncoding } from "../../index.js";

describe("AcceptEncoding", () => {
  it("constructor", () => {
    const encoding = "br";
    const q_value = 0.02;
    const ac = new AcceptEncoding({ encoding, q_value });
    deepEqual(ac.encoding, encoding);
    deepEqual(ac.q_value, q_value);
    deepEqual(ac.toString(), `${encoding};q=${q_value}`);
  });

  it("constructor (no `q_value`)", () => {
    const encoding = "br";
    const ac = new AcceptEncoding({ encoding });
    deepEqual(ac.encoding, encoding);
    deepEqual(ac.q_value, null);
    deepEqual(ac.toString(), encoding);
  });

  it("AcceptEncoding.fromString()", () => {
    deepEqual(AcceptEncoding.fromString(), []);
    deepEqual(AcceptEncoding.fromString(""), []);
    deepEqual(AcceptEncoding.fromString([]), []);
    deepEqual(AcceptEncoding.fromString([""]), []);
    deepEqual(AcceptEncoding.fromString(["", ""]), []);

    const input =
      " deflate , gzip;q=0.3,x-gzip ;q= 0.4 , *;q=0.54 , identity;q=0.1, br;q=1,compress;q=0.7, ignored;q=2";
    const parsed = AcceptEncoding.fromString(input);
    deepEqual(parsed.length, 7);

    deepEqual(parsed[0].encoding, "deflate");
    deepEqual(parsed[0].q_value, null);
    deepEqual(parsed[0].toString(), "deflate");

    deepEqual(parsed[1].encoding, "br");
    deepEqual(parsed[1].q_value, 1);
    deepEqual(parsed[1].toString(), "br;q=1");

    deepEqual(parsed[2].encoding, "compress");
    deepEqual(parsed[2].q_value, 0.7);
    deepEqual(parsed[2].toString(), "compress;q=0.7");

    deepEqual(parsed[3].encoding, "*");
    deepEqual(parsed[3].q_value, 0.54);
    deepEqual(parsed[3].toString(), "*;q=0.54");

    deepEqual(parsed[4].encoding, "x-gzip");
    deepEqual(parsed[4].q_value, 0.4);
    deepEqual(parsed[4].toString(), "x-gzip;q=0.4");

    deepEqual(parsed[5].encoding, "gzip");
    deepEqual(parsed[5].q_value, 0.3);
    deepEqual(parsed[5].toString(), "gzip;q=0.3");

    deepEqual(parsed[6].encoding, "identity");
    deepEqual(parsed[6].q_value, 0.1);
    deepEqual(parsed[6].toString(), "identity;q=0.1");
  });
});
