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
