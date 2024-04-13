import { deepEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { Forwarded } from "../../index.js";

describe("Forwarded", () => {
  it("constructor", () => {
    const _ = { for: "[2001:db8:cafe::17]:4711" };
    const by = "203.0.113.43";
    const secret = "Secret";
    const host = "example.com";
    const proto = "http";

    const forwarded = new Forwarded({ ..._, by, host, secret, proto });
    deepEqual(forwarded.for, _.for);
    deepEqual(forwarded.by, by);
    deepEqual(forwarded.host, host);
    deepEqual(forwarded.proto, proto);
    deepEqual(forwarded.secret, secret);
    deepEqual(
      forwarded.toString(),
      `for="${_.for}";by=${by};host=${host};secret=${secret};proto=${proto}`,
    );
  });

  it(".fromString()", () => {
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

    deepEqual(parsed.length, 2);

    const [one, two] = parsed;

    deepEqual(one.for, forwarded1.for);
    deepEqual(one.by, forwarded1.by);
    deepEqual(one.host, forwarded1.host);
    deepEqual(one.proto, forwarded1.proto);
    deepEqual(one.secret, forwarded1.secret);
    deepEqual(one.toString(), forwarded1.toString());

    deepEqual(two.for, forwarded2.for);
    deepEqual(two.by, forwarded2.by);
    deepEqual(two.host, forwarded2.host);
    deepEqual(two.proto, forwarded2.proto);
    deepEqual(two.secret, forwarded2.secret);
    deepEqual(two.toString(), forwarded2.toString());
  });

  it(".fromString() (no `for` directive)", () => {
    const secret = "donottellanyone";
    const input = `Secret = donottellanyone ; , ; , `;

    const forwarded = new Forwarded({ for: "unknown", secret });

    const parsed = Forwarded.fromString(input);

    deepEqual(parsed.length, 1);

    const [actual] = parsed;

    deepEqual(actual.for, forwarded.for);
    deepEqual(actual.by, forwarded.by);
    deepEqual(actual.host, forwarded.host);
    deepEqual(actual.proto, forwarded.proto);
    deepEqual(actual.secret, forwarded.secret);
    deepEqual(actual.toString(), forwarded.toString());
  });
});
