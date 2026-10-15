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

/** Whether a weight is a qvalue (`null` is the default weight) */
export function isQvalue(q_value: number | null): boolean {
  return q_value === null || qvalue.test(`${q_value}`);
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
