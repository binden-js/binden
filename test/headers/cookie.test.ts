import { deepStrictEqual } from "node:assert";

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
      `${key}=${value}; Max-Age=${max_age}; Domain=${domain}; Path=/; Secure; HttpOnly; SameSite=${same_site}`
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
      `${key}=${value}; Expires=${expires.toUTCString()}; Path=/; Secure; HttpOnly; SameSite=Lax`
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
      `${key}=${value}; Path=/; Secure; HttpOnly; SameSite=${same_site}`
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
      `${key}=${value}; Path=/; HttpOnly; SameSite=Lax`
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
    deepStrictEqual(Cookie.fromString("a="), []);

    const input = ` Key1 = Value1 ; Key2   =  "Value2"  ; Key3 = " ; Key4=""`;
    const one = new Cookie({ key: "Key1", value: "Value1" });
    const two = new Cookie({ key: "Key2", value: "Value2" });

    const parsed = Cookie.fromString(input);

    deepStrictEqual(parsed.length, 2);

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
});
