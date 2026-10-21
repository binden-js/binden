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
import { suite, test } from "node:test";
import { deepStrictEqual } from "node:assert/strict";

/** `undefined`, which the linter does not let the tests write */
const none = ({} as { value?: undefined }).value;

/** A value of any type, given in place of the one that a method declares */
function given<T>(value: unknown): T {
  return value as T;
}

/** A proxy that has been revoked: any operation on it throws */
function revoked(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

/** The error of the test, which a getter of a proxy throws (see `throwing()`) */
let own = new RangeError("A getter of the test");

/**
 * A proxy whose every read throws the error of the test, a new one (whose
 * stack is not formatted yet)
 */
function throwing(): object {
  const error = new RangeError("A getter of the test");
  own = error;
  return new Proxy(
    {},
    {
      get: (): never => {
        throw error;
      },
    },
  );
}

/** The conversions of the values of `counting()` */
let conversions = 0;

/**
 * An object that counts its conversions (`toString()`, `valueOf()` and
 * `Symbol.toPrimitive`): a refusal must not convert it
 */
function counting(text = "a"): object {
  const convert = (): string => {
    conversions += 1;
    return text;
  };
  return { toString: convert, valueOf: convert, [Symbol.toPrimitive]: convert };
}

/**
 * What a call has done, while `Error.prepareStackTrace` records the errors
 * whose stacks V8 formats: `returned` and its value, or the class and the
 * message of its error, whether its stack was formatted once the caller got
 * it, and whether it is the error of the test itself
 */
function outcome(run: () => unknown): unknown {
  const previous: unknown = Reflect.get(Error, "prepareStackTrace");
  const formatted = new WeakSet<object>();
  Reflect.set(Error, "prepareStackTrace", (error: Error): string => {
    formatted.add(error);
    return `${error.name}: ${error.message}`;
  });
  try {
    return ["returned", run()];
  } catch (error: unknown) {
    const { constructor, message } = error as Error;
    return [
      constructor.name,
      message,
      formatted.has(error as Error),
      error === own,
    ];
  } finally {
    Reflect.set(Error, "prepareStackTrace", previous);
  }
}

/** A refusal of binden: a formatted `TypeError` of the message */
function refused(message: string): unknown {
  return ["TypeError", message, true, false];
}

/** The parsers of the headers that take one field value only */
const values: readonly (readonly [
  string,
  (input: unknown) => unknown,
  string,
  unknown,
])[] = [
  [
    "Authorization",
    (input): unknown => Authorization.fromString(given(input)),
    "Unknown",
    null,
  ],
  [
    "ContentEncoding",
    (input): unknown => ContentEncoding.fromString(given(input)),
    "unknown",
    null,
  ],
  [
    "ContentRange",
    (input): unknown => ContentRange.fromString(given(input)),
    "bytes 1-0/5",
    [],
  ],
  [
    "ContentType",
    (input): unknown => ContentType.fromString(given(input)),
    "text",
    null,
  ],
  ["Cookie", (input): unknown => Cookie.fromString(given(input)), "a", []],
  [
    "IfModifiedSince",
    (input): unknown => IfModifiedSince.fromString(given(input)),
    "yesterday",
    null,
  ],
  [
    "Range",
    (input): unknown => Range.fromString(given(input)),
    "bytes=2-1",
    [],
  ],
];

/** The parsers of the headers that take their field lines too */
const lines: readonly (readonly [
  string,
  (input: unknown) => unknown,
  string,
  unknown,
])[] = [
  ["Accept", (input): unknown => Accept.fromString(given(input)), "text", []],
  [
    "AcceptCharset",
    (input): unknown => AcceptCharset.fromString(given(input)),
    "utf-8;q=2",
    [],
  ],
  [
    "AcceptEncoding",
    (input): unknown => AcceptEncoding.fromString(given(input)),
    "unknown",
    [],
  ],
  [
    "AcceptLanguage",
    (input): unknown => AcceptLanguage.fromString(given(input)),
    "1",
    [],
  ],
  [
    "Forwarded",
    (input): unknown => Forwarded.fromString(given(input)),
    "for",
    [],
  ],
  [
    "Forwarded.parse",
    (input): unknown => Forwarded.parse(given(input)),
    "for",
    [null],
  ],
];

suite(
  "A parser of a header refuses a value outside its declared types with a formatted TypeError, before it converts it (R27-1)",
  () => {
    test("of one field value: anything but undefined and a string (e.g. null, a number, an array, or an object), described", () => {
      for (const [name, parse, malformed, nothing] of values) {
        conversions = 0;
        deepStrictEqual(
          [
            outcome((): unknown => parse(null)),
            outcome((): unknown => parse(5)),
            outcome((): unknown => parse([malformed])),
            outcome((): unknown => parse(Symbol("s"))),
            outcome((): unknown => parse(counting())),
          ],
          [
            refused("The header is not a string: null"),
            refused("The header is not a string: 5"),
            refused("The header is not a string: (an object)"),
            refused("The header is not a string: (a symbol)"),
            refused("The header is not a string: (an object)"),
          ],
          name,
        );
        deepStrictEqual(conversions, 0, name);
        // Its declared forms: malformed text keeps its result
        deepStrictEqual(
          outcome((): unknown => parse(malformed)),
          ["returned", nothing],
        );
        deepStrictEqual(
          (outcome((): unknown => parse(none)) as unknown[])[0],
          "returned",
          name,
        );
      }
    });

    test("of field lines: anything but undefined, a string and an array of strings, each element read once, described", () => {
      for (const [name, parse, malformed, nothing] of lines) {
        conversions = 0;
        deepStrictEqual(
          [
            outcome((): unknown => parse(null)),
            outcome((): unknown => parse(5)),
            outcome((): unknown => parse(counting())),
            outcome((): unknown => parse([malformed, counting()])),
            outcome((): unknown => parse([null])),
            outcome((): unknown => parse(revoked())),
            outcome((): unknown => parse(throwing())),
            outcome((): unknown => parse([throwing()])),
          ],
          [
            refused("The header is not an array: null"),
            refused("The header is not an array: 5"),
            refused("The header is not an array: (an object)"),
            refused("A field line is not a string: (an object)"),
            refused("A field line is not a string: null"),
            [
              "TypeError",
              "Cannot perform 'IsArray' on a proxy that has been revoked",
              true,
              false,
            ],
            refused("The header is not an array: (an object)"),
            refused("A field line is not a string: (an object)"),
          ],
          name,
        );
        deepStrictEqual(conversions, 0, name);
        deepStrictEqual(
          outcome((): unknown => parse(malformed)),
          ["returned", nothing],
        );
        deepStrictEqual(
          outcome((): unknown => parse([malformed])),
          ["returned", nothing],
        );
        deepStrictEqual(
          outcome((): unknown => parse([])),
          ["returned", []],
        );
      }
    });

    test("an array of field lines is read once, by its indexes (a getter that changes a line on its second read changes nothing)", () => {
      let reads = 0;
      const changing = new Proxy(["gzip"], {
        get: (target, key, receiver): unknown => {
          if (key === "0") {
            reads += 1;
            return reads === 1 ? "gzip" : given<string>(counting());
          }
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
      deepStrictEqual(AcceptEncoding.fromString(changing).map(String), [
        "gzip",
      ]);
      deepStrictEqual(reads, 1);
    });

    test("negotiate(): offers that are not an array, an offer that is not a string (described, not converted), and a header of another type", () => {
      for (const [name, negotiate, refusal, offer] of [
        [
          "Accept",
          (
            offers: readonly string[],
            input?: string[] | string,
          ): string | false => Accept.negotiate(offers, input),
          "Invalid media type",
          "text/html",
        ],
        [
          "AcceptCharset",
          (
            offers: readonly string[],
            input?: string[] | string,
          ): string | false => AcceptCharset.negotiate(offers, input),
          "Invalid charset",
          "utf-8",
        ],
        [
          "AcceptEncoding",
          (
            offers: readonly string[],
            input?: string[] | string,
          ): string | false => AcceptEncoding.negotiate(offers, input),
          "Invalid content coding",
          "gzip",
        ],
        [
          "AcceptLanguage",
          (
            offers: readonly string[],
            input?: string[] | string,
          ): string | false => AcceptLanguage.negotiate(offers, input),
          "Invalid language tag",
          "en",
        ],
      ] as const) {
        conversions = 0;
        deepStrictEqual(
          [
            outcome((): unknown => negotiate(given(null))),
            outcome((): unknown => negotiate(given(offer))),
            outcome((): unknown => negotiate(given([offer, counting(offer)]))),
            outcome((): unknown => negotiate(given([5]))),
            outcome((): unknown => negotiate([offer], given(null))),
            outcome((): unknown =>
              negotiate([offer], given([counting(offer)])),
            ),
            outcome((): unknown => negotiate(given(throwing()))),
          ],
          [
            refused("`offers` is not an array: null"),
            refused(`\`offers\` is not an array: ${offer}`),
            refused(`${refusal}: (an object)`),
            refused(`${refusal}: 5`),
            refused("The header is not an array: null"),
            refused("A field line is not a string: (an object)"),
            refused("`offers` is not an array: (an object)"),
          ],
          name,
        );
        deepStrictEqual(conversions, 0, name);
        // Its declared forms
        deepStrictEqual(
          [
            negotiate([offer]),
            negotiate([offer], offer),
            negotiate([offer], [offer]),
            negotiate([]),
          ],
          [offer, offer, offer, false],
          name,
        );
      }
    });

    test("negotiate(): the offers are read once, by their indexes", () => {
      let reads = 0;
      const changing = new Proxy(["text/html"], {
        get: (target, key, receiver): unknown => {
          if (key === "0") {
            reads += 1;
            return reads === 1 ? "text/html" : "text/evil";
          }
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
      deepStrictEqual(Accept.negotiate(changing, "text/*"), "text/html");
      deepStrictEqual(reads, 1);
    });
  },
);

/** Each class of a header, with a valid init */
const inits: readonly (readonly [
  string,
  (init: unknown) => unknown,
  object,
])[] = [
  ["Accept", (init): unknown => new Accept(given(init)), { type: "text/html" }],
  [
    "AcceptCharset",
    (init): unknown => new AcceptCharset(given(init)),
    { charset: "utf-8" },
  ],
  [
    "AcceptEncoding",
    (init): unknown => new AcceptEncoding(given(init)),
    { encoding: "gzip" },
  ],
  [
    "AcceptLanguage",
    (init): unknown => new AcceptLanguage(given(init)),
    { language: "en" },
  ],
  [
    "Authorization",
    (init): unknown => new Authorization(given(init)),
    { type: "Basic" },
  ],
  [
    "ContentEncoding",
    (init): unknown => new ContentEncoding(given(init)),
    { encoding: "gzip" },
  ],
  [
    "ContentRange",
    (init): unknown => new ContentRange(given(init)),
    { start: 0, end: 1, size: 2 },
  ],
  [
    "ContentType",
    (init): unknown => new ContentType(given(init)),
    { type: "text/plain" },
  ],
  [
    "Cookie",
    (init): unknown => new Cookie(given(init)),
    { key: "a", value: "b" },
  ],
  [
    "Forwarded",
    (init): unknown => new Forwarded(given(init)),
    { for: "unknown" },
  ],
  [
    "IfModifiedSince",
    (init): unknown => new IfModifiedSince(given(init)),
    { date: new Date(0) },
  ],
  ["Range", (init): unknown => new Range(given(init)), { start: 0 }],
];

suite(
  "A header constructed from an init that is not an object, or that throws once read, throws a formatted error (R27-1)",
  () => {
    test("anything but an object (e.g. null, undefined, a string, whose properties destructuring would read, or a function) is refused, described", () => {
      for (const [name, create, init] of inits) {
        deepStrictEqual(
          [
            outcome((): unknown => create(null)),
            outcome((): unknown => create(none)),
            outcome((): unknown => create("abc")),
            outcome((): unknown => create(Symbol("s"))),
            outcome((): unknown => create((): object => init)),
          ],
          [
            refused("`init` is not an object: null"),
            refused("`init` is not an object: undefined"),
            refused("`init` is not an object: abc"),
            refused("`init` is not an object: (a symbol)"),
            refused("`init` is not an object: (a function)"),
          ],
          name,
        );
        deepStrictEqual(
          (outcome((): unknown => create(init)) as unknown[])[0],
          "returned",
          name,
        );
      }
    });

    test("an init that a revoked proxy is, or whose getter throws, throws the error of V8 (or of the getter itself), formatted", () => {
      for (const [name, create] of inits) {
        deepStrictEqual(
          [
            outcome((): unknown => create(revoked())),
            outcome((): unknown => create(throwing())),
          ],
          [
            [
              "TypeError",
              "Cannot perform 'get' on a proxy that has been revoked",
              true,
              false,
            ],
            ["RangeError", "A getter of the test", true, true],
          ],
          name,
        );
      }
    });

    test("parameters of Accept and ContentType that are not an object are refused, described (a string would add a parameter of each character)", () => {
      for (const parameters of ["ab", null, 5]) {
        deepStrictEqual(
          [
            outcome(
              (): unknown =>
                new Accept({
                  type: "text/html",
                  parameters: given(parameters),
                }),
            ),
            outcome(
              (): unknown =>
                new ContentType({
                  type: "text/plain",
                  parameters: given(parameters),
                }),
            ),
          ],
          [
            refused(`\`parameters\` is not an object: ${String(parameters)}`),
            refused(`\`parameters\` is not an object: ${String(parameters)}`),
          ],
        );
      }
    });

    test("an unknown coding or scheme is described, never converted", () => {
      conversions = 0;
      deepStrictEqual(
        [
          outcome(
            (): unknown => new AcceptEncoding({ encoding: given(counting()) }),
          ),
          outcome(
            (): unknown => new ContentEncoding({ encoding: given(counting()) }),
          ),
          outcome(
            (): unknown => new Authorization({ type: given(counting()) }),
          ),
          outcome(
            (): unknown =>
              new ContentEncoding({ encoding: given(Symbol("s")) }),
          ),
        ],
        [
          refused("Unknown content coding: (an object)"),
          refused("Unknown content coding: (an object)"),
          refused("Unsupported authentication scheme: (an object)"),
          refused("Unknown content coding: (a symbol)"),
        ],
      );
      deepStrictEqual(conversions, 0);
    });

    test("the date of IfModifiedSince: a Date by its time (never its methods), a number or a string; anything else refused, described", () => {
      conversions = 0;
      class Shifted extends Date {
        // eslint-disable-next-line class-methods-use-this -- another time
        public override getTime(): number {
          return 0;
        }
      }
      const date = new Date("2020-01-01T00:00:00Z");
      deepStrictEqual(
        [
          String(new IfModifiedSince({ date: new Shifted(date.getTime()) })),
          String(new IfModifiedSince({ date: given(date.getTime()) })),
          String(new IfModifiedSince({ date: given(date.toUTCString()) })),
          outcome((): unknown => new IfModifiedSince({ date: given(null) })),
          outcome(
            (): unknown => new IfModifiedSince({ date: given(counting()) }),
          ),
          outcome(
            (): unknown =>
              new IfModifiedSince({ date: given(new Proxy(date, {})) }),
          ),
          outcome(
            (): unknown => new IfModifiedSince({ date: given("tomorrow") }),
          ),
        ],
        [
          date.toUTCString(),
          date.toUTCString(),
          date.toUTCString(),
          refused("The date is not a Date: null"),
          refused("The date is not a Date: (an object)"),
          refused("The date is not a Date: (an object)"),
          refused("Invalid date"),
        ],
      );
      deepStrictEqual(conversions, 0);
    });

    test("the Expires of a Cookie: a Date by its time, a proxy of a Date refused", () => {
      const date = new Date("2020-01-01T00:00:00Z");
      class Shifted extends Date {
        // eslint-disable-next-line class-methods-use-this -- another time
        public override getTime(): number {
          return 0;
        }
      }
      deepStrictEqual(
        [
          new Cookie({
            key: "a",
            value: "b",
            expires: new Shifted(date.getTime()),
          }).expires?.toISOString(),
          outcome(
            (): unknown =>
              new Cookie({
                key: "a",
                value: "b",
                expires: new Proxy(date, {}),
              }),
          ),
        ],
        [date.toISOString(), refused("The Expires is not a Date")],
      );
    });
  },
);
