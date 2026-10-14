import { deepStrictEqual } from "node:assert";
import { suite, test } from "node:test";

import { Forwarded } from "../../index.js";

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
      ["for=a;proto=https", null, "for=b,c", "for=unknown", null],
    );
    // The values that some proxies send unquoted
    deepStrictEqual(parse("for=2001:db8::1;proto=https, for=[::1]:80"), [
      "for=2001:db8::1;proto=https",
      `for="[::1]:80"`,
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
