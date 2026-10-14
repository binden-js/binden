import { deepStrictEqual, throws } from "node:assert";
import { suite, test } from "node:test";

import { AcceptEncoding, type IAcceptEncodings } from "../../index.js";

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
    deepStrictEqual(ac.q_value, null);
    deepStrictEqual(ac.toString(), encoding);
  });

  test("AcceptEncoding.fromString()", () => {
    deepStrictEqual(AcceptEncoding.fromString(), []);
    deepStrictEqual(AcceptEncoding.fromString(""), []);
    deepStrictEqual(AcceptEncoding.fromString([]), []);
    deepStrictEqual(AcceptEncoding.fromString([""]), []);
    deepStrictEqual(AcceptEncoding.fromString(["", ""]), []);

    const input =
      " deflate , gzip;q=0.3,x-gzip ;q= 0.4 , *;q=0.54 , identity;q=0.1, br;q=1,compress;q=0.7, ignored;q=2";
    const parsed = AcceptEncoding.fromString(input);
    deepStrictEqual(parsed.length, 7);

    deepStrictEqual(parsed[0].encoding, "deflate");
    deepStrictEqual(parsed[0].q_value, null);
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

  test("AcceptEncoding.fromString() (case and whitespace insensitive)", () => {
    const parsed = AcceptEncoding.fromString(
      "GZIP;Q=0.5, Br ; q = 0.4, deflate; q=1, X-Gzip",
    );

    deepStrictEqual(
      parsed.map((e) => e.toString()),
      ["deflate;q=1", "x-gzip", "gzip;q=0.5", "br;q=0.4"],
    );
  });

  test("AcceptEncoding.fromString() (qvalues, RFC 9110, section 12.4.2)", () => {
    const parse = (input: string): string[] =>
      AcceptEncoding.fromString(input).map((e) => e.toString());

    deepStrictEqual(parse("gzip;q=0.123, br;q=1.000, deflate;q=0."), [
      "br;q=1",
      "gzip;q=0.123",
      "deflate;q=0",
    ]);
    // A weight out of 0..1 (or with more than 3 decimals) drops the element
    deepStrictEqual(parse("br;q=1, gzip;q=2"), ["br;q=1"]);
    for (const q of [
      "-1",
      "Infinity",
      "0x1",
      "1e0",
      "0.12345",
      "1.5",
      "1.001",
      "",
      "abc",
    ]) {
      deepStrictEqual(parse(`gzip;q=${q}`), [], q);
    }
  });

  test("constructor (invalid input)", () => {
    for (const q_value of [
      2,
      -0.5,
      0.0001,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      throws(
        () => new AcceptEncoding({ encoding: "gzip", q_value }),
        new TypeError(`\`q_value\` is not a qvalue: ${q_value}`),
      );
    }
    throws(
      () =>
        new AcceptEncoding({
          encoding: "gzip, br;q=1" as IAcceptEncodings,
        }),
      new TypeError("Unknown content coding: gzip, br;q=1"),
    );
    deepStrictEqual(
      new AcceptEncoding({ encoding: "br", q_value: 0.5 }).toString(),
      "br;q=0.5",
    );
  });
});
