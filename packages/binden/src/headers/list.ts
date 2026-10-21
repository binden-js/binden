import { described } from "../formatting.js";
import { formatStack } from "../exchange.js";

/** A token (RFC 9110, section 5.6.2) */
export const token = /^[!#$%&'*+.^_`|~\w-]+$/u;

/** A weight from 0 to 1, with at most 3 decimals (RFC 9110, section 12.4.2) */
export const qvalue = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/u;

/**
 * The characters of a field value (RFC 9110, section 5.5): no control
 * characters but tabs, and nothing above `\xFF`
 */
export const fieldValue =
  // eslint-disable-next-line no-control-regex -- control characters on purpose
  /^[^\u0000-\u0008\u000A-\u001F\u007F\u{100}-\u{10FFFF}]*$/u;

/** `name=value`, where the value is a token or a quoted string */
const parameter =
  /^\s*(?<name>[!#$%&'*+.^_`|~\w-]+)\s*=\s*(?<value>[!#$%&'*+.^_`|~\w-]+|"(?:[^"\\]|\\.)*")\s*$/u;

/**
 * Splits a field value on the separators (e.g. `,` of a list, or `;` of
 * parameters) that are not in a quoted string (RFC 9110, section 5.6.4)
 */
export function split(input: string, separator: string): string[] {
  const parts: string[] = [];
  let part = "";
  let quoted = false;
  let escaped = false;
  for (const char of input) {
    if (char === separator && !quoted) {
      parts.push(part);
      part = "";
    } else {
      part += char;
      if (escaped) {
        escaped = false;
      } else if (quoted && char === "\\") {
        escaped = true;
      } else if (char === `"`) {
        quoted = !quoted;
      }
    }
  }
  parts.push(part);
  return parts;
}

/**
 * Splits a field value on the separators that are not in a quoted string, as
 * `split()` does, but read from its end: a quoted string that is not
 * terminated swallows what is before it, not what is after it (e.g. the
 * elements that proxies append after the one of a client). The parts are in
 * their order.
 */
export function splitFromEnd(input: string, separator: string): string[] {
  const parts: string[] = [];
  let end = input.length;
  let quoted = false;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const char = input.charAt(index);
    if (char === `"` && quoted) {
      // The start of the quoted string, unless it is escaped (by an odd
      // number of backslashes before it)
      let backslashes = 0;
      while (input.charAt(index - backslashes - 1) === "\\") {
        backslashes += 1;
      }
      quoted = backslashes % 2 === 1;
    } else if (char === `"`) {
      quoted = true;
    } else if (char === separator && !quoted) {
      parts.push(input.slice(index + 1, end));
      end = index;
    }
  }
  parts.push(input.slice(0, end));
  return parts.toReversed();
}

/** The value of a quoted string (RFC 9110, section 5.6.4), or the value itself */
export function unquote(value: string): string {
  return value.length >= 2 && value.startsWith(`"`) && value.endsWith(`"`)
    ? value.slice(1, -1).replaceAll(/\\(?<char>.)/gu, "$<char>")
    : value;
}

/** A token as is, anything else as a quoted string (RFC 9110, section 5.6.4) */
export function quote(value: string): string {
  return token.test(value)
    ? value
    : `"${value.replaceAll(/(?<char>["\\])/gu, "\\$<char>")}"`;
}

/**
 * Whether a weight is a qvalue (`null` is the default weight): a number,
 * never anything that converts to one (e.g. an object of JavaScript, whose
 * `toString()` may tell another number on a later call)
 */
export function isQvalue(q_value: unknown): q_value is number | null {
  return (
    q_value === null ||
    (typeof q_value === "number" && qvalue.test(`${q_value}`))
  );
}

/** Why a weight is not a qvalue (see `isQvalue()`), without converting it */
export function qvalueRefusal(q_value: unknown): string {
  return typeof q_value === "number"
    ? `\`q_value\` is not a qvalue: ${q_value}`
    : "`q_value` is not a number";
}

/**
 * A value of the init of a header as a string, converted once (`String()`):
 * the types declare a string, but JavaScript may give anything (e.g. an
 * object whose `toString()` tells another string on a later call), so that
 * the string checked is the one kept. A `Symbol` is refused (as JavaScript
 * refuses to convert it implicitly), and so is what the conversion throws
 * (e.g. the `TypeError` of V8 for an object without a primitive value), each
 * formatted (see `formatStack()`).
 */
export function stringOf(value: unknown): string {
  if (typeof value === "symbol") {
    throw formatStack(
      new TypeError("Cannot convert a Symbol value to a string"),
    );
  }
  try {
    return String(value);
  } catch (error: unknown) {
    throw formatStack(error as Error);
  }
}

/**
 * A copy of an array, read once (its `length`, then each element by its
 * index, e.g. by a getter of a proxy), so that the values checked are the
 * ones used; anything else is refused with a `TypeError` (`name` is not an
 * array) that describes it (see `described()`), formatted (see
 * `formatStack()`). An error that reading it throws (e.g. of a revoked
 * proxy) is left to the boundary of the caller (see `formatting()`).
 */
export function arrayOf(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) {
    throw formatStack(
      new TypeError(`${name} is not an array: ${described(value)}`),
    );
  }
  const { length } = value;
  const copy: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    copy.push(value[index]);
  }
  return copy;
}

/**
 * Checks the input of a parser of a header that takes one field value
 * (`fromString()`): `undefined` or a string, anything else refused with a
 * `TypeError` that describes it (see `described()`), formatted (see
 * `formatStack()`), before anything reads or converts it. A string is then
 * parsed without any error of V8.
 */
export function checkFieldValue(input: unknown): void {
  if (typeof input !== "undefined" && typeof input !== "string") {
    throw formatStack(
      new TypeError(`The header is not a string: ${described(input)}`),
    );
  }
}

/**
 * The input of a parser of a header that takes its field lines too
 * (`fromString()`, `parse()`, and the header of `negotiate()`): `undefined`,
 * a string, or an array of strings, copied once (see `arrayOf()`). Anything
 * else (also an element that is not a string) is refused with a `TypeError`
 * that describes it (see `described()`), formatted (see `formatStack()`),
 * before anything converts it.
 */
export function fieldLinesOf(input: unknown): string[] | string | undefined {
  if (typeof input === "undefined" || typeof input === "string") {
    return input;
  }
  const lines = arrayOf(input, "The header");
  for (const line of lines) {
    if (typeof line !== "string") {
      throw formatStack(
        new TypeError(`A field line is not a string: ${described(line)}`),
      );
    }
  }
  return lines as string[];
}

/**
 * The offers of a content negotiation (`negotiate()`), copied once (see
 * `arrayOf()`), each checked by `valid` (which a string must pass): anything
 * else (e.g. `null`, a number, or an object, whatever its `toString()`
 * tells) is refused with a `TypeError` (`refusal` and the offer, described
 * without converting it, see `described()`), formatted (see `formatStack()`)
 */
export function offersOf(
  offers: unknown,
  refusal: string,
  valid: (offer: string) => boolean,
): string[] {
  const copy = arrayOf(offers, "`offers`");
  for (const offer of copy) {
    if (typeof offer !== "string" || !valid(offer)) {
      throw formatStack(new TypeError(`${refusal}: ${described(offer)}`));
    }
  }
  return copy as string[];
}

/** `Date.prototype.getTime()` of the engine */
const getTime: unknown = Reflect.get(Date.prototype, "getTime");

/**
 * The time of a `Date` (also of a subclass), which the engine reads from the
 * date itself, never by its methods nor by the traps of a proxy (a proxy of
 * a date has no time), or `null` for anything else
 */
export function timeOf(date: unknown): number | null {
  try {
    return Reflect.apply(getTime as () => number, date, []);
  } catch {
    return null;
  }
}

/** An element of a list with weights: its value, parameters and weight */
export interface IWeighted {
  /** The value of the element (e.g. a media range), trimmed and not checked */
  readonly value: string;
  /** The parameters before the weight, with their names in lowercase */
  readonly parameters: readonly (readonly [string, string])[];
  /** The weight (the `q` parameter), or `null` without one */
  readonly q_value: number | null;
}

/** The element of a list with weights, or `null` when it is malformed */
function element(input: string): IWeighted | null {
  const [head = "", ...rest] = split(input, ";");
  const value = head.trim();
  const parameters: [string, string][] = [];
  let q_value: number | null = null;
  // Empty parameters are allowed (RFC 9110, section 5.6.6)
  for (const part of rest.filter((item) => item.trim() !== "")) {
    if (q_value !== null) {
      // Extensions after the weight (RFC 7231, section 5.3.2) are ignored
      break;
    }
    const { name = "", value: raw = "" } = parameter.exec(part)?.groups ?? {};
    const key = name.toLowerCase();
    if (key === "" || (key === "q" && !qvalue.test(raw))) {
      return null;
    } else if (key === "q") {
      q_value = Number(raw);
    } else {
      parameters.push([key, unquote(raw)]);
    }
  }
  return { value, parameters, q_value };
}

/**
 * The elements of a list of values with weights (RFC 9110, section 12.4.2),
 * in their order: malformed elements (e.g. with a weight that is not a
 * qvalue) are skipped, and the values are left to check (an empty element
 * has an empty value)
 */
export function weighted(input?: string[] | string): IWeighted[] {
  const list = Array.isArray(input) ? input.join(",") : (input ?? "");
  return split(list, ",")
    .map((part) => element(part))
    .filter((part) => part !== null);
}

/**
 * The preferred offer of a content negotiation (RFC 9110, section 12.5):
 * every offer has the weight of the most specific element that matches it
 * (`specificity` is `null` for an element that does not), the first one of
 * them. The offer of the greatest weight wins, then the one of the more
 * specific element, then of the earlier element, then the earlier offer. An
 * offer of the weight 0 is not acceptable.
 */
export function preferred<T extends { readonly q_value: number | null }>(
  offers: readonly string[],
  elements: readonly T[],
  specificity: (element: T, offer: string) => number | null,
): string | false {
  let best: string | false = false;
  let rank = { q: 0, s: 0, index: 0 };
  for (const offer of offers) {
    let match: typeof rank | null = null;
    for (const [index, item] of elements.entries()) {
      const s = specificity(item, offer);
      if (s !== null && (match === null || s > match.s)) {
        match = { q: item.q_value ?? 1, s, index };
      }
    }
    // The weight of the first acceptable offer is greater than 0
    if (
      match !== null &&
      match.q > 0 &&
      (match.q > rank.q ||
        (match.q === rank.q &&
          (match.s > rank.s ||
            (match.s === rank.s && match.index < rank.index))))
    ) {
      best = offer;
      rank = match;
    }
  }
  return best;
}

/**
 * `value` without the spaces and tabs (OWS) around it, in linear time (a regular
 * expression such as `[ \t]+$` backtracks polynomially on long runs of them)
 */
export function trimOws(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && (value[start] === " " || value[start] === "\t")) {
    start += 1;
  }
  while (end > start && (value[end - 1] === " " || value[end - 1] === "\t")) {
    end -= 1;
  }
  return value.slice(start, end);
}
