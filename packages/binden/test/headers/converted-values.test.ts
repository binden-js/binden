import {
  Accept,
  AcceptCharset,
  AcceptEncoding,
  AcceptLanguage,
  Authorization,
  ContentType,
  Cookie,
} from "../../index.js";
import { deepStrictEqual, ok, throws } from "node:assert/strict";
import { suite, test } from "node:test";

/**
 * A value of JavaScript in place of a string (or of a number), whose
 * `toString()` tells `first` on its first call, and `later` afterwards: how
 * many times it has been called
 */
interface IFlip {
  readonly value: unknown;
  calls(): number;
}

/** A value whose `toString()` changes once called (see `IFlip`) */
function flip(first: string, later: string): IFlip {
  let calls = 0;
  return {
    value: {
      toString(): string {
        calls += 1;
        return calls === 1 ? first : later;
      },
    },
    calls: () => calls,
  };
}

/** A value of any type, given in place of the one that an init declares */
function given<T>(value: unknown): T {
  return value as T;
}

suite(
  "A header constructed from values that are not strings keeps the strings that it has checked, each converted once (R3 P2-4)",
  () => {
    for (const [name, create, [first, later], expected] of [
      [
        "Cookie (its name)",
        (value: unknown): unknown =>
          new Cookie({ key: given(value), value: "v" }),
        ["a", "a=b; Domain=evil.example; x"],
        "a=v; Path=/; HttpOnly; SameSite=Lax",
      ],
      [
        "Cookie (its value)",
        (value: unknown): unknown =>
          new Cookie({ key: "session", value: given(value) }),
        ["v", "v; Domain=evil.example"],
        "session=v; Path=/; HttpOnly; SameSite=Lax",
      ],
      [
        "Cookie (its Domain)",
        (value: unknown): unknown =>
          new Cookie({ key: "a", value: "v", domain: given(value) }),
        ["example.com", "evil.example; Partitioned"],
        "a=v; Domain=example.com; Path=/; HttpOnly; SameSite=Lax",
      ],
      [
        "Cookie (its Path)",
        (value: unknown): unknown =>
          new Cookie({ key: "a", value: "v", path: given(value) }),
        ["/app", "/; Domain=evil.example"],
        "a=v; Path=/app; HttpOnly; SameSite=Lax",
      ],
      [
        "Accept (its media range)",
        (value: unknown): unknown => new Accept({ type: given(value) }),
        ["text/html", "text/html, */*"],
        "text/html",
      ],
      [
        "Accept (the value of a parameter)",
        (value: unknown): unknown =>
          new Accept({
            type: "text/html",
            parameters: { level: given(value) },
          }),
        ["1", "1, */*;q=1"],
        "text/html;level=1",
      ],
      [
        "ContentType (its media type)",
        (value: unknown): unknown => new ContentType({ type: given(value) }),
        ["text/plain", "text/plain; charset=evil"],
        "text/plain",
      ],
      [
        "ContentType (the value of a parameter)",
        (value: unknown): unknown =>
          new ContentType({
            type: "text/plain",
            parameters: { format: given(value) },
          }),
        ["flowed", "x\r\nX-Injected: 1"],
        "text/plain; format=flowed",
      ],
      [
        "AcceptCharset (its charset)",
        (value: unknown): unknown =>
          new AcceptCharset({ charset: given(value) }),
        ["utf-8", "utf-8, evil"],
        "utf-8",
      ],
      [
        "AcceptLanguage (its language range)",
        (value: unknown): unknown =>
          new AcceptLanguage({ language: given(value) }),
        ["en", "en, evil"],
        "en",
      ],
      [
        "Authorization (its credentials)",
        (value: unknown): unknown =>
          new Authorization({ type: "Bearer", credentials: given(value) }),
        ["token", "token, Basic evil"],
        "Bearer token",
      ],
    ] as const) {
      test(name, () => {
        const value = flip(first, later);
        const header = create(value.value);
        // Kept as checked, however many times it is serialized
        deepStrictEqual(
          [String(header), String(header), value.calls()],
          [expected, expected, 1],
        );
      });
    }
  },
);

suite(
  "A value of a header that cannot be converted to a string, or a weight that is not a number, is refused with a TypeError (R3 P2-4)",
  () => {
    test("a Symbol, or an object without a primitive value: a TypeError formatted at once", () => {
      const previous: unknown = Reflect.get(Error, "prepareStackTrace");
      const formatted = new WeakSet<object>();
      Reflect.set(
        Error,
        "prepareStackTrace",
        (error: Error, frames: readonly unknown[]): string => {
          formatted.add(error);
          return [error.message, ...frames.map(String)].join("\n");
        },
      );
      try {
        for (const [value, message] of [
          [Symbol("v"), "Cannot convert a Symbol value to a string"],
          [Object.create(null) as object, null],
        ] as const) {
          let caught: unknown = null;
          try {
            new Cookie({ key: "a", value: given(value) }).toString();
          } catch (error: unknown) {
            caught = error;
          }
          ok(caught instanceof TypeError);
          ok(formatted.has(caught));
          if (message !== null) {
            deepStrictEqual(caught.message, message);
          }
        }
      } finally {
        Reflect.set(Error, "prepareStackTrace", previous);
      }
    });

    test("a weight of Accept, AcceptCharset, AcceptLanguage or AcceptEncoding that is not a number, never converted", () => {
      for (const create of [
        (q_value: unknown): unknown =>
          new Accept({ type: "text/html", q_value: given(q_value) }),
        (q_value: unknown): unknown =>
          new AcceptCharset({ charset: "utf-8", q_value: given(q_value) }),
        (q_value: unknown): unknown =>
          new AcceptLanguage({ language: "en", q_value: given(q_value) }),
        (q_value: unknown): unknown =>
          new AcceptEncoding({ encoding: "gzip", q_value: given(q_value) }),
      ]) {
        for (const q_value of ["0.5", flip("0.5", "1, evil")]) {
          const value = typeof q_value === "string" ? q_value : q_value.value;
          throws(() => create(value), {
            name: "TypeError",
            message: "`q_value` is not a number",
          });
          if (typeof q_value !== "string") {
            deepStrictEqual(q_value.calls(), 0);
          }
        }
        deepStrictEqual(String(create(0.5)).endsWith(";q=0.5"), true);
      }
    });
  },
);
