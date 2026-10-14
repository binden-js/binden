/** The greatest delay of a Node.js timer */
export const MAX_DELAY = 2 ** 31 - 1;

/**
 * Checks the delay of a timer option: an integer (a `TypeError` otherwise)
 * from `min` to the greatest delay of Node.js (a `RangeError` otherwise)
 */
export function validateDelay(name: string, value: unknown, min: number): void {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TypeError(`\`${name}\` is not an integer`);
  } else if (value < min || value > MAX_DELAY) {
    throw new RangeError(`\`${name}\` is not between ${min} and ${MAX_DELAY}`);
  }
}
