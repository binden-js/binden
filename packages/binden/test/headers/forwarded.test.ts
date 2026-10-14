import { deepStrictEqual, throws } from "node:assert";
import { suite, test } from "node:test";

import { Forwarded, type IForwarded } from "../../index.js";

suite("Forwarded", () => {
  test("constructor", () => {
    const _ = { for: "[2001:db8:cafe::17]:4711" };
    const by = "203.0.113.43";
    const secret = "Secret";
    const host = "example.com";
    const proto = "http";

    const forwarded = new Forwarded({ ..._, by, host, secret, proto });
    deepStrictEqual(forwarded.for, _.for);
    deepStrictEqual(forwarded.by, by);
    deepStrictEqual(forwarded.host, host);
    deepStrictEqual(forwarded.proto, proto);
    deepStrictEqual(forwarded.secret, secret);
    deepStrictEqual(
      forwarded.toString(),
      `for="${_.for}";by=${by};host=${host};secret=${secret};proto=${proto}`,
    );
  });

  test("constructor (invalid input)", () => {
    const invalid: [Record<string, unknown>, string][] = [
      [{ for: 1 }, "for"],
      [{}, "for"],
      [{ for: null }, "for"],
      [{ for: "a\u0000" }, "for"],
      [{ for: "a", by: "\n" }, "by"],
      [{ for: "a", host: "\u20AC" }, "host"],
      [{ for: "a", secret: 1 }, "secret"],
      [{ for: "a", proto: "\u007F" }, "proto"],
    ];
    for (const [input, name] of invalid) {
      throws(
        () => new Forwarded(input as unknown as IForwarded),
        new TypeError(`Invalid \`${name}\` parameter`),
        JSON.stringify(input),
      );
    }
  });

  test(".toString() (quoted strings)", () => {
    // Values that are not tokens are quoted (and their quotes escaped), so
    // that the element is parsed back as it is
    const forwarded = new Forwarded({
      for: "",
      by: `a"b\\c`,
      host: "example.com:8080",
      secret: "s e,c;r=t",
      proto: "\thttps\xE9",
    });
    const output = `for="";by="a\\"b\\\\c";host="example.com:8080";secret="s e,c;r=t";proto="\thttps\xE9"`;
    deepStrictEqual(forwarded.toString(), output);
    const [parsed] = Forwarded.parse(output);
    deepStrictEqual(
      [parsed?.for, parsed?.by, parsed?.host, parsed?.secret, parsed?.proto],
      ["", `a"b\\c`, "example.com:8080", "s e,c;r=t", "\thttps\xE9"],
    );
  });

  test(".fromString()", () => {
    const input = ` For="[2001:db8:cafe::17]:4711";proto=https , for = 192.0.2.60 ; PROTO = http ; By = 203.0.113.43; secRet = SECRET; hoSt = localhost, ignored=1, ignored; k=v, for="", for="`;

    const forwarded1 = new Forwarded({
      for: "[2001:db8:cafe::17]:4711",
      proto: "https",
    });
    const forwarded2 = new Forwarded({
      for: "192.0.2.60",
      proto: "http",
      by: "203.0.113.43",
      secret: "SECRET",
      host: "localhost",
    });

    const parsed = Forwarded.fromString(input);

    // `ignored=1` and `for=""` are valid elements, while `ignored` (not a
    // parameter) and `for="` (an unterminated quoted string) are not
    deepStrictEqual(parsed.length, 4);

    const [one, two, extension, empty] = parsed;
    deepStrictEqual(extension.toString(), "for=unknown");
    deepStrictEqual(empty.for, "");

    deepStrictEqual(one.for, forwarded1.for);
    deepStrictEqual(one.by, forwarded1.by);
    deepStrictEqual(one.host, forwarded1.host);
    deepStrictEqual(one.proto, forwarded1.proto);
    deepStrictEqual(one.secret, forwarded1.secret);
    deepStrictEqual(one.toString(), forwarded1.toString());

    deepStrictEqual(two.for, forwarded2.for);
    deepStrictEqual(two.by, forwarded2.by);
    deepStrictEqual(two.host, forwarded2.host);
    deepStrictEqual(two.proto, forwarded2.proto);
    deepStrictEqual(two.secret, forwarded2.secret);
    deepStrictEqual(two.toString(), forwarded2.toString());
  });

  test(".parse() (the elements in their positions)", () => {
    const parse = (input?: string): (string | null)[] =>
      Forwarded.parse(input).map((element) => element?.toString() ?? null);

    deepStrictEqual(parse(), []);
    deepStrictEqual(
      parse(`for=a;proto=https, garbage, for="b,c", ext=1, , for=d;for=e`),
      ["for=a;proto=https", null, `for="b,c"`, "for=unknown", null],
    );
    // The values that some proxies send unquoted
    deepStrictEqual(parse("for=2001:db8::1;proto=https, for=[::1]:80"), [
      `for="2001:db8::1";proto=https`,
      `for="[::1]:80"`,
    ]);
    // Control characters (in a quoted string, or a value without spaces)
    deepStrictEqual(parse(`for="a\u0001", for=b\u0002, for=c`), [
      null,
      null,
      "for=c",
    ]);
    // A repeated parameter, also in another case, is ambiguous
    deepStrictEqual(parse("proto=http;PROTO=https"), [null]);
  });

  test(".fromString() (no `for` directive)", () => {
    const secret = "donottellanyone";
    const input = `Secret = donottellanyone ; , ; , `;

    const forwarded = new Forwarded({ for: "unknown", secret });

    const parsed = Forwarded.fromString(input);

    deepStrictEqual(parsed.length, 1);

    const [actual] = parsed;

    deepStrictEqual(actual.for, forwarded.for);
    deepStrictEqual(actual.by, forwarded.by);
    deepStrictEqual(actual.host, forwarded.host);
    deepStrictEqual(actual.proto, forwarded.proto);
    deepStrictEqual(actual.secret, forwarded.secret);
    deepStrictEqual(actual.toString(), forwarded.toString());
  });
});
