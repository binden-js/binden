import {
  Accept,
  AcceptCharset,
  AcceptLanguage,
  Cookie,
  Forwarded,
} from "../../index.js";
import { deepStrictEqual, throws } from "node:assert/strict";
import { suite, test } from "node:test";

/**
 * An init that counts the reads of each of its properties (`reads`), whose
 * properties in `second` give another value from their second read on (e.g.
 * a getter of the application)
 */
function changing<T extends object>(
  init: T,
  second: Readonly<Record<string, unknown>>,
  reads: Map<PropertyKey, number>,
): T {
  return new Proxy(init, {
    get: (target, key, receiver): unknown => {
      const count = (reads.get(key) ?? 0) + 1;
      reads.set(key, count);
      return count > 1 && typeof key === "string" && Object.hasOwn(second, key)
        ? second[key]
        : Reflect.get(target, key, receiver);
    },
  });
}

suite(
  "A header constructed from an init whose values change once they are read keeps the values that it has checked, each read once",
  () => {
    for (const [name, create, expected] of [
      [
        "Cookie",
        (reads: Map<PropertyKey, number>): unknown =>
          new Cookie(
            changing(
              { key: "sid", value: "abc", path: "/", domain: "example.com" },
              {
                key: "sid=x; Secure; a",
                value: "x; Domain=evil.example",
                path: "/; Domain=evil.example",
                domain: "evil.example; Partitioned",
              },
              reads,
            ),
          ),
        "sid=abc; Domain=example.com; Path=/; HttpOnly; SameSite=Lax",
      ],
      [
        "Accept",
        (reads: Map<PropertyKey, number>): unknown =>
          new Accept(
            changing(
              {
                type: "text/html",
                parameters: changing(
                  { level: "1" },
                  { level: "1, */evil" },
                  reads,
                ),
              },
              { type: "a/b, */evil" },
              reads,
            ),
          ),
        "text/html;level=1",
      ],
      [
        "AcceptCharset",
        (reads: Map<PropertyKey, number>): unknown =>
          new AcceptCharset(
            changing(
              { charset: "utf-8" },
              { charset: "utf-8, evil;q=2" },
              reads,
            ),
          ),
        "utf-8",
      ],
      [
        "AcceptLanguage",
        (reads: Map<PropertyKey, number>): unknown =>
          new AcceptLanguage(
            changing({ language: "en" }, { language: "en, evil" }, reads),
          ),
        "en",
      ],
      [
        "Forwarded",
        (reads: Map<PropertyKey, number>): unknown =>
          new Forwarded(
            changing(
              { for: "192.0.2.1", proto: "https" },
              { for: 'x", by="evil', proto: "\u0001" },
              reads,
            ),
          ),
        "for=192.0.2.1;proto=https",
      ],
    ] as const) {
      test(name, () => {
        const reads = new Map<PropertyKey, number>();
        const header = String(create(reads));
        deepStrictEqual(
          [header, [...reads].filter(([, count]) => count !== 1)],
          [expected, []],
        );
      });
    }

    test("Cookie (its `Expires`: the copy that it keeps is the date checked)", () => {
      // A date whose method tells another time than its own
      const lying = (time: number): Date =>
        Object.assign(new Date(time), { getTime: (): number => 0 });
      throws(
        () => new Cookie({ key: "a", value: "b", expires: lying(Number.NaN) }),
        { name: "TypeError", message: "Invalid cookie Expires" },
      );
      const cookie = new Cookie({
        key: "a",
        value: "b",
        expires: lying(1),
      });
      deepStrictEqual(cookie.expires?.getTime(), 1);
    });
  },
);
