import { deepStrictEqual, throws } from "node:assert";
import { suite, test } from "node:test";

import { Accept } from "../../index.js";

suite("Accept", () => {
  test("constructor", () => {
    const accept = new Accept({
      type: "text/html",
      parameters: { Level: "1", level: "2", charset: "a b" },
      q_value: 0.5,
    });
    deepStrictEqual(accept.type, "text/html");
    // By lowercase name, the first one of a name
    deepStrictEqual(accept.parameters, { level: "1", charset: "a b" });
    deepStrictEqual(accept.q_value, 0.5);
    deepStrictEqual(accept.toString(), `text/html;level=1;charset="a b";q=0.5`);

    const all = new Accept({ type: "*/*" });
    deepStrictEqual(all.parameters, {});
    deepStrictEqual(all.q_value, null);
    deepStrictEqual(all.toString(), "*/*");
    deepStrictEqual(
      new Accept({ type: "image/*", q_value: 0 }).toString(),
      "image/*;q=0",
    );
  });

  test("constructor (invalid input)", () => {
    for (const type of [
      "text",
      "*/html",
      "text/html/x",
      "te xt/html",
      "",
      "text/",
      "/html",
    ]) {
      throws(
        () => new Accept({ type }),
        new TypeError(`Invalid media range: ${type}`),
      );
    }
    for (const q_value of [2, -0.5, 0.0001, Number.NaN]) {
      throws(
        () => new Accept({ type: "text/html", q_value }),
        new TypeError(`\`q_value\` is not a qvalue: ${q_value}`),
      );
    }
    for (const name of ["q", "Q", "a b", ""]) {
      throws(
        () => new Accept({ type: "text/html", parameters: { [name]: "1" } }),
        new TypeError(`Invalid parameter name: ${name}`),
      );
    }
    for (const value of ["\n", "a\u0000", "€"]) {
      throws(
        () => new Accept({ type: "text/html", parameters: { level: value } }),
        new TypeError("Invalid value of the parameter level"),
      );
    }
  });

  test("Accept.fromString()", () => {
    const parse = (input?: string[] | string): string[] =>
      Accept.fromString(input).map((element) => element.toString());

    deepStrictEqual(parse(), []);
    deepStrictEqual(parse(""), []);
    deepStrictEqual(parse([]), []);
    // From the greatest weight, in their order on a tie, in lowercase
    deepStrictEqual(
      parse(
        `Text/*;Q=0.3, text/plain;q=0.7, TEXT/plain;FORMAT=flowed, text/plain;format=fixed;q=0.4, */*;q=0.5`,
      ),
      [
        "text/plain;format=flowed",
        "text/plain;q=0.7",
        "*/*;q=0.5",
        "text/plain;format=fixed;q=0.4",
        "text/*;q=0.3",
      ],
    );
    // Several fields are one list
    deepStrictEqual(parse(["text/html;q=0.1", "image/png"]), [
      "image/png",
      "text/html;q=0.1",
    ]);
    // Quoted strings, empty parameters and elements, extensions after the weight
    deepStrictEqual(
      parse(`text/html ; level="a,b\\"" ; ; q=0.2 ; ext=1 ; ext, ,`),
      [`text/html;level="a,b\\"";q=0.2`],
    );
    // Malformed elements are skipped
    deepStrictEqual(
      parse(
        `text, */html, a/b/c, text/html;level, text/html;q=2, text/html;q="1", text/html;a="\u0001", ;q=1, image/png`,
      ),
      ["image/png"],
    );
  });

  test("Accept.negotiate()", () => {
    // RFC 9110, section 12.5.1
    const header = `text/*;q=0.3, text/plain;q=0.7, text/plain;format=flowed, text/plain;format=fixed;q=0.4, */*;q=0.5`;
    const negotiate = (...offers: string[]): string | false =>
      Accept.negotiate(offers, header);

    deepStrictEqual(negotiate("text/html", "image/jpeg"), "image/jpeg");
    deepStrictEqual(
      negotiate("text/plain;format=fixed", "image/jpeg"),
      "image/jpeg",
    );
    deepStrictEqual(negotiate("image/jpeg", "text/plain"), "text/plain");
    deepStrictEqual(
      negotiate("text/plain", "text/plain;format=flowed"),
      "text/plain;format=flowed",
    );
    deepStrictEqual(
      negotiate("text/plain;format=fixed", "text/html"),
      "text/plain;format=fixed",
    );
    // Both of the weight of `text/*`: the first offer
    deepStrictEqual(
      negotiate("text/html;level=3", "text/html"),
      "text/html;level=3",
    );
    deepStrictEqual(negotiate(), false);

    // Without the header: the first offer
    deepStrictEqual(Accept.negotiate(["b/c", "a/b"]), "b/c");
    deepStrictEqual(Accept.negotiate([]), false);
    // An empty or invalid header accepts nothing
    deepStrictEqual(Accept.negotiate(["a/b"], ""), false);
    deepStrictEqual(Accept.negotiate(["a/b"], "garbage"), false);
    deepStrictEqual(Accept.negotiate(["a/b"], ["garbage", "a/*"]), "a/b");
  });

  test("Accept.negotiate() (weights and specificity)", () => {
    const negotiate = (input: string, ...offers: string[]): string | false =>
      Accept.negotiate(offers, input);

    // The weight 0 is not acceptable, also through a less specific range
    deepStrictEqual(
      negotiate("application/json;q=0, */*", "application/json"),
      false,
    );
    deepStrictEqual(
      negotiate("application/json;q=0, */*", "application/json", "text/html"),
      "text/html",
    );
    deepStrictEqual(negotiate("text/*;q=0, */*", "text/html"), false);
    deepStrictEqual(
      negotiate("text/*", "application/json", "text/html"),
      "text/html",
    );
    // Case-insensitive, and the offer is returned as given
    deepStrictEqual(negotiate("TEXT/HTML", "Text/Html"), "Text/Html");
    // On a tie: the more specific range, then the earlier one, then the
    // earlier offer
    deepStrictEqual(
      negotiate("text/*, text/html", "text/plain", "text/html"),
      "text/html",
    );
    deepStrictEqual(
      negotiate("text/html, application/json", "application/json", "text/html"),
      "text/html",
    );
    deepStrictEqual(negotiate("*/*", "a/b", "c/d"), "a/b");
    deepStrictEqual(negotiate("*/*;q=0.5, c/d;q=0.5", "a/b", "c/d"), "c/d");
    // The most specific range gives the weight (the first one of them)
    deepStrictEqual(negotiate("text/html;q=0, text/html", "text/html"), false);
    deepStrictEqual(
      negotiate("text/html, text/html;q=0", "text/html"),
      "text/html",
    );
    deepStrictEqual(
      negotiate("text/*;q=0.1, text/html;q=0.5, */*;q=0.4", "a/b", "text/html"),
      "text/html",
    );
    deepStrictEqual(
      negotiate("text/*;q=0.1, */*;q=0.4", "a/b", "text/html"),
      "a/b",
    );
    // The parameters of a range must be those of the offer: their names are
    // case-insensitive, and so is the value of `charset` only
    deepStrictEqual(negotiate("text/html;level=1", "text/html"), false);
    deepStrictEqual(
      negotiate("text/html;Level=a", "text/html;LEVEL=a;x=y"),
      "text/html;LEVEL=a;x=y",
    );
    deepStrictEqual(negotiate("text/html;level=A", "text/html;level=a"), false);
    deepStrictEqual(
      negotiate(
        `application/x;profile="https://a.test/A"`,
        `application/x;profile="https://a.test/a"`,
      ),
      false,
    );
    deepStrictEqual(
      negotiate("text/plain;CHARSET=UTF-8", "text/plain;charset=utf-8"),
      "text/plain;charset=utf-8",
    );
    deepStrictEqual(negotiate("text/html;level=1", "text/html;level=2"), false);
    // A range with more parameters is more specific
    deepStrictEqual(
      negotiate(
        "text/html;q=0.9, text/html;level=1;q=0.5, */*;q=0.7",
        "text/html;level=1",
        "image/png",
      ),
      "image/png",
    );
    deepStrictEqual(
      negotiate("*/*;level=1", "text/html;level=1", "a/b"),
      "text/html;level=1",
    );
    deepStrictEqual(
      negotiate(
        "text/html;level=1;q=0.5, text/*;q=0.9",
        "text/html;level=1",
        "text/plain",
      ),
      "text/plain",
    );
  });

  test("Accept.negotiate() (invalid offers)", () => {
    for (const offer of [
      "json",
      "text/*",
      "*/*",
      "*/html",
      "text/html;q=1",
      "text/html, text/plain",
      "",
      "a/b/c",
      "text/html;level",
    ]) {
      throws(
        () => Accept.negotiate(["a/b", offer], "*/*"),
        new TypeError(`Invalid media type: ${offer}`),
      );
      // Also without the header
      throws(
        () => Accept.negotiate(["a/b", offer]),
        new TypeError(`Invalid media type: ${offer}`),
      );
    }
  });
});
