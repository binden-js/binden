import { deepStrictEqual, throws } from "node:assert";
import { suite, test } from "node:test";

import { AcceptLanguage } from "../../index.js";

suite("AcceptLanguage", () => {
  test("constructor", () => {
    const element = new AcceptLanguage({ language: "en-US", q_value: 0.8 });
    deepStrictEqual(element.language, "en-US");
    deepStrictEqual(element.q_value, 0.8);
    deepStrictEqual(element.toString(), "en-US;q=0.8");

    const any = new AcceptLanguage({ language: "*" });
    deepStrictEqual(any.q_value, null);
    deepStrictEqual(any.toString(), "*");
    deepStrictEqual(
      new AcceptLanguage({ language: "zh-Hant-CN-x-private1" }).toString(),
      "zh-Hant-CN-x-private1",
    );
  });

  test("constructor (invalid input)", () => {
    for (const language of [
      "en_US",
      "123",
      "toolongtag",
      "en-",
      "-en",
      "en--US",
      "en-toolongtag",
      "",
      "**",
      "en-*",
    ]) {
      throws(
        () => new AcceptLanguage({ language }),
        new TypeError(`Invalid language range: ${language}`),
      );
    }
    for (const q_value of [2, -0.5, 0.0001]) {
      throws(
        () => new AcceptLanguage({ language: "en", q_value }),
        new TypeError(`\`q_value\` is not a qvalue: ${q_value}`),
      );
    }
  });

  test("AcceptLanguage.fromString()", () => {
    const parse = (input?: string[] | string): string[] =>
      AcceptLanguage.fromString(input).map((element) => element.toString());

    deepStrictEqual(parse(), []);
    deepStrictEqual(parse(""), []);
    // From the greatest weight, in their order on a tie; other parameters
    // are ignored, malformed elements skipped
    deepStrictEqual(
      parse(
        "da, en-gb;q=0.8, en;q=0.7;x=1, fr;x=1;q=0.7, *;q=0.1, en_US, de;q=2",
      ),
      ["da", "en-gb;q=0.8", "en;q=0.7", "fr;q=0.7", "*;q=0.1"],
    );
    deepStrictEqual(parse(["fr;q=0.5", "de"]), ["de", "fr;q=0.5"]);
    // A weight is a qvalue, a parameter is `name=value`
    deepStrictEqual(parse("en;q=1e0, fr;q=0.5000, de;x, it;q=1.000"), [
      "it;q=1",
    ]);
  });

  test("AcceptLanguage.negotiate()", () => {
    const negotiate = (input: string, ...offers: string[]): string | false =>
      AcceptLanguage.negotiate(offers, input);
    const header = "da, en-gb;q=0.8, en;q=0.7";

    deepStrictEqual(negotiate(header, "en", "da"), "da");
    deepStrictEqual(negotiate(header, "en-US", "en-GB"), "en-GB");
    // A range matches the tag and the tags that it is a prefix of (at a `-`)
    deepStrictEqual(negotiate(header, "en"), "en");
    deepStrictEqual(negotiate(header, "en-US"), "en-US");
    deepStrictEqual(negotiate(header, "eng", "de"), false);
    deepStrictEqual(negotiate("en-GB", "en"), false);
    // The longest matching range gives the weight
    deepStrictEqual(
      negotiate("en;q=0.2, en-US;q=0.9, fr;q=0.5", "fr", "en-US"),
      "en-US",
    );
    deepStrictEqual(
      negotiate("en-US;q=0.2, en;q=0.9, fr;q=0.5", "fr", "en-US"),
      "fr",
    );
    // Case-insensitive, and the offer is returned as given
    deepStrictEqual(negotiate("EN-us", "en-US"), "en-US");
    // `*` matches any tag, but not those of an excluding range
    deepStrictEqual(negotiate("fr;q=0, *", "fr", "de"), "de");
    deepStrictEqual(negotiate("fr;q=0, *", "fr-CA"), false);
    deepStrictEqual(negotiate("*;q=0.5, de;q=0.5", "fr", "de"), "de");
    deepStrictEqual(negotiate("*", "fr", "de"), "fr");
    // On a tie: the earlier element, then the earlier offer
    deepStrictEqual(negotiate("de, fr", "fr", "de"), "de");
    deepStrictEqual(negotiate("", "fr"), false);
    deepStrictEqual(negotiate(header), false);
    // Without the header: the first offer
    deepStrictEqual(AcceptLanguage.negotiate(["fr", "de"]), "fr");
    deepStrictEqual(AcceptLanguage.negotiate([]), false);
  });

  test("AcceptLanguage.negotiate() (invalid offers)", () => {
    for (const offer of ["*", "en_US", "", "en;q=1"]) {
      throws(
        () => AcceptLanguage.negotiate(["en", offer]),
        new TypeError(`Invalid language tag: ${offer}`),
      );
    }
  });
});
