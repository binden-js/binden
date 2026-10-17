/**
 * Whether a value is a status code: an integer from 100 to 599 (RFC 9110,
 * section 15), registered or not (e.g. 499)
 */
export function isStatus(value: unknown): boolean {
  return (
    Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599
  );
}
