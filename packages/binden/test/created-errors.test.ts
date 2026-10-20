import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { suite, test } from "node:test";
import { BindenError } from "../index.js";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** The directory of the packages of the monorepo */
const packages = join(import.meta.dirname, "..", "..");

/** A construction of an error: `new …Error(` */
const construction = /\bnew\s+(?<name>[\w$]*Error)\s*\(/gu;

/**
 * The constructions of errors (see `construction`) of a source that are not
 * formatted when they are created, as `file:line name`: each one is passed
 * to `formatStack()` at once, but a `BindenError`, which formats itself
 */
function unformatted(file: string, source: string): string[] {
  const found: string[] = [];
  for (const { index, groups } of source.matchAll(construction)) {
    const name = groups?.name ?? "";
    const before = source.slice(0, index).trimEnd();
    if (name !== "BindenError" && !before.endsWith("formatStack(")) {
      const line = before.split("\n").length;
      found.push(`${file}:${line} ${name}`);
    }
  }
  return found;
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
            count + [...source.matchAll(construction)].length,
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

  test("the scan finds every construction of an error that is not formatted at once", () => {
    const source = [
      'throw new TypeError("not formatted");',
      'throw formatStack(new RangeError("formatted"));',
      "throw new BindenError(400);",
      "throw formatStack(",
      '  new Error("formatted"),',
      ");",
      'throw Object.assign(new Error("not formatted"), {});',
      'callback(new AggregateError([], "not formatted"));',
    ].join("\n");
    deepStrictEqual(unformatted("source.ts", source), [
      "source.ts:1 TypeError",
      "source.ts:7 Error",
      "source.ts:8 AggregateError",
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
