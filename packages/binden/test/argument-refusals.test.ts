import { Binden, type BindenResponse, type Context } from "../index.js";
import { listen, send, within } from "./helpers.js";
import { suite, test } from "node:test";
import { deepStrictEqual } from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Calls a method of the response once for a request, with arguments that
 * JavaScript may give in place of the declared ones: what it has settled
 * with (the class and the message of its error), whether the headers were
 * sent then, its status and its `Content-Type` and `Location`, and the reply
 * that the client gets once the middleware has replied `200 replied` itself
 */
async function calling(
  call: (response: BindenResponse) => Promise<void>,
): Promise<{ outcome: unknown; state: unknown; reply: unknown }> {
  const settled = Promise.withResolvers<{ outcome: unknown; state: unknown }>();
  const app = new Binden().use(async ({ response }: Context) => {
    let outcome: unknown = "resolved";
    try {
      await call(response);
    } catch (error: unknown) {
      outcome = `${(error as Error).constructor.name}: ${(error as Error).message}`;
    }
    settled.resolve({
      outcome,
      state: [
        response.headersSent,
        response.statusCode,
        response.getHeader("Content-Type") ?? null,
        response.getHeader("Location") ?? null,
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

/** A value of any type, given in place of the one that a method declares */
function given<T>(value: unknown): T {
  return value as T;
}

/** What a refusal leaves: nothing of the response changed, and its reply */
const unchanged = { state: [false, 200, null, null], reply: [200, "replied"] };

suite(
  "The methods of the response refuse the arguments that they cannot take with a TypeError of binden, before they change anything (R24-2)",
  () => {
    test("json() with a stringify that is not a function", async () => {
      for (const [label, stringify] of [
        ["a number", 5],
        ["null", null],
        ["a string", "JSON.stringify"],
        ["an object", {}],
      ] as const) {
        deepStrictEqual(
          await calling((response) =>
            response.json({ a: 1 }, given<() => string>(stringify)),
          ),
          {
            outcome: "TypeError: `stringify` is not a function",
            ...unchanged,
          },
          label,
        );
      }
      // Without one, or with a function
      deepStrictEqual(
        await calling((response) => response.json({ a: 1 }, () => '{"b":2}')),
        {
          outcome: "resolved",
          state: [true, 200, "application/json", null],
          reply: [200, '{"b":2}'],
        },
      );
    });

    test("redirect() with options that are not an object", async () => {
      for (const [label, options] of [
        ["null", null],
        ["a number", 5],
        ["a string", "external"],
        ["a boolean", true],
      ] as const) {
        deepStrictEqual(
          await calling((response) =>
            response.redirect("/next", 303, given<object>(options)),
          ),
          { outcome: "TypeError: `options` is not an object", ...unchanged },
          label,
        );
      }
      // An object, also an empty one, or none
      for (const [label, call] of [
        [
          "{}",
          (response: BindenResponse): Promise<void> =>
            response.redirect("/next", 303, {}),
        ],
        [
          "allow_external",
          (response: BindenResponse): Promise<void> =>
            response.redirect("/next", 303, { allow_external: false }),
        ],
        [
          "none",
          (response: BindenResponse): Promise<void> =>
            response.redirect("/next", 303),
        ],
      ] as const) {
        deepStrictEqual(
          await calling(call),
          {
            outcome: "resolved",
            state: [true, 303, null, "/next"],
            reply: [303, ""],
          },
          label,
        );
      }
    });

    test("form() with anything but URLSearchParams (e.g. null, a string, an object that only looks like them, or a proxy of them)", async () => {
      for (const [label, params] of [
        ["null", null],
        ["a string", "a=1"],
        ["an object", { toString: (): string => "a=1" }],
        ["a lookalike", Object.create(URLSearchParams.prototype) as object],
        ["a proxy", new Proxy(new URLSearchParams("a=1"), {})],
      ] as const) {
        deepStrictEqual(
          await calling((response) =>
            response.form(given<URLSearchParams>(params)),
          ),
          {
            outcome: "TypeError: The parameters are not URLSearchParams",
            ...unchanged,
          },
          label,
        );
      }
    });

    test("form() with URLSearchParams sends them as Node.js serializes them, also of a subclass", async () => {
      class Params extends URLSearchParams {
        public override toString(): string {
          return `overridden ${this.size}`;
        }
      }
      for (const params of [
        new URLSearchParams([
          ["a", "1"],
          ["b", "x y"],
        ]),
        new Params([
          ["a", "1"],
          ["b", "x y"],
        ]),
      ]) {
        deepStrictEqual(
          await calling((response) => response.form(params)),
          {
            outcome: "resolved",
            state: [true, 200, "application/x-www-form-urlencoded", null],
            reply: [200, "a=1&b=x+y"],
          },
          params.constructor.name,
        );
      }
    });
  },
);

suite(
  "A refusal of an argument, kept by the application without its stack read, keeps neither the request nor the response",
  () => {
    for (const [mode, how] of [
      ["form", "of form(null)"],
      ["options", "of redirect() with null options"],
      ["stringify", "of json() with a stringify that is not a function"],
    ] as const) {
      test(how, () => {
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
