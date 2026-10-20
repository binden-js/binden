import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { suite, test } from "node:test";
import { BindenError } from "../index.js";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** The directory of the packages of the monorepo */
const packages = join(import.meta.dirname, "..", "..");

/**
 * The creations of an error that the scan finds, each with what it creates
 * (`null`: the name that it has matched). A static scan cannot follow every
 * value (e.g. a constructor passed as an argument): the errors that V8 or
 * Node.js create in a refusal of binden are also checked when it runs (see
 * `fixtures/created-error-retention.ts`).
 */
const creations: readonly (readonly [RegExp, string | null])[] = [
  // A construction, with or without `new` (a built-in constructor may be
  // called), of a name that ends with `Error` or `Exception`, maybe qualified
  // (e.g. `globalThis.TypeError`)
  [
    /(?:\bnew\s+)?(?<![\w$.])(?:[\w$]+\s*\.\s*)*(?<name>(?:[A-Z][\w$]*)?(?:Error|Exception))\s*\(/gu,
    null,
  ],
  // Of a class expression (e.g. `new (class extends Error {})()`)
  [/\bnew\s*\(/gu, "class expression"],
  [/\bReflect\s*\.\s*construct\s*\(/gu, "Reflect.construct"],
  // An abort without a reason, whose `AbortError` Node.js creates (but one
  // quoted in a comment, e.g. `Exchange.abort()`)
  [/\.abort\s*\(\s*\)(?!`)/gu, "abort()"],
  // A constructor kept in a variable, whose constructions are not seen
  [
    /\b(?:const|let|var)\s+[\w$]+\s*=\s*(?:[\w$]+\s*\.\s*)*(?<name>(?:[A-Z][\w$]*)?(?:Error|Exception))\s*[,;]/gu,
    null,
  ],
];

/**
 * The creations of errors (see `creations`) of a source that are not
 * formatted when they are created, as `file:line name`, in their order: each
 * one is passed to `formatStack()` at once, but a `BindenError`, which
 * formats itself
 */
function unformatted(file: string, source: string): string[] {
  const found: [number, string][] = [];
  for (const [pattern, label] of creations) {
    for (const { index, groups } of source.matchAll(pattern)) {
      const name = label ?? groups?.name ?? "";
      const before = source.slice(0, index);
      if (name !== "BindenError" && !/\bformatStack\(\s*$/u.test(before)) {
        const line = before.split("\n").length;
        found.push([index, `${file}:${line} ${name}`]);
      }
    }
  }
  return found.toSorted(([a], [b]) => a - b).map(([, entry]) => entry);
}

/**
 * The sources of every package (its `index.ts`, and every file of its
 * `src/`), by their paths relative to `packages/`
 */
function sources(): Map<string, string> {
  const all = new Map<string, string>();
  for (const name of readdirSync(packages)) {
    const src = join(packages, name, "src");
    const files = [
      "index.ts",
      // None of @binden/logger, whose code is its `index.ts`
      ...(existsSync(src) ? readdirSync(src, { recursive: true }) : [])
        .map(String)
        .filter((file) => file.endsWith(".ts"))
        .map((file) => join("src", file)),
    ];
    for (const file of files) {
      // With `/` on every platform (Windows joins with `\`)
      const path = join(name, file).replaceAll("\\", "/");
      all.set(path, readFileSync(join(packages, path), "utf8"));
    }
  }
  return all;
}

/**
 * Runs `run` while `Error.prepareStackTrace` records each error whose stack
 * V8 formats (once it is first read), and returns them with what `run`
 * returns (also what it throws)
 */
function recording(run: () => unknown): [unknown, WeakSet<object>] {
  const previous: unknown = Reflect.get(Error, "prepareStackTrace");
  const formatted = new WeakSet<object>();
  Reflect.set(
    Error,
    "prepareStackTrace",
    (error: Error, frames: readonly unknown[]): string => {
      formatted.add(error);
      return [
        `${error.name}: ${error.message}`,
        ...frames.map((frame) => `    at ${String(frame)}`),
      ].join("\n");
    },
  );
  try {
    return [run(), formatted];
  } catch (error: unknown) {
    return [error, formatted];
  } finally {
    Reflect.set(Error, "prepareStackTrace", previous);
  }
}

suite("Every error that a package of binden creates", () => {
  test("is formatted when it is created: a `BindenError`, or by `formatStack()` (a scan of the sources of every package)", () => {
    const all = sources();
    const found = [...all].flatMap(([file, source]) =>
      unformatted(file, source),
    );
    // Not vacuous: every package creates errors
    const created = (name: string): number =>
      [...all]
        .filter(([file]) => file.startsWith(`${name}/`))
        .reduce(
          (count, [, source]) =>
            count +
            creations.reduce(
              (sum, [pattern]) => sum + [...source.matchAll(pattern)].length,
              0,
            ),
          0,
        );
    for (const name of [
      "binden",
      "body",
      "compression",
      "logger",
      "multipart",
    ]) {
      ok(created(name) > 0, name);
    }
    deepStrictEqual(found, []);
  });

  test("the scan finds every creation of an error that is not formatted at once", () => {
    const source = [
      'throw new TypeError("not formatted");',
      'throw formatStack(new RangeError("formatted"));',
      "throw new BindenError(400);",
      "throw formatStack(",
      '  new Error("formatted"),',
      ");",
      'throw Object.assign(new Error("not formatted"), {});',
      'callback(new AggregateError([], "not formatted"));',
      // Without `new`
      'throw TypeError("not formatted");',
      'throw formatStack(URIError("formatted"));',
      'throw new DOMException("not formatted", "AbortError");',
      // Qualified
      'throw new globalThis.TypeError("not formatted");',
      'throw formatStack(new globalThis.SyntaxError("formatted"));',
      'throw Reflect.construct(RangeError, ["not formatted"]);',
      'throw formatStack(Reflect.construct(RangeError, ["formatted"]));',
      "controller.abort();",
      'controller.abort(formatStack(new BindenAbortError("deadline")));',
      "// See `Exchange.abort()`",
      // Another function whose name ends with `formatStack`
      'throw unformatStack(new Error("not formatted"));',
      'throw new (class Own extends Error {})("not formatted");',
      "const Constructor = TypeError;",
      'throw new Constructor("not seen");',
      // Neither creates an error
      "reportError(error);",
      "const failed = error instanceof TypeError;",
    ].join("\n");
    deepStrictEqual(unformatted("source.ts", source), [
      "source.ts:1 TypeError",
      "source.ts:7 Error",
      "source.ts:8 AggregateError",
      "source.ts:9 TypeError",
      "source.ts:11 DOMException",
      "source.ts:12 TypeError",
      "source.ts:14 Reflect.construct",
      "source.ts:16 abort()",
      "source.ts:19 Error",
      "source.ts:20 class expression",
      "source.ts:21 TypeError",
    ]);
  });
});

suite("A `BindenError`", () => {
  test("formats its stack in its constructor, also when the application creates it", () => {
    const [error, formatted] = recording(() => new BindenError(400));
    ok(error instanceof BindenError);
    ok(formatted.has(error));
    const { stack = "" } = error;
    ok(stack.startsWith("BindenError: Bad Request\n"), stack);
  });

  test("of a subclass is not formatted in the constructor of `BindenError`: its stack keeps the header that its own constructor gives it", () => {
    class Teapot extends BindenError {
      public constructor() {
        super(418, { message: "Short and stout" });
        this.name = "Teapot";
      }
    }
    const [error, formatted] = recording(() => new Teapot());
    ok(error instanceof Teapot);
    strictEqual(formatted.has(error), false);
    const { stack = "" } = error;
    ok(stack.startsWith("Teapot: Short and stout\n"), stack);
  });

  for (const [what, create, type] of [
    ["status", (): BindenError => new BindenError(99), RangeError],
    [
      "header",
      (): BindenError =>
        new BindenError(400, { headers: { "Content-Length": "1" } }),
      TypeError,
    ],
  ] as const) {
    test(`with an invalid ${what} throws an error that is formatted`, () => {
      const [error, formatted] = recording(create);
      strictEqual((error as Error).constructor, type);
      ok(formatted.has(error as Error));
    });
  }
});

/**
 * Runs the fixture of the errors that binden creates in a process of its
 * own, whose collections the test controls (`--expose-gc`): whether the
 * requests and the responses are collected while the application keeps the
 * errors
 */
function retained(mode: string): Record<string, unknown> {
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
  return { status, stdout, stderr };
}

suite(
  "An error that binden creates, kept by the application without its stack read, keeps neither the request nor the response",
  () => {
    for (const [mode, how, kept] of [
      ["argument", "the `TypeError` of `response.status(99)`", "TypeError"],
      [
        "dotfile",
        "the `403` of `sendFile()` for a dotfile that it denies",
        "BindenError 403",
      ],
      [
        "hidden",
        "the `404` of `sendFile()` for a dotfile that it ignores",
        "BindenError 404",
      ],
      [
        "outside",
        "the `404` of `sendFile()` for a path that leaves its root",
        "BindenError 404",
      ],
      [
        "url",
        "the `400` of `context.url` for an invalid `Host`",
        "BindenError 400",
      ],
      ["throw", "the `BindenError` of `context.throw()`", "BindenError 418"],
      [
        "redirect",
        "the `TypeError` of `response.redirect()` for a location that is not a URL",
        "TypeError",
      ],
      [
        "json",
        "the `TypeError` of `JSON.stringify()` that `response.json()` rejects with",
        "TypeError",
      ],
    ] as const) {
      test(how, () => {
        // 60 requests, whose errors are kept
        deepStrictEqual(retained(mode), {
          status: 0,
          stdout: `collected 60 ${kept}\n`,
          stderr: "",
        });
      });
    }
  },
);
