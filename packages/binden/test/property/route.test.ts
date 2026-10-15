import { BindenError, type IParams, Stack } from "../../index.js";
import { compile, matchPrefix, matchRoute } from "../../src/route.js";
import { deepStrictEqual, ok, throws } from "node:assert/strict";
import { suite, test } from "node:test";
import { check } from "./check.js";
import fc from "fast-check";

/** A segment of a pattern: a literal, a parameter, or the tail */
type ISpec =
  | { readonly literal: string }
  | { readonly param: string }
  | { readonly tail: string };

/** The fragments of the patterns (some of them invalid) */
const patternFragments: readonly string[] = [
  "/",
  ":",
  "*",
  "\\",
  "\\:",
  "\\*",
  ":id",
  "*rest",
  ":_a1",
  ":1",
  "a",
  "B",
  "_",
  "-",
  ".",
  "%",
  "%41",
];

/** A pattern as registered: a `/` and fragments */
const anyPattern = fc
  .array(fc.constantFrom(...patternFragments), { maxLength: 8 })
  .map((parts) => `/${parts.join("")}`);

/**
 * Compiles a pattern by the grammar of `route()` and `mount()` (written
 * apart from `compile()`): its segments, or `null` when it is invalid
 */
function grammar(pattern: string, kind: "mount" | "route"): ISpec[] | null {
  if (!pattern.startsWith("/")) {
    return null;
  }
  const raw = pattern.slice(1).split("/");
  if (kind === "mount" && raw.at(-1) === "") {
    raw.pop();
  }
  const names: string[] = [];
  const specs: ISpec[] = [];
  for (const [index, segment] of raw.entries()) {
    const name = segment.slice(1);
    if (segment.startsWith(":") || segment.startsWith("*")) {
      const last = index === raw.length - 1;
      if (
        !/^[A-Za-z_]\w*$/u.test(name) ||
        names.includes(name) ||
        (segment.startsWith("*") && (kind === "mount" || !last))
      ) {
        return null;
      }
      names.push(name);
      specs.push(segment.startsWith(":") ? { param: name } : { tail: name });
    } else {
      // `\:` and `\*` are literal, and no other `\`, `:` or `*` may occur
      const literal = segment.replaceAll(/\\(?<char>[:*])/gu, "$<char>");
      if (/[:*\\]/u.test(segment.replaceAll(/\\[:*]/gu, ""))) {
        return null;
      }
      specs.push({ literal });
    }
  }
  return specs;
}

/** A value of a segment, decoded once: `null` when it cannot be decoded */
function decoded(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** The options of the matching */
interface IOptions {
  readonly case_sensitive: boolean;
  readonly strict: boolean;
  readonly encoded_slashes: boolean;
}

/** `400 Bad Request` */
const BAD_REQUEST = "400";

/**
 * Matches the segments of a path with the segments of a pattern (from the
 * first one; `prefix` matches the leading ones only): the parameters, `null`
 * for no match, or `400` for a matching path with a parameter that cannot be
 * decoded (or that has an encoded slash, unless `encoded_slashes`)
 */
function reference(
  specs: readonly ISpec[],
  path: string,
  options: IOptions,
  prefix = false,
): IParams | typeof BAD_REQUEST | null {
  let parts = path.slice(1).split("/");
  let segments = specs.filter((spec) => !("tail" in spec));
  const tail = specs.find((spec) => "tail" in spec);
  if (!prefix && !options.strict) {
    // One trailing `/` of the path or of the pattern may be missing
    if (parts.length > 1 && parts.at(-1) === "") {
      parts = parts.slice(0, -1);
    }
    const last = segments.at(-1);
    if (
      !tail &&
      segments.length > 1 &&
      last &&
      "literal" in last &&
      last.literal === ""
    ) {
      segments = segments.slice(0, -1);
    }
  }
  const fits =
    prefix || tail
      ? parts.length >= segments.length
      : parts.length === segments.length;
  if (!fits) {
    return null;
  }
  const same = (part: string, literal: string): boolean => {
    const value = decoded(part);
    return (
      part === literal ||
      (value !== null &&
        (options.case_sensitive
          ? value === literal
          : value.toLowerCase() === literal.toLowerCase()))
    );
  };
  for (const [index, segment] of segments.entries()) {
    const part = parts[index] ?? "";
    if ("literal" in segment ? !same(part, segment.literal) : part === "") {
      return null;
    }
  }
  const value = (part: string): string | null => {
    const once = decoded(part);
    return once === null || (!options.encoded_slashes && /[/\\]/u.test(once))
      ? null
      : once;
  };
  const params: [string, string][] = [];
  for (const [index, segment] of segments.entries()) {
    if ("param" in segment) {
      const once = value(parts[index] ?? "");
      if (once === null) {
        return BAD_REQUEST;
      }
      params.push([segment.param, once]);
    }
  }
  if (tail && "tail" in tail) {
    const rest = parts.slice(segments.length).map((part) => value(part));
    if (rest.includes(null)) {
      return BAD_REQUEST;
    }
    params.push([tail.tail, rest.join("/")]);
  }
  return Object.fromEntries(params);
}

/** The result of a matcher: its value, or `400` for a `BindenError` (400) */
function outcome<T>(match: () => T): T | typeof BAD_REQUEST {
  try {
    return match();
  } catch (error: unknown) {
    ok(error instanceof BindenError && error.status === 400, String(error));
    return BAD_REQUEST;
  }
}

/** A valid pattern of a kind, with its segments */
function validPattern(
  kind: "mount" | "route",
): fc.Arbitrary<{ pattern: string; specs: ISpec[] }> {
  return anyPattern
    .map((pattern) => ({ pattern, specs: grammar(pattern, kind) }))
    .filter(
      (compiled): compiled is { pattern: string; specs: ISpec[] } =>
        compiled.specs !== null,
    );
}

const options = fc.record({
  case_sensitive: fc.boolean(),
  strict: fc.boolean(),
  encoded_slashes: fc.boolean(),
});

/** A value of a parameter: any characters, `%` and encoded ones among them */
const paramValue = fc.string({
  unit: fc.constantFrom(
    "a",
    "Z",
    "%",
    "2",
    "5",
    "4",
    "1",
    "F",
    "/",
    "\\",
    " ",
    "é",
    "€",
    "?",
    "#",
    ":",
  ),
  minLength: 1,
  maxLength: 8,
});

/** The fragments of the paths */
const pathFragments: readonly string[] = [
  "/",
  "a",
  "A",
  "B",
  "_",
  "-",
  ".",
  "%",
  "%41",
  "%61",
  "%2F",
  "%5c",
  "%25",
  "%2541",
  "%E2%82%AC",
  "%E2%82",
  "%zz",
  ":",
  "*",
  "id",
];

/** A path: a `/` and fragments */
const anyPath = fc
  .array(fc.constantFrom(...pathFragments), { maxLength: 10 })
  .map((parts) => `/${parts.join("")}`);

/** A segment of a path: any fragments */
const anySegment = fc
  .array(fc.constantFrom(...pathFragments.filter((f) => f !== "/")), {
    maxLength: 3,
  })
  .map((parts) => parts.join(""));

/**
 * A path made for the segments of a pattern, which they mostly match: a
 * literal as it is, encoded or in another case, a parameter of any value,
 * maybe with segments added or removed at its end
 */
function pathFor(specs: readonly ISpec[]): fc.Arbitrary<string> {
  const segment = (spec: ISpec): fc.Arbitrary<string> => {
    if ("literal" in spec) {
      return fc.oneof(
        { arbitrary: fc.constant(spec.literal), weight: 3 },
        fc.constant(encodeURIComponent(spec.literal)),
        fc.constant(spec.literal.toUpperCase()),
        anySegment,
      );
    } else if ("param" in spec) {
      return fc.oneof(
        { arbitrary: paramValue.map((v) => encodeURIComponent(v)), weight: 3 },
        anySegment,
      );
    }
    return fc
      .array(
        paramValue.map((v) => encodeURIComponent(v)),
        { maxLength: 3 },
      )
      .map((values) => values.join("/"));
  };
  return fc
    .tuple(
      fc.tuple(...specs.map((spec) => segment(spec))),
      fc.constantFrom("", "", "/", "/a", "//"),
      fc.nat(specs.length),
    )
    .map(([parts, end, drop]) => {
      const kept =
        drop === specs.length ? parts : parts.slice(0, specs.length - drop);
      return `/${kept.join("/")}${end}`;
    });
}

/** A pattern of a kind with its segments, and paths for it */
function withPath(
  kind: "mount" | "route",
): fc.Arbitrary<[{ pattern: string; specs: ISpec[] }, string]> {
  return validPattern(kind).chain((compiled) =>
    fc.tuple(
      fc.constant(compiled),
      fc.oneof(anyPath, { arbitrary: pathFor(compiled.specs), weight: 3 }),
    ),
  );
}

/** A middleware that does nothing */
function noop(): void {
  // Nothing
}

suite("Routing (properties)", () => {
  test("`route()` and `mount()` accept a pattern if and only if the grammar does", () => {
    check(
      fc.property(anyPattern, (pattern) => {
        for (const kind of ["route", "mount"] as const) {
          const stack = new Stack();
          const add = (): Stack => {
            if (kind === "route") {
              return stack.route(pattern, noop);
            }
            return stack.mount(pattern, noop);
          };
          if (grammar(pattern, kind) === null) {
            throws(add, TypeError);
          } else {
            add();
            deepStrictEqual(stack.stack.length, 1);
          }
        }
      }),
      1000,
    );
  });

  test("a route matches a path if and only if the reference matcher does, with the same parameters", () => {
    check(
      fc.property(
        withPath("route"),
        options,
        ([{ pattern, specs }, path], settings) => {
          deepStrictEqual(
            outcome(() =>
              matchRoute(compile(pattern, "route"), path, settings),
            ),
            reference(specs, path, settings),
          );
        },
      ),
      1000,
    );
  });

  test("a mount prefix matches a path on a segment boundary if and only if the reference matcher does", () => {
    check(
      fc.property(
        withPath("mount"),
        options,
        ([{ pattern, specs }, path], settings) => {
          const match = outcome(() =>
            matchPrefix(compile(pattern, "mount"), path, settings),
          );
          const expected = reference(specs, path, settings, true);
          if (match === null || match === BAD_REQUEST) {
            deepStrictEqual(match, expected);
            return;
          }
          deepStrictEqual(match.params, expected);
          // The matched prefix and the rest are the path
          const { prefix, rest } = match;
          ok(rest.startsWith("/"));
          ok(
            `${prefix}${rest}` === path || (rest === "/" && prefix === path),
            `${prefix} ${rest}`,
          );
          deepStrictEqual(prefix.split("/").length - 1, specs.length);
        },
      ),
      1000,
    );
  });

  test("every parameter is decoded exactly once", () => {
    check(
      fc.property(
        fc.array(paramValue, { minLength: 1, maxLength: 4 }),
        fc.array(paramValue, { maxLength: 3 }),
        fc.boolean(),
        (values, rest, encoded_slashes) => {
          const names = values.map((_, index) => `p${index}`);
          const pattern = `/x/${names.map((name) => `:${name}`).join("/")}/*tail`;
          const path = `/x/${[...values, ...rest].map((value) => encodeURIComponent(value)).join("/")}`;
          const slashes = [...values, ...rest].some((value) =>
            /[/\\]/u.test(value),
          );
          const expected =
            slashes && !encoded_slashes
              ? BAD_REQUEST
              : {
                  ...Object.fromEntries(
                    names.map((name, index) => [name, values[index]]),
                  ),
                  tail: rest.join("/"),
                };
          deepStrictEqual(
            outcome(() =>
              matchRoute(compile(pattern, "route"), path, {
                encoded_slashes,
              }),
            ),
            expected,
          );
        },
      ),
      500,
    );
  });
});
