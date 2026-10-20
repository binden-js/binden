import {
  Accept,
  AcceptCharset,
  AcceptLanguage,
  Authorization,
  ContentRange,
  ContentType,
  Cookie,
  Forwarded,
} from "../../index.js";
import { suite, test } from "node:test";
import { deepStrictEqual } from "node:assert/strict";

/**
 * Runs `run` while `Error.prepareStackTrace` counts the errors whose stacks
 * V8 formats (every error that binden creates is formatted at once): what
 * `run` returns, and how many errors it has created
 */
function counting<T>(run: () => T): [T, number] {
  const previous: unknown = Reflect.get(Error, "prepareStackTrace");
  let count = 0;
  Reflect.set(Error, "prepareStackTrace", (error: Error): string => {
    count += 1;
    return `${error.name}: ${error.message}`;
  });
  try {
    return [run(), count];
  } finally {
    Reflect.set(Error, "prepareStackTrace", previous);
  }
}

suite(
  "A header whose elements are invalid (e.g. of a client) is parsed without an error for each",
  () => {
    for (const [name, parse, valid] of [
      [
        "Cookie",
        (): unknown[] => Cookie.fromString('a=,; b="x y"; c d=1; e=1'),
        1,
      ],
      [
        "Accept",
        (): unknown[] =>
          Accept.fromString("x, */html, a/b;q=2, a/b;q=1;c=d, a/b;=1, a/b"),
        2,
      ],
      [
        "Accept-Charset",
        (): unknown[] => AcceptCharset.fromString("@, utf-8"),
        1,
      ],
      [
        "Accept-Language",
        (): unknown[] => AcceptLanguage.fromString("-, en-123456789, en"),
        1,
      ],
      [
        "Forwarded",
        (): unknown[] =>
          Forwarded.parse('for="\\\u0001", for=a').filter(
            (element) => element !== null,
          ),
        1,
      ],
      [
        "Content-Type",
        (): unknown[] =>
          [
            "x",
            "multipart/form-data",
            "text/plain; a=\u0001",
            "text/plain; charset=utf-8",
          ]
            .map((input) => ContentType.fromString(input))
            .filter((element) => element !== null),
        1,
      ],
      [
        "Content-Range",
        (): unknown[] =>
          [
            "bytes 5-1/9",
            "bytes 0-9/5",
            "bytes 0-99999999999999999999/1",
            "bytes */99999999999999999999",
            "bytes 0-1/9",
          ].flatMap((input) => ContentRange.fromString(input)),
        1,
      ],
      [
        "Authorization",
        (): unknown[] =>
          ["Basic a\u0001b", "Basic abc=="]
            .map((input) => Authorization.fromString(input))
            .filter((element) => element !== null),
        1,
      ],
    ] as const) {
      test(name, () => {
        const [elements, created] = counting(parse);
        deepStrictEqual([elements.length, created], [valid, 0]);
      });
    }
  },
);
