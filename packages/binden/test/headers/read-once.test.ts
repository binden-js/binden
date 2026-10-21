import {
  Accept,
  AcceptCharset,
  AcceptEncoding,
  AcceptLanguage,
  Authorization,
  ContentEncoding,
  ContentRange,
  ContentType,
  Cookie,
  Forwarded,
  IfModifiedSince,
  Range,
} from "../../index.js";
import { deepStrictEqual, throws } from "node:assert/strict";
import { suite, test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readdirSync } from "node:fs";

/** The reads of each property of an init (or of its parameters) */
type IReads = Map<string, number>;

/**
 * A dictionary whose properties each give the value of `second` from their
 * second read on (e.g. a getter of the application, every one of them
 * changing), and that counts the reads of each one in `reads`, as
 * `name.property`
 */
function changing<T extends object>(
  name: string,
  first: T,
  second: { readonly [K in keyof T]-?: unknown },
  reads: IReads,
): T {
  return new Proxy(first, {
    get: (target, key, receiver): unknown => {
      const read = `${name}.${String(key)}`;
      const count = (reads.get(read) ?? 0) + 1;
      reads.set(read, count);
      return count > 1 && Object.hasOwn(second, key)
        ? (second as Readonly<Record<PropertyKey, unknown>>)[key]
        : Reflect.get(target, key, receiver);
    },
  });
}

/**
 * The names of the classes of the headers: the default export of each module
 * of `src/headers/` that has one (none of its helpers has)
 */
async function headerClasses(): Promise<string[]> {
  const directory = join(import.meta.dirname, "..", "..", "src", "headers");
  const names: string[] = [];
  for (const file of readdirSync(directory)) {
    const { default: header } = (await import(
      pathToFileURL(join(directory, file)).href
    )) as { readonly default?: unknown };
    if (typeof header === "function") {
      names.push(header.name);
    }
  }
  return names;
}

/**
 * Each header class: a header constructed from an init (and parameters, for
 * the classes that have them) whose every value changes once it is read, and
 * the field value that it gives
 */
const cases: readonly (readonly [
  { readonly name: string },
  (reads: IReads) => unknown,
  string,
])[] = [
  [
    Accept,
    (reads): unknown =>
      new Accept(
        changing(
          "init",
          {
            type: "text/html",
            parameters: changing(
              "parameters",
              { level: "1" },
              { level: "1, */evil" },
              reads,
            ),
            q_value: 0.5,
          },
          { type: "a/b, */evil", parameters: { level: "2" }, q_value: 0.9 },
          reads,
        ),
      ),
    "text/html;level=1;q=0.5",
  ],
  [
    AcceptCharset,
    (reads): unknown =>
      new AcceptCharset(
        changing(
          "init",
          { charset: "utf-8", q_value: 0.5 },
          { charset: "utf-8, evil;q=2", q_value: 0.9 },
          reads,
        ),
      ),
    "utf-8;q=0.5",
  ],
  [
    AcceptEncoding,
    (reads): unknown =>
      new AcceptEncoding(
        changing(
          "init",
          { encoding: "gzip", q_value: 0.5 } as const,
          { encoding: "br", q_value: 0.9 },
          reads,
        ),
      ),
    "gzip;q=0.5",
  ],
  [
    AcceptLanguage,
    (reads): unknown =>
      new AcceptLanguage(
        changing(
          "init",
          { language: "en", q_value: 0.5 },
          { language: "en, evil", q_value: 0.9 },
          reads,
        ),
      ),
    "en;q=0.5",
  ],
  [
    Authorization,
    (reads): unknown =>
      new Authorization(
        changing(
          "init",
          { type: "Bearer", credentials: "abc" } as const,
          { type: "Basic", credentials: "abc\r\nInjected: 1" },
          reads,
        ),
      ),
    "Bearer abc",
  ],
  [
    ContentEncoding,
    (reads): unknown =>
      new ContentEncoding(
        changing(
          "init",
          { encoding: "gzip" } as const,
          { encoding: "br" },
          reads,
        ),
      ),
    "gzip",
  ],
  [
    ContentRange,
    (reads): unknown =>
      new ContentRange(
        changing(
          "init",
          { start: 0, end: 9, size: 10 },
          { start: 5, end: 99, size: 100 },
          reads,
        ),
      ),
    "bytes 0-9/10",
  ],
  [
    ContentType,
    (reads): unknown =>
      new ContentType(
        changing(
          "init",
          {
            type: "text/plain",
            charset: "utf-8",
            boundary: "ignored",
            parameters: changing(
              "parameters",
              { format: "flowed" },
              { format: "x\r\nInjected: 1" },
              reads,
            ),
          },
          {
            type: "text/html; evil",
            charset: "x\r\nInjected: 1",
            boundary: "other",
            parameters: { format: "fixed" },
          },
          reads,
        ),
      ),
    "text/plain; format=flowed; charset=utf-8",
  ],
  [
    Cookie,
    (reads): unknown =>
      new Cookie(
        changing(
          "init",
          {
            key: "sid",
            value: "abc",
            expires: new Date(0),
            max_age: null,
            domain: "example.com",
            path: "/",
            secure: true,
            http_only: true,
            same_site: "Strict",
            partitioned: false,
          } as const,
          {
            key: "sid=x; Secure; a",
            value: "x; Domain=evil.example",
            expires: new Date(1e12),
            max_age: 60,
            domain: "evil.example; Partitioned",
            path: "/; Domain=evil.example",
            secure: false,
            http_only: false,
            same_site: "None",
            partitioned: true,
          },
          reads,
        ),
      ),
    "sid=abc; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Domain=example.com; Path=/; Secure; HttpOnly; SameSite=Strict",
  ],
  [
    Forwarded,
    (reads): unknown =>
      new Forwarded(
        changing(
          "init",
          {
            for: "192.0.2.1",
            by: "192.0.2.2",
            host: "example.com",
            secret: "_hidden",
            proto: "https",
          },
          {
            for: 'x", by="evil',
            by: "\u0001",
            host: "evil.example, for=x",
            secret: "_other",
            proto: "\u0001",
          },
          reads,
        ),
      ),
    "for=192.0.2.1;by=192.0.2.2;host=example.com;secret=_hidden;proto=https",
  ],
  [
    IfModifiedSince,
    (reads): unknown =>
      new IfModifiedSince(
        changing(
          "init",
          { date: new Date(0) },
          { date: new Date(1e12) },
          reads,
        ),
      ),
    "Thu, 01 Jan 1970 00:00:00 GMT",
  ],
  [
    Range,
    (reads): unknown =>
      new Range(
        changing("init", { start: 0, end: 9 }, { start: 5, end: 1 }, reads),
      ),
    "bytes=0-9",
  ],
];

const classes = await headerClasses();

suite(
  "A header constructed from an init whose values change once they are read keeps the values that it has checked, each read once",
  () => {
    test("every header class has a case (each module of `src/headers/` that exports one)", () => {
      deepStrictEqual(
        cases.map(([header]) => header.name).toSorted(),
        classes.toSorted(),
      );
    });

    for (const [{ name }, create, expected] of cases) {
      test(name, () => {
        const reads: IReads = new Map();
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
