import { Binden, type BindenResponse, type Context, Cookie } from "../index.js";
import { listen, send, within } from "./helpers.js";
import { suite, test } from "node:test";
import { deepStrictEqual } from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** A value of any type, given in place of the one that a method declares */
function given<T>(value: unknown): T {
  return value as T;
}

/** `undefined`, which the linter does not let the tests write */
const none = ({} as { value?: undefined }).value;

/** A class, whose constructor cannot be called as a function */
class Stringify {
  public readonly created = Date.now();
}

/** A proxy that has been revoked: any operation on it throws */
function revoked<T extends object>(target: T): T {
  const { proxy, revoke } = Proxy.revocable(target, {});
  revoke();
  return proxy;
}

/**
 * An object that counts its conversions (`toString()`, `valueOf()` and
 * `Symbol.toPrimitive`), and its count: a refusal that describes it must not
 * convert it
 */
function counting(): [object, () => number] {
  let conversions = 0;
  const convert = (): string => {
    conversions += 1;
    return "200";
  };
  return [
    { toString: convert, valueOf: convert, [Symbol.toPrimitive]: convert },
    (): number => conversions,
  ];
}

/** What a call has settled with, and the response once it has */
interface ISettled {
  /**
   * `resolved`, `returned`, or the class and the message of its error, and
   * whether its stack was formatted once the caller got it (an error that
   * is not keeps the objects of its frames, e.g. the response)
   */
  readonly outcome: unknown;
  /**
   * Whether the headers were sent, the status, and the `Content-Type`,
   * `Vary`, `Location` and `Set-Cookie` headers
   */
  readonly state: unknown;
}

/**
 * Calls a method of the response once for a request, with arguments that
 * JavaScript may give in place of the declared ones, while
 * `Error.prepareStackTrace` records each error whose stack V8 formats: what
 * it has settled with, and the reply that the client gets once the
 * middleware has replied `200 replied` itself
 */
async function calling(
  call: (response: BindenResponse) => unknown,
): Promise<ISettled & { reply: unknown }> {
  const settled = Promise.withResolvers<ISettled>();
  const app = new Binden().use(async ({ response }: Context) => {
    const previous: unknown = Reflect.get(Error, "prepareStackTrace");
    const formatted = new WeakSet<object>();
    Reflect.set(
      Error,
      "prepareStackTrace",
      (error: Error, frames: readonly unknown[]): string => {
        formatted.add(error);
        return [`${error.name}: ${error.message}`, ...frames.map(String)].join(
          "\n    at ",
        );
      },
    );
    let outcome: unknown = "returned";
    try {
      const result = call(response);
      if (result instanceof Promise) {
        await result;
        outcome = "resolved";
      }
    } catch (error: unknown) {
      const { constructor, message } = error as Error;
      outcome = [constructor.name, message, formatted.has(error as Error)];
    } finally {
      Reflect.set(Error, "prepareStackTrace", previous);
    }
    settled.resolve({
      outcome,
      state: [
        response.headersSent,
        response.statusCode,
        ...["Content-Type", "Vary", "Location", "Set-Cookie"].map(
          (name) => response.getHeader(name) ?? null,
        ),
      ],
    });
    if (!response.headersSent) {
      await response.status(200).send("replied");
    }
  });
  const listening = await listen(app);
  try {
    const { status, body } = await send(listening.port);
    return { ...(await within(settled.promise)), reply: [status, body] };
  } finally {
    await listening.close();
  }
}

/** What a refusal leaves: nothing of the response changed, and its reply */
const unchanged = {
  state: [false, 200, null, null, null, null],
  reply: [200, "replied"],
};

/** A `TypeError` of binden, formatted once the caller gets it */
function refused(message: string): ISettled & { reply: unknown } {
  return { outcome: ["TypeError", message, true], ...unchanged };
}

/**
 * The values that a refusal describes without converting them (see
 * `described()`), with their description
 */
const values: readonly (readonly [unknown, string])[] = [
  ["x", "x"],
  [99, "99"],
  [true, "true"],
  [200n, "200n"],
  [null, "null"],
  [none, "undefined"],
  [Symbol("value"), "(a symbol)"],
  [(): number => 200, "(a function)"],
  [Object.create(null), "(an object)"],
  [revoked({}), "(an object)"],
];

suite(
  "The argument errors of the methods of binden describe the value that they refuse without converting it, formatted (R26-3)",
  () => {
    test("status(): every type", async () => {
      for (const [value, description] of values) {
        deepStrictEqual(
          await calling((response) => response.status(given(value))),
          refused(`Status code ${description} is invalid`),
          description,
        );
      }
      const [value, conversions] = counting();
      deepStrictEqual(
        await calling((response) => response.status(given(value))),
        refused("Status code (an object) is invalid"),
      );
      deepStrictEqual(conversions(), 0);
    });

    test("redirect() with a status that is not a redirect", async () => {
      const [value, conversions] = counting();
      for (const [status, description] of [
        [Symbol("status"), "(a symbol)"],
        [Object.create(null), "(an object)"],
        [value, "(an object)"],
        ["302", "302"],
      ] as const) {
        deepStrictEqual(
          await calling((response) => response.redirect("/", given(status))),
          refused(`Status code ${description} is not a redirect`),
          description,
        );
      }
      deepStrictEqual(conversions(), 0);
    });

    test("type()", async () => {
      const [value, conversions] = counting();
      for (const [type, description] of [
        [Symbol("type"), "(a symbol)"],
        [Object.create(null), "(an object)"],
        [value, "(an object)"],
        [null, "null"],
      ] as const) {
        deepStrictEqual(
          await calling((response) => response.type(given(type))),
          refused(`Invalid media type: ${description}`),
          description,
        );
      }
      deepStrictEqual(conversions(), 0);
    });

    test("vary(): a string before the regular expression, which would convert it (`null` and `5` would match it)", async () => {
      const [value, conversions] = counting();
      for (const [field, description] of [
        [Symbol("field"), "(a symbol)"],
        [Object.create(null), "(an object)"],
        [value, "(an object)"],
        [null, "null"],
        [5, "5"],
      ] as const) {
        deepStrictEqual(
          await calling((response) =>
            response.vary("Accept", given<string>(field)),
          ),
          refused(`Invalid field name: ${description}`),
          description,
        );
      }
      deepStrictEqual(conversions(), 0);
    });

    test("set(): anything but an object, before its entries are read (a string would set a header of each character)", async () => {
      for (const [headers, label] of [
        [null, "null"],
        [5, "a number"],
        ["ab", "a string"],
        [Symbol("headers"), "a symbol"],
        [(): null => null, "a function"],
      ] as const) {
        deepStrictEqual(
          await calling((response) => response.set(given(headers))),
          refused("`headers` is not an object"),
          label,
        );
      }
    });

    test("the encoding of send(), write() and end()", async () => {
      const [value, conversions] = counting();
      for (const [encoding, description] of [
        [Symbol("encoding"), "(a symbol)"],
        [Object.create(null), "(an object)"],
        [value, "(an object)"],
      ] as const) {
        deepStrictEqual(
          await calling((response) => response.send("data", given(encoding))),
          refused(`Unknown encoding: ${description}`),
          `send() ${description}`,
        );
        for (const method of ["write", "end"] as const) {
          deepStrictEqual(
            await calling((response) => {
              try {
                return response[method]("data", given(encoding));
              } catch (error: unknown) {
                // Its code, as Node.js gives it
                deepStrictEqual(
                  (error as { code?: unknown }).code,
                  "ERR_UNKNOWN_ENCODING",
                );
                throw error;
              }
            }),
            refused(`Unknown encoding: ${description}`),
            `${method}() ${description}`,
          );
        }
      }
      deepStrictEqual(conversions(), 0);
    });

    test("clearCookie() with a SameSite that is not one", async () => {
      const [value, conversions] = counting();
      for (const [same_site, description] of [
        [Symbol("same_site"), "(a symbol)"],
        [Object.create(null), "(an object)"],
        [value, "(an object)"],
        ["Loose", "Loose"],
      ] as const) {
        deepStrictEqual(
          await calling((response) =>
            response.clearCookie("a", { same_site: given(same_site) }),
          ),
          refused(`Invalid cookie SameSite: ${description}`),
          description,
        );
      }
      deepStrictEqual(conversions(), 0);
    });

    test("a Cookie with a Max-Age that is not an integer", () => {
      const [value, conversions] = counting();
      for (const [max_age, description] of [
        [Symbol("max_age"), "(a symbol)"],
        [Object.create(null), "(an object)"],
        [value, "(an object)"],
        [1.5, "1.5"],
        ["5", "5"],
        [5n, "5n"],
      ] as const) {
        let outcome: unknown = "constructed";
        try {
          // eslint-disable-next-line no-new -- refused by its constructor
          new Cookie({ key: "a", value: "b", max_age: given(max_age) });
        } catch (error: unknown) {
          const { constructor, message } = error as Error;
          outcome = [constructor.name, message];
        }
        deepStrictEqual(
          outcome,
          ["TypeError", `Invalid cookie Max-Age: ${description}`],
          description,
        );
      }
      deepStrictEqual(conversions(), 0);
    });
  },
);

suite(
  "What reading or calling an argument of a method of the response throws is formatted, also an error that V8 creates while the frames of the response are on the stack (R26-3)",
  () => {
    test("json() with a stringify that cannot be called (a class constructor, a revoked proxy), and one that throws", async () => {
      for (const [stringify, label] of [
        [Stringify, "a class constructor"],
        [revoked(() => "{}"), "a revoked proxy"],
      ] as const) {
        const { outcome, ...rest } = await calling((response) =>
          response.json({}, given(stringify)),
        );
        // The message of V8, which differs between its versions
        const [name, , formatted] = outcome as unknown[];
        deepStrictEqual(
          { outcome: [name, formatted], ...rest },
          { outcome: ["TypeError", true], ...unchanged },
          label,
        );
      }
      // An error of the application's own: the same error, formatted
      const own = new RangeError("own");
      deepStrictEqual(
        await calling(async (response) => {
          try {
            await response.json({}, () => {
              throw own;
            });
          } catch (error: unknown) {
            deepStrictEqual(error, own);
            throw error;
          }
        }),
        { outcome: ["RangeError", "own", true], ...unchanged },
      );
    });

    test("a revoked proxy given to set(), clearCookie(), send(), redirect() (as its location or its options), and the Expires of a cookie that is a proxy of a Date", async () => {
      for (const [call, label] of [
        [
          (response: BindenResponse): unknown => response.set(revoked({})),
          "set()",
        ],
        [
          (response: BindenResponse): unknown =>
            response.clearCookie("a", revoked({})),
          "clearCookie()",
        ],
        [
          (response: BindenResponse): unknown =>
            response.clearCookie(
              "a",
              given({ expires: new Proxy(new Date(0), {}) }),
            ),
          "the Expires of clearCookie()",
        ],
        [
          (response: BindenResponse): unknown =>
            response.send(given(revoked({}))),
          "send()",
        ],
        [
          (response: BindenResponse): unknown =>
            response.redirect(revoked(new URL("http://a/"))),
          "the location of redirect()",
        ],
        [
          (response: BindenResponse): unknown =>
            response.redirect("/", 302, revoked({})),
          "the options of redirect()",
        ],
      ] as const) {
        const { outcome, ...rest } = await calling(call);
        // The message of V8, which differs between its versions
        const [name, , formatted] = outcome as unknown[];
        deepStrictEqual(
          { outcome: [name, formatted], ...rest },
          { outcome: ["TypeError", true], ...unchanged },
          label,
        );
      }
    });

    test("redirect() still reads an inherited allow_external, as destructuring does", async () => {
      deepStrictEqual(
        await calling((response) =>
          response.redirect(
            "https://other.example/",
            302,
            Object.create({ allow_external: true }) as object,
          ),
        ),
        {
          outcome: "resolved",
          state: [true, 302, null, null, "https://other.example/", null],
          reply: [302, ""],
        },
      );
    });
  },
);

suite(
  "A refusal of a value that binden describes without converting it, or whose reading throws, kept by the application without its stack read, keeps neither the request nor the response (R26-3)",
  () => {
    for (const mode of [
      "statusSymbol",
      "statusNullProto",
      "redirectStatusNullProto",
      "typeSymbol",
      "varySymbol",
      "varyNull",
      "setNull",
      "sendEncodingNullProto",
      "writeEncodingNullProto",
      "clearSameSiteSymbol",
      "clearSameSiteNull",
      "clearExpiresProxy",
      "jsonClass",
      "jsonRevoked",
    ]) {
      test(mode, () => {
        const { status, stdout, stderr } = spawnSync(
          process.execPath,
          [
            "--expose-gc",
            "--no-warnings",
            "--import",
            "tsx",
            join(import.meta.dirname, "fixtures", "created-error-retention.ts"),
            mode,
          ],
          { encoding: "utf8", timeout: 30_000 },
        );
        // 60 requests, whose errors are kept
        deepStrictEqual(
          { status, stdout, stderr },
          { status: 0, stdout: "collected 60 TypeError\n", stderr: "" },
        );
      });
    }
  },
);
