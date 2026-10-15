import { deepStrictEqual, throws } from "node:assert";
import { suite, test } from "node:test";

import { Cookie } from "../../index.js";

suite("Cookie", () => {
  test("constructor (`__Secure-` prefix)", () => {
    const key = "__Secure-ID";
    const value = "123";
    const expires = new Date();
    const max_age = 1;
    const domain = "example.com";
    const secure = false;
    const http_only = true;
    const same_site = "Strict";

    const cookie = new Cookie({
      key,
      value,
      expires,
      max_age,
      domain,
      secure,
      http_only,
      same_site,
    });
    deepStrictEqual(cookie.key, key);
    deepStrictEqual(cookie.value, value);
    deepStrictEqual(cookie.expires, expires);
    deepStrictEqual(cookie.max_age, max_age);
    deepStrictEqual(cookie.path, "/");
    deepStrictEqual(cookie.domain, domain);
    deepStrictEqual(cookie.secure, true);
    deepStrictEqual(cookie.http_only, http_only);
    deepStrictEqual(cookie.same_site, same_site);
    deepStrictEqual(
      cookie.toString(),
      `${key}=${value}; Max-Age=${max_age}; Domain=${domain}; Path=/; Secure; HttpOnly; SameSite=${same_site}`,
    );
  });

  test("constructor (`__Host-` prefix)", () => {
    const key = "__Host-ID";
    const value = "123";
    const expires = new Date();
    const domain = "example.com";
    const path = "/path";

    const cookie = new Cookie({ key, value, expires, domain, path });
    deepStrictEqual(cookie.key, key);
    deepStrictEqual(cookie.value, value);
    deepStrictEqual(cookie.expires, expires);
    deepStrictEqual(cookie.max_age, null);
    deepStrictEqual(cookie.path, "/");
    deepStrictEqual(cookie.domain, null);
    deepStrictEqual(cookie.secure, true);
    deepStrictEqual(cookie.http_only, true);
    deepStrictEqual(cookie.same_site, "Lax");
    deepStrictEqual(
      cookie.toString(),
      `${key}=${value}; Expires=${expires.toUTCString()}; Path=/; Secure; HttpOnly; SameSite=Lax`,
    );
  });

  test("constructor (SameSite=None)", () => {
    const key = "Key";
    const value = "Value";
    const same_site = "None";

    const cookie = new Cookie({ key, value, same_site });
    deepStrictEqual(cookie.key, key);
    deepStrictEqual(cookie.value, value);
    deepStrictEqual(cookie.expires, null);
    deepStrictEqual(cookie.max_age, null);
    deepStrictEqual(cookie.path, "/");
    deepStrictEqual(cookie.domain, null);
    deepStrictEqual(cookie.secure, true);
    deepStrictEqual(cookie.http_only, true);
    deepStrictEqual(cookie.same_site, same_site);
    deepStrictEqual(
      cookie.toString(),
      `${key}=${value}; Path=/; Secure; HttpOnly; SameSite=${same_site}`,
    );
  });

  test("constructor (Secure = false)", () => {
    const key = "Key";
    const value = "Value";
    const secure = false;

    const cookie = new Cookie({ key, value, secure });
    deepStrictEqual(cookie.key, key);
    deepStrictEqual(cookie.value, value);
    deepStrictEqual(cookie.expires, null);
    deepStrictEqual(cookie.max_age, null);
    deepStrictEqual(cookie.path, "/");
    deepStrictEqual(cookie.domain, null);
    deepStrictEqual(cookie.secure, secure);
    deepStrictEqual(cookie.http_only, true);
    deepStrictEqual(cookie.same_site, "Lax");
    deepStrictEqual(
      cookie.toString(),
      `${key}=${value}; Path=/; HttpOnly; SameSite=Lax`,
    );
  });

  test("constructor (Secure = true)", () => {
    const key = "Key";
    const value = "Value";
    const secure = true;
    const http_only = false;
    const path = null;

    const cookie = new Cookie({ key, value, secure, http_only, path });
    deepStrictEqual(cookie.key, key);
    deepStrictEqual(cookie.value, value);
    deepStrictEqual(cookie.expires, null);
    deepStrictEqual(cookie.max_age, null);
    deepStrictEqual(cookie.path, path);
    deepStrictEqual(cookie.domain, null);
    deepStrictEqual(cookie.secure, secure);
    deepStrictEqual(cookie.http_only, http_only);
    deepStrictEqual(cookie.same_site, "Lax");
    deepStrictEqual(cookie.toString(), `${key}=${value}; Secure; SameSite=Lax`);
  });

  test(".fromString()", () => {
    deepStrictEqual(Cookie.fromString(), []);
    deepStrictEqual(Cookie.fromString(""), []);
    deepStrictEqual(Cookie.fromString("a=")[0]?.value, "");
    // An empty value is a value
    deepStrictEqual(
      Cookie.fromString("a=; b=ok").map(({ key, value }) => [key, value]),
      [
        ["a", ""],
        ["b", "ok"],
      ],
    );

    const input = ` Key1 = Value1 ; Key2   =  "Value2"  ; Key3 = " ; Key4=""`;
    const one = new Cookie({ key: "Key1", value: "Value1" });
    const two = new Cookie({ key: "Key2", value: "Value2" });

    const parsed = Cookie.fromString(input);

    // `Key3` has an invalid value, `Key4` an empty one
    deepStrictEqual(
      parsed.map(({ key }) => key),
      ["Key1", "Key2", "Key4"],
    );

    const [cookie1, cookie2] = parsed;

    deepStrictEqual(cookie1.key, one.key);
    deepStrictEqual(cookie1.value, one.value);
    deepStrictEqual(cookie1.expires, one.expires);
    deepStrictEqual(cookie1.max_age, one.max_age);
    deepStrictEqual(cookie1.path, one.path);
    deepStrictEqual(cookie1.domain, one.domain);
    deepStrictEqual(cookie1.secure, one.secure);
    deepStrictEqual(cookie1.http_only, one.http_only);
    deepStrictEqual(cookie1.same_site, one.same_site);
    deepStrictEqual(cookie1.toString(), one.toString());

    deepStrictEqual(cookie2.key, two.key);
    deepStrictEqual(cookie2.value, two.value);
    deepStrictEqual(cookie2.expires, two.expires);
    deepStrictEqual(cookie2.max_age, two.max_age);
    deepStrictEqual(cookie2.path, two.path);
    deepStrictEqual(cookie2.domain, two.domain);
    deepStrictEqual(cookie2.secure, two.secure);
    deepStrictEqual(cookie2.http_only, two.http_only);
    deepStrictEqual(cookie2.same_site, two.same_site);
    deepStrictEqual(cookie2.toString(), two.toString());
  });

  test("constructor (invalid attributes)", () => {
    const invalid: ConstructorParameters<typeof Cookie>[0][] = [
      { key: "", value: "v" },
      { key: "a=b; Max-Age=0; x", value: "v" },
      { key: "a b", value: "v" },
      { key: "k", value: "x; Domain=evil.example; Path=/admin" },
      { key: "k", value: "a\r\nSet-Cookie: x=y" },
      { key: "k", value: "a,b" },
      { key: "k", value: `a"b` },
      { key: "k", value: "v", path: "/; Domain=evil" },
      { key: "k", value: "v", domain: "good.example; SameSite=None" },
      { key: "k", value: "v", domain: "a b" },
      { key: "k", value: "v", max_age: 1.5 },
      { key: "k", value: "v", max_age: Number.NaN },
      { key: "k", value: "v", max_age: Number.POSITIVE_INFINITY },
      { key: "k", value: "v", expires: new Date("invalid") },
      {
        key: "k",
        value: "v",
        same_site: "Lax; Partitioned" as unknown as "Lax",
      },
    ];
    for (const options of invalid) {
      throws(() => new Cookie(options), TypeError, JSON.stringify(options));
    }

    // Valid values that look unusual
    const cookie = new Cookie({
      key: "token",
      value: "abc==",
      max_age: 0,
      domain: ".example.com",
      path: "/a b",
    });
    deepStrictEqual(
      cookie.toString(),
      "token=abc==; Max-Age=0; Domain=.example.com; Path=/a b; HttpOnly; SameSite=Lax",
    );
    deepStrictEqual(
      new Cookie({ key: "q", value: `"quoted"` }).value,
      `"quoted"`,
    );
  });

  test(".fromString() (pairs, `=` in values and invalid cookies)", () => {
    const parsed = Cookie.fromString(
      `a=1;b=2; token=abc==; quoted="q"; bad key=3; empty=; =4; c=x\u0001; a=5`,
    );

    deepStrictEqual(
      parsed.map(({ key, value }) => [key, value]),
      [
        ["a", "1"],
        ["b", "2"],
        ["token", "abc=="],
        ["quoted", "q"],
        ["empty", ""],
      ],
    );
    // An invalid cookie does not hide a valid one of its name
    deepStrictEqual(
      Cookie.fromString(`c=x\u0001; c=ok`).map(({ key, value }) => [
        key,
        value,
      ]),
      [["c", "ok"]],
    );
  });

  test(".fromString() is linear in the number of cookies", (t) => {
    const count = 2000;
    const input = Array.from(
      { length: count },
      (_, index) => `k${index}=`,
    ).join(";");
    // The names of the cookies found so far are never searched among them
    const key = t.mock.getter(Cookie.prototype, "key");
    try {
      deepStrictEqual(Cookie.fromString(input).length, count);
      deepStrictEqual(key.mock.callCount() <= count, true);
    } finally {
      key.mock.restore();
    }
  });
});
