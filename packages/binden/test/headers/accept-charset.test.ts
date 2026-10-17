import { deepStrictEqual, throws } from "node:assert";
import { suite, test } from "node:test";

import { AcceptCharset } from "../../index.js";

suite("AcceptCharset", () => {
  test("constructor", () => {
    const element = new AcceptCharset({ charset: "utf-8", q_value: 0.5 });
    deepStrictEqual(element.charset, "utf-8");
    deepStrictEqual(element.q_value, 0.5);
    deepStrictEqual(element.toString(), "utf-8;q=0.5");

    const any = new AcceptCharset({ charset: "*" });
    deepStrictEqual(any.q_value, null);
    deepStrictEqual(any.toString(), "*");
  });

  test("constructor (invalid input)", () => {
    for (const charset of ["utf 8", "", "a,b", "a;q=1"]) {
      throws(
        () => new AcceptCharset({ charset }),
        new TypeError(`Invalid charset: ${charset}`),
      );
    }
    for (const q_value of [2, -0.5, 0.0001]) {
      throws(
        () => new AcceptCharset({ charset: "utf-8", q_value }),
        new TypeError(`\`q_value\` is not a qvalue: ${q_value}`),
      );
    }
  });

  test("AcceptCharset.fromString()", () => {
    const parse = (input?: string[] | string): string[] =>
      AcceptCharset.fromString(input).map((element) => element.toString());

    deepStrictEqual(parse(), []);
    // RFC 9110, section 12.5.2; other parameters are ignored, malformed
    // elements skipped
    deepStrictEqual(
      parse(
        `iso-8859-5;x="1", unicode-1-1;q=0.8, *;q=0.1, "utf-8", utf-16;q=3`,
      ),
      ["iso-8859-5", "unicode-1-1;q=0.8", "*;q=0.1"],
    );
    deepStrictEqual(parse(["a;q=0.5", "b"]), ["b", "a;q=0.5"]);
  });

  test("AcceptCharset.negotiate()", () => {
    const negotiate = (input: string, ...offers: string[]): string | false =>
      AcceptCharset.negotiate(offers, input);

    deepStrictEqual(
      negotiate("iso-8859-5, unicode-1-1;q=0.8", "unicode-1-1", "iso-8859-5"),
      "iso-8859-5",
    );
    deepStrictEqual(negotiate("iso-8859-5, unicode-1-1;q=0.8", "utf-8"), false);
    // Case-insensitive, and the offer is returned as given
    deepStrictEqual(negotiate("UTF-8", "utf-8"), "utf-8");
    // `*` matches any charset, but not those of an excluding element
    deepStrictEqual(
      negotiate("utf-8;q=0, *;q=0.5", "utf-8", "latin1"),
      "latin1",
    );
    deepStrictEqual(negotiate("utf-8;q=0, *;q=0.5", "utf-8"), false);
    deepStrictEqual(negotiate("*;q=0.5, b;q=0.5", "a", "b"), "b");
    deepStrictEqual(negotiate("a;q=0.4, *;q=0.5", "a", "b"), "b");
    deepStrictEqual(negotiate("", "utf-8"), false);
    // Without the header: the first offer
    deepStrictEqual(AcceptCharset.negotiate(["b", "a"]), "b");
    deepStrictEqual(AcceptCharset.negotiate([]), false);
  });

  test("AcceptCharset.negotiate() (invalid offers)", () => {
    for (const offer of ["*", "utf 8", ""]) {
      throws(
        () => AcceptCharset.negotiate(["utf-8", offer], "*"),
        new TypeError(`Invalid charset: ${offer}`),
      );
    }
  });
});
