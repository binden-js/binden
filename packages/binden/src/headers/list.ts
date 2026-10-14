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

/** The value of a quoted string (RFC 9110, section 5.6.4), or the value itself */
export function unquote(value: string): string {
  return value.length >= 2 && value.startsWith(`"`) && value.endsWith(`"`)
    ? value.slice(1, -1).replaceAll(/\\(?<char>.)/gu, "$<char>")
    : value;
}
