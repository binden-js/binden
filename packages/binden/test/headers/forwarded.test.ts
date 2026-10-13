import { deepStrictEqual } from "node:assert";

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

    deepStrictEqual(parsed.length, 2);

    const [one, two] = parsed;

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
