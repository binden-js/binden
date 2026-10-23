/**
 * Reads a property of any thrown value: a throwing getter, a revoked proxy,
 * `null` or another primitive gives `null` instead of an error
 */
export function property(value: unknown, key: string): unknown {
  try {
    return Reflect.get(value as object, key) as unknown;
  } catch {
    return null;
  }
}

/**
 * The path of a request-target: never its query or fragment, nor the scheme,
 * the authority or the userinfo of an absolute-form target
 */
export function pathOf(target: string): string {
  if (target.startsWith("/")) {
    return target.replace(/[?#].*$/su, "");
  }
  return URL.canParse(target) ? new URL(target).pathname : "";
}
