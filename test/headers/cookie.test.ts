import { deepEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { Cookie } from "../../index.js";

describe("Cookie", () => {
  it("constructor (`__Secure-` prefix)", () => {
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
    deepEqual(cookie.key, key);
    deepEqual(cookie.value, value);
    deepEqual(cookie.expires, expires);
    deepEqual(cookie.max_age, max_age);
    deepEqual(cookie.path, "/");
    deepEqual(cookie.domain, domain);
    deepEqual(cookie.secure, true);
    deepEqual(cookie.http_only, http_only);
    deepEqual(cookie.same_site, same_site);
    deepEqual(
      cookie.toString(),
      `${key}=${value}; Max-Age=${max_age}; Domain=${domain}; Path=/; Secure; HttpOnly; SameSite=${same_site}`,
    );
  });

  it("constructor (`__Host-` prefix)", () => {
    const key = "__Host-ID";
    const value = "123";
    const expires = new Date();
    const domain = "example.com";
    const path = "/path";

    const cookie = new Cookie({ key, value, expires, domain, path });
    deepEqual(cookie.key, key);
    deepEqual(cookie.value, value);
    deepEqual(cookie.expires, expires);
    deepEqual(cookie.max_age, null);
    deepEqual(cookie.path, "/");
    deepEqual(cookie.domain, null);
    deepEqual(cookie.secure, true);
    deepEqual(cookie.http_only, true);
    deepEqual(cookie.same_site, "Lax");
    deepEqual(
      cookie.toString(),
      `${key}=${value}; Expires=${expires.toUTCString()}; Path=/; Secure; HttpOnly; SameSite=Lax`,
    );
  });

  it("constructor (SameSite=None)", () => {
    const key = "Key";
    const value = "Value";
    const same_site = "None";

    const cookie = new Cookie({ key, value, same_site });
    deepEqual(cookie.key, key);
    deepEqual(cookie.value, value);
    deepEqual(cookie.expires, null);
    deepEqual(cookie.max_age, null);
    deepEqual(cookie.path, "/");
    deepEqual(cookie.domain, null);
    deepEqual(cookie.secure, true);
    deepEqual(cookie.http_only, true);
    deepEqual(cookie.same_site, same_site);
    deepEqual(
      cookie.toString(),
      `${key}=${value}; Path=/; Secure; HttpOnly; SameSite=${same_site}`,
    );
  });

  it("constructor (Secure = false)", () => {
    const key = "Key";
    const value = "Value";
    const secure = false;

    const cookie = new Cookie({ key, value, secure });
    deepEqual(cookie.key, key);
    deepEqual(cookie.value, value);
    deepEqual(cookie.expires, null);
    deepEqual(cookie.max_age, null);
    deepEqual(cookie.path, "/");
    deepEqual(cookie.domain, null);
    deepEqual(cookie.secure, secure);
    deepEqual(cookie.http_only, true);
    deepEqual(cookie.same_site, "Lax");
    deepEqual(
      cookie.toString(),
      `${key}=${value}; Path=/; HttpOnly; SameSite=Lax`,
    );
  });

  it("constructor (Secure = true)", () => {
    const key = "Key";
    const value = "Value";
    const secure = true;
    const http_only = false;
    const path = null;

    const cookie = new Cookie({ key, value, secure, http_only, path });
    deepEqual(cookie.key, key);
    deepEqual(cookie.value, value);
    deepEqual(cookie.expires, null);
    deepEqual(cookie.max_age, null);
    deepEqual(cookie.path, path);
    deepEqual(cookie.domain, null);
    deepEqual(cookie.secure, secure);
    deepEqual(cookie.http_only, http_only);
    deepEqual(cookie.same_site, "Lax");
    deepEqual(cookie.toString(), `${key}=${value}; Secure; SameSite=Lax`);
  });

  it(".fromString()", () => {
    deepEqual(Cookie.fromString(), []);
    deepEqual(Cookie.fromString("a="), []);

    const input = ` Key1 = Value1 ; Key2   =  "Value2"  ; Key3 = " ; Key4=""`;
    const one = new Cookie({ key: "Key1", value: "Value1" });
    const two = new Cookie({ key: "Key2", value: "Value2" });

    const parsed = Cookie.fromString(input);

    deepEqual(parsed.length, 2);

    const [cookie1, cookie2] = parsed;

    deepEqual(cookie1.key, one.key);
    deepEqual(cookie1.value, one.value);
    deepEqual(cookie1.expires, one.expires);
    deepEqual(cookie1.max_age, one.max_age);
    deepEqual(cookie1.path, one.path);
    deepEqual(cookie1.domain, one.domain);
    deepEqual(cookie1.secure, one.secure);
    deepEqual(cookie1.http_only, one.http_only);
    deepEqual(cookie1.same_site, one.same_site);
    deepEqual(cookie1.toString(), one.toString());

    deepEqual(cookie2.key, two.key);
    deepEqual(cookie2.value, two.value);
    deepEqual(cookie2.expires, two.expires);
    deepEqual(cookie2.max_age, two.max_age);
    deepEqual(cookie2.path, two.path);
    deepEqual(cookie2.domain, two.domain);
    deepEqual(cookie2.secure, two.secure);
    deepEqual(cookie2.http_only, two.http_only);
    deepEqual(cookie2.same_site, two.same_site);
    deepEqual(cookie2.toString(), two.toString());
  });
});
