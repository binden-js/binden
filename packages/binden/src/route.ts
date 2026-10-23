import { BindenError } from "./error.js";
import type { IParams } from "./context.js";
import { formatStack } from "./exchange.js";

/** The segments of a route pattern (a union of strings) */
export type IRouteSegments<Pattern extends string> =
  Pattern extends `${infer Head}/${infer Tail}`
    ? Head | IRouteSegments<Tail>
    : Pattern;

/** The name of the parameter of a `:name` or `*name` segment (`never` for a literal) */
export type IRouteParamName<Segment extends string> =
  Segment extends `:${infer Name}`
    ? Name
    : Segment extends `*${infer Name}`
      ? Name
      : never;

/**
 * The parameters of a route pattern (e.g. `{ id: string }` for
 * `/users/:id`), or any parameters for a pattern that is not a literal type
 */
export type IRouteParams<Pattern extends string> = string extends Pattern
  ? IParams
  : Record<IRouteParamName<IRouteSegments<Pattern>>, string>;

/** The options of the matching of `route()` and `mount()` patterns */
export interface IRoutingOptions {
  /** Whether the literal segments are compared with their case (`true`) */
  case_sensitive?: boolean | undefined;
  /** Whether a path must not have a trailing `/` that its pattern has not (`true`) */
  strict?: boolean | undefined;
}

/** A segment of a pattern: a literal, or the name of a parameter */
type ISegment = { readonly literal: string } | { readonly param: string };

/** A compiled `route()` or `mount()` pattern */
export interface IPattern {
  /** The pattern as registered (a mount prefix without its trailing `/`) */
  readonly source: string;
  /** The segments, without the `*name` tail */
  readonly segments: readonly ISegment[];
  /** The segments without a trailing empty one (see the `strict` option) */
  readonly loose: readonly ISegment[];
  /** The name of the `*name` tail, if any */
  readonly wildcard: string | null;
}

/** The match of a mount prefix */
export interface IPrefixMatch {
  /** The parameters of the prefix, decoded once */
  readonly params: IParams;
  /** The matched part of the path, as received (`""` for the prefix `/`) */
  readonly prefix: string;
  /** The rest of the path that the mounted level sees (`/` when empty) */
  readonly rest: string;
}

const name = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** A literal segment of a pattern: `\:` and `\*` only, no other `:` or `*` */
function unescape(segment: string, pattern: string): string {
  let literal = "";
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment.charAt(index);
    if (char === "\\") {
      const next = segment.charAt(index + 1);
      if (next !== ":" && next !== "*") {
        throw formatStack(new TypeError(`Invalid escape in ${pattern}`));
      }
      literal += next;
      index += 1;
    } else if (char === ":" || char === "*") {
      throw formatStack(
        new TypeError(`An unescaped \`${char}\` in ${pattern}`),
      );
    } else {
      literal += char;
    }
  }
  return literal;
}

/**
 * Compiles a pattern: `/` separated segments, each a literal (where `\:` and
 * `\*` are a `:` and a `*`), a `:name` (one segment) or, last and in a route
 * only, a `*name` (the rest of the path)
 */
export function compile(pattern: unknown, kind: "mount" | "route"): IPattern {
  if (typeof pattern !== "string" || !pattern.startsWith("/")) {
    throw formatStack(
      new TypeError(`The ${kind} pattern does not start with \`/\``),
    );
  }
  const raw = pattern.slice(1).split("/");
  if (kind === "mount" && raw.at(-1) === "") {
    // `/api/` is `/api`, and `/` mounts at the root
    raw.pop();
  }
  const segments: ISegment[] = [];
  const names = new Set<string>();
  let wildcard: string | null = null;
  for (const [index, segment] of raw.entries()) {
    const sigil = segment.charAt(0);
    if (sigil === ":" || sigil === "*") {
      const param = segment.slice(1);
      if (!name.test(param)) {
        throw formatStack(
          new TypeError(`Invalid parameter name in ${pattern}`),
        );
      } else if (names.has(param)) {
        throw formatStack(
          new TypeError(`Duplicate parameter name in ${pattern}`),
        );
      } else if (sigil === "*" && kind === "mount") {
        throw formatStack(
          new TypeError(`A mount prefix has no \`*\` (${pattern})`),
        );
      } else if (sigil === "*" && index !== raw.length - 1) {
        throw formatStack(
          new TypeError(`\`*${param}\` is not the last segment`),
        );
      }
      names.add(param);
      if (sigil === "*") {
        wildcard = param;
      } else {
        segments.push({ param });
      }
    } else {
      segments.push({ literal: unescape(segment, pattern) });
    }
  }
  const last = segments.at(-1);
  const trailing =
    wildcard === null &&
    segments.length > 1 &&
    typeof last !== "undefined" &&
    "literal" in last &&
    last.literal === "";
  return {
    source: kind === "mount" ? raw.map((part) => `/${part}`).join("") : pattern,
    segments,
    loose: trailing ? segments.slice(0, -1) : segments,
    wildcard,
  };
}

/** A segment of a path, decoded once (`null` when it is not valid) */
function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * The value of a parameter: `400 Bad Request` when it cannot be decoded, or
 * when it has an encoded `/` (or `\`), which would change the segments of the
 * path, unless `encoded_slashes` allows them
 */
function value(segment: string, encoded_slashes: boolean): string {
  const decoded = decode(segment);
  if (decoded === null || (!encoded_slashes && /[/\\]/u.test(decoded))) {
    throw new BindenError(400);
  }
  return decoded;
}

/** Whether a segment of a path is a literal of a pattern */
function same(
  segment: string,
  literal: string,
  case_sensitive: boolean,
): boolean {
  if (segment === literal) {
    return true;
  }
  const decoded = decode(segment);
  return (
    decoded !== null &&
    (case_sensitive
      ? decoded === literal
      : decoded.toLowerCase() === literal.toLowerCase())
  );
}

/**
 * Matches the leading segments of a path: the parameters, or `null`. The
 * literals are compared first, so that a parameter that cannot be decoded
 * fails (`400`) only in a path that matches otherwise.
 */
function leading(
  segments: readonly ISegment[],
  path: readonly string[],
  case_sensitive: boolean,
  encoded_slashes: boolean,
): IParams | null {
  for (const [index, segment] of segments.entries()) {
    const part = path[index];
    if ("literal" in segment) {
      if (!same(part, segment.literal, case_sensitive)) {
        return null;
      }
    } else if (part === "") {
      return null;
    }
  }
  const params: [string, string][] = [];
  for (const [index, segment] of segments.entries()) {
    if ("param" in segment) {
      params.push([segment.param, value(path[index], encoded_slashes)]);
    }
  }
  // Defined, not assigned: a parameter may be named `__proto__`
  return Object.fromEntries(params);
}

/** The segments of a path (which starts with `/`), as received */
export function split(path: string): string[] {
  return path.slice(1).split("/");
}

/**
 * The options of the matching: those of the routing, and whether a
 * parameter may have an encoded slash (see the `encoded_slashes` request
 * option)
 */
export interface IMatchOptions extends IRoutingOptions {
  /** Whether a parameter may have an encoded `/` or `\` (`false`) */
  readonly encoded_slashes?: boolean | undefined;
}

/**
 * Matches a whole path (or its segments, see `split()`, which the layers of a
 * stack share): the parameters of a route, or `null`. The number of the
 * segments is compared first.
 */
export function matchRoute(
  pattern: IPattern,
  path: readonly string[] | string,
  {
    case_sensitive = true,
    strict = true,
    encoded_slashes = false,
  }: IMatchOptions,
): IParams | null {
  const parts = typeof path === "string" ? split(path) : path;
  // One trailing `/` of the path, or of the pattern, may be missing
  const segments = strict ? pattern.segments : pattern.loose;
  const count =
    !strict && parts.length > 1 && parts.at(-1) === ""
      ? parts.length - 1
      : parts.length;
  if (
    pattern.wildcard === null
      ? count !== segments.length
      : count < segments.length
  ) {
    return null;
  }
  const params = leading(segments, parts, case_sensitive, encoded_slashes);
  if (params && pattern.wildcard !== null) {
    // The rest of the path, each segment decoded once
    const rest = parts
      .slice(segments.length, count)
      .map((part) => value(part, encoded_slashes))
      .join("/");
    return { ...params, ...Object.fromEntries([[pattern.wildcard, rest]]) };
  }
  return params;
}

/**
 * Matches the leading segments of a path (or its segments, see `split()`) on a
 * segment boundary: the parameters, the matched part and the rest of the
 * path, or `null`. The number of the segments is compared first.
 */
export function matchPrefix(
  pattern: IPattern,
  path: readonly string[] | string,
  { case_sensitive = true, encoded_slashes = false }: IMatchOptions,
): IPrefixMatch | null {
  const parts = typeof path === "string" ? split(path) : path;
  const { length } = pattern.segments;
  if (parts.length < length) {
    return null;
  }
  const params = leading(
    pattern.segments,
    parts,
    case_sensitive,
    encoded_slashes,
  );
  if (!params) {
    return null;
  }
  const prefix = length === 0 ? "" : `/${parts.slice(0, length).join("/")}`;
  return { params, prefix, rest: `/${parts.slice(length).join("/")}` };
}
