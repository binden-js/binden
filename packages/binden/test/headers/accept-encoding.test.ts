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

  test("AcceptEncoding.fromString() (zstd, RFC 8878)", () => {
    deepStrictEqual(
      AcceptEncoding.fromString("ZSTD;q=0.9, br").map((e) => e.toString()),
      ["br", "zstd;q=0.9"],
    );
    deepStrictEqual(new AcceptEncoding({ encoding: "zstd" }).encoding, "zstd");
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

  test("AcceptEncoding.negotiate()", () => {
    const negotiate = (input: string, ...offers: string[]): string | false =>
      AcceptEncoding.negotiate(offers, input);

    deepStrictEqual(negotiate("gzip, br;q=0.9", "br", "gzip"), "gzip");
    deepStrictEqual(negotiate("GZIP;Q=0.5, Br;q=0.4", "br", "Gzip"), "Gzip");
    // `x-gzip` is `gzip`
    deepStrictEqual(negotiate("x-gzip", "br", "gzip"), "gzip");
    deepStrictEqual(negotiate("gzip", "br", "x-gzip"), "x-gzip");
    // Unknown codings count too, and an invalid weight drops its element
    deepStrictEqual(negotiate("foo;q=0, *", "foo", "gzip"), "gzip");
    deepStrictEqual(negotiate("foo;q=0.5, gzip;q=0.4", "gzip", "foo"), "foo");
    deepStrictEqual(negotiate("gzip;q=2, br", "gzip", "br"), "br");
    deepStrictEqual(negotiate("*;q=0.5, br;q=0.5", "gzip", "br"), "br");
    deepStrictEqual(negotiate("br", "gzip"), false);
    deepStrictEqual(negotiate("br"), false);
    // RFC 9110, section 12.5.3: `identity` is acceptable unless excluded
    deepStrictEqual(negotiate("br;q=0", "br", "identity"), "identity");
    deepStrictEqual(negotiate("", "gzip", "identity"), "identity");
    deepStrictEqual(negotiate("", "gzip"), false);
    deepStrictEqual(negotiate("identity;q=0", "identity"), false);
    deepStrictEqual(negotiate("*;q=0", "identity"), false);
    deepStrictEqual(
      negotiate("*;q=0, IDENTITY", "gzip", "identity"),
      "identity",
    );
    deepStrictEqual(negotiate("*;q=0.5", "identity", "gzip"), "identity");
    // ... but the least preferred when the header does not name it
    deepStrictEqual(negotiate("gzip;q=0.001", "identity", "gzip"), "gzip");
    deepStrictEqual(negotiate("gzip;q=0", "identity", "gzip"), "identity");
    // Without the header: the first offer
    deepStrictEqual(AcceptEncoding.negotiate(["br", "gzip"]), "br");
    deepStrictEqual(AcceptEncoding.negotiate([]), false);
    deepStrictEqual(
      AcceptEncoding.negotiate(["br", "zstd"], ["br;q=0.5", "zstd"]),
      "zstd",
    );
  });

  test("AcceptEncoding.negotiate() (invalid offers)", () => {
    for (const offer of ["*", "g zip", ""]) {
      throws(
        () => AcceptEncoding.negotiate(["gzip", offer], "*"),
        new TypeError(`Invalid content coding: ${offer}`),
      );
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
