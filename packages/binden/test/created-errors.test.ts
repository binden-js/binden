import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { suite, test } from "node:test";
import { BindenError } from "../index.js";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** The directory of the packages of the monorepo */
const packages = join(import.meta.dirname, "..", "..");

/** Whitespace and comments, which may come between a name and its `(` */
const gap = String.raw`(?:\s|/\*(?:[^*]|\*(?!/))*\*/|//[^\n]*)*`;

/** A name that ends with `Error` or `Exception` (e.g. `DOMException`) */
const errorName = String.raw`(?:[A-Z][\w$]*)?(?:Error|Exception)`;

/**
 * The qualifiers of a name, maybe none (e.g. `globalThis.`), also optional
 * ones (e.g. `globalThis?.`)
 */
const qualifiers = String.raw`(?:[\w$]+\s*\??\.\s*)*`;

/**
 * The opening of a call after a name (`(`), also of an optional call (e.g.
 * `?.(`)
 */
const call = String.raw`${gap}(?:\?\.${gap})?\(`;

/**
 * The creations of an error that the scan finds, each with what it creates
 * (`null`: the name that it has matched): the constructions and calls of a
 * name that ends with `Error` or `Exception`, every class that extends one
 * and whose name does not end so (whose constructions it would not see), and
 * the calls that create an error or capture the frames of the caller.
 *
 * A static scan cannot see every creation: a constructor or a method that
 * it does not find by its name as it is called (e.g. passed as an argument,
 * returned by a call, an element of an array or a property of another name,
 * a part of an expression larger than the whole value of an assignment, e.g.
 * a conditional, a name in parentheses, a computed member, or the tag of a
 * template), a class that extends an expression (e.g. a mixin), an
 * `abort()` whose reason is `undefined` only at run time (e.g. a variable),
 * and the errors that V8 or Node.js create in the methods that binden calls
 * (e.g. the `TypeError` of a wrong argument). The check of those is at run
 * time: `fixtures/created-error-retention.ts`, for the refusals of binden. A
 * creation quoted in a comment or a string may be found too: the scan errs
 * towards a finding.
 */
const creations: readonly (readonly [RegExp, string | null])[] = [
  // A construction, with or without `new` (a built-in constructor may be
  // called, also optionally, e.g. `TypeError?.()`, by `call()` or `apply()`,
  // or once bound by `bind()`), maybe qualified (e.g. `globalThis.TypeError`)
  [
    new RegExp(
      String.raw`(?:\bnew\s+)?(?<![\w$.])${qualifiers}(?<name>${errorName})(?:\s*\??\.\s*(?:call|apply|bind))?${call}`,
      "gu",
    ),
    null,
  ],
  // A construction without arguments (e.g. `new TypeError;`)
  [
    new RegExp(
      String.raw`\bnew\s+${qualifiers}(?<name>${errorName})(?![\w$])(?!${gap}\()`,
      "gu",
    ),
    null,
  ],
  // Of a class expression (e.g. `new (class extends Error {})()` or
  // `new class extends Error {}()`)
  [/\bnew\s*\(/gu, "class expression"],
  [/\bnew\s+class\b/gu, "class expression"],
  // A class of an error whose name does not end with `Error` or `Exception`
  // (but a class expression constructed at once, found above)
  [
    new RegExp(
      String.raw`(?<!\bnew\s*\(?\s*)\bclass(?:\s+[\w$]+(?<!Error|Exception))?\s+extends\s+${qualifiers}${errorName}(?![\w$])`,
      "gu",
    ),
    "subclass",
  ],
  [
    new RegExp(String.raw`\bReflect\s*\??\.\s*construct${call}`, "gu"),
    "Reflect.construct",
  ],
  // An abort without a reason (none, `undefined` or a `void` expression),
  // whose `AbortError` Node.js creates (but one quoted in a comment, e.g.
  // `Exchange.abort()`), and a signal of a timeout, whose `TimeoutError` it
  // creates
  [
    new RegExp(
      String.raw`\.\s*abort${call}${gap}(?:\)(?!\x60)|undefined${gap}[,)]|void(?![\w$]))`,
      "gu",
    ),
    "abort()",
  ],
  [
    new RegExp(String.raw`\bAbortSignal\s*\??\.\s*timeout${call}`, "gu"),
    "AbortSignal.timeout()",
  ],
  // The frames of the caller, captured (but one quoted in a comment, e.g.
  // `Error.captureStackTrace()`)
  [
    new RegExp(String.raw`(?<![\w$])captureStackTrace${call}(?!\)\x60)`, "gu"),
    "captureStackTrace()",
  ],
  // A constructor kept in a variable, whose constructions are not seen: the
  // whole value of an assignment (a declaration, a plain or a logical
  // assignment, e.g. `E = TypeError` or `E ??= TypeError`, or a default),
  // but not a comparison, one that a destructuring reads (e.g. `const {
  // name } = TypeError`), the type of an alias, nor a member or a call of it
  // (found above)
  [
    new RegExp(
      String.raw`(?<![=!]|\}\s*|\btype\s+[\w$]+(?:<[^;]*>)?\s*)=${gap}${qualifiers}(?<name>${errorName})(?![\w$])(?!${gap}(?:\??\.|\[|\())`,
      "gu",
    ),
    null,
  ],
  // Or destructured, also by an assignment without a declaration (but a
  // type that an arrow function returns)
  [
    new RegExp(
      String.raw`\{[^}]*?(?<![\w$.])(?<name>${errorName})(?![\w$])[^}]*\}\s*=(?!>)`,
      "gu",
    ),
    null,
  ],
];

/**
 * The creations that the scan finds in the sources and that are allowed, as
 * `file name`: the probe of the engine in `exchange.ts`, whose frames
 * (captured once, when the module is loaded) are of no request
 */
const allowed: readonly string[] = [
  "binden/src/exchange.ts captureStackTrace()",
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

/** An entry of `unformatted()` without its line: `file name` */
function withoutLine(entry: string): string {
  return entry.replace(/:\d+ /u, " ");
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

suite("The errors that the packages of binden create", () => {
  test("are formatted when they are created (a `BindenError`, or by `formatStack()`), as far as a scan of the sources of every package sees: neither a constructor that it does not find by its name nor an error that V8 or Node.js create (checked at run time for the refusals of `fixtures/created-error-retention.ts`)", () => {
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
    deepStrictEqual(
      found.filter((entry) => !allowed.includes(withoutLine(entry))),
      [],
    );
    // Each one allowed is still there, once
    deepStrictEqual(
      found.map(withoutLine).filter((entry) => allowed.includes(entry)),
      allowed,
    );
  });

  test("the scan finds every form of a creation of an error that it knows, unless the error is formatted at once", () => {
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
      // A class whose constructions the scan would not see
      "class Failure extends Error {}",
      "export class Refusal extends globalThis.TypeError {}",
      "const Anonymous = class extends Error {};",
      "class TeapotError extends BindenError {}",
      'throw new class extends Error {}("not formatted");',
      // Without arguments, or with a comment before them
      "throw new TypeError;",
      "throw formatStack(new RangeError);",
      'throw new Error /* why */ ("not formatted");',
      'throw formatStack(new Error /* why */ ("formatted"));',
      "throw TypeError // why",
      '  ("not formatted");',
      'throw Error.call(undefined, "not formatted");',
      'throw formatStack(RangeError.apply(undefined, ["formatted"]));',
      "Error.captureStackTrace(target);",
      "// See `Error.captureStackTrace()`",
      "controller.abort(undefined);",
      "controller.abort(reason);",
      "const signal = AbortSignal.timeout(1000);",
      "const { TypeError: Destructured } = globalThis;",
      // Optional calls and qualifiers, and a bound constructor
      'throw TypeError?.("not formatted");',
      'throw formatStack(RangeError?.("formatted"));',
      'throw globalThis?.TypeError("not formatted");',
      'throw Error?.call?.(undefined, "not formatted");',
      'throw Error.bind(null)("not formatted");',
      'throw Reflect?.construct?.(RangeError, ["not formatted"]);',
      "controller?.abort?.();",
      "const deadline = AbortSignal?.timeout?.(1000);",
      "Error.captureStackTrace?.(target);",
      // An abort whose reason is `undefined`
      "controller.abort(void 0);",
      "controller.abort(undefined, reason);",
      // A constructor kept by an assignment without a declaration, a logical
      // one, a default or a destructuring
      "Assigned = TypeError;",
      "this.#constructor ??= globalThis.RangeError;",
      "function construct(Constructor = TypeError) {}",
      "({ TypeError: Assigned } = globalThis);",
      // None creates an error
      "reportError(error);",
      "const failed = error instanceof TypeError;",
      "class Cookies extends Set<Cookie> {}",
      "const { status, headers } = response;",
      "type Alias = TypeError;",
      "type Generic<T> = TypeError | T;",
      "const same = error.constructor === TypeError;",
      "const other = error.constructor != TypeError;",
      "const read = (): { error: TypeError } => value;",
      "const { name } = TypeError;",
      "const kind = TypeError.name;",
      "const codes = ErrorCodes;",
      "controller.abort(voided);",
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
      "source.ts:23 subclass",
      "source.ts:24 subclass",
      "source.ts:25 subclass",
      "source.ts:27 class expression",
      "source.ts:28 TypeError",
      "source.ts:30 Error",
      "source.ts:32 TypeError",
      "source.ts:34 Error",
      "source.ts:36 captureStackTrace()",
      "source.ts:38 abort()",
      "source.ts:40 AbortSignal.timeout()",
      "source.ts:41 TypeError",
      "source.ts:42 TypeError",
      "source.ts:44 TypeError",
      "source.ts:45 Error",
      "source.ts:46 Error",
      "source.ts:47 Reflect.construct",
      "source.ts:48 abort()",
      "source.ts:49 AbortSignal.timeout()",
      "source.ts:50 captureStackTrace()",
      "source.ts:51 abort()",
      "source.ts:52 abort()",
      "source.ts:53 TypeError",
      "source.ts:54 RangeError",
      "source.ts:55 TypeError",
      "source.ts:56 TypeError",
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
