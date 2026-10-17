import { AcceptEncoding } from "binden";
import type { ICompressEncodings } from "./codings.js";

/** A content coding in the form of the offers (`x-gzip` is `gzip`) */
function canonical(encoding: string): string {
  return encoding === "x-gzip" ? "gzip" : encoding;
}

/**
 * The weight of a content coding in `Accept-Encoding`: the one of its own
 * element (`x-gzip` is `gzip`), otherwise the one of `*`, otherwise `null`
 * (not named by the header)
 */
function weightOf(
  elements: readonly AcceptEncoding[],
  coding: string,
): number | null {
  const element =
    elements.find(({ encoding }) => canonical(encoding) === coding) ??
    elements.find(({ encoding }) => encoding === "*");
  return typeof element === "undefined" ? null : (element.q_value ?? 1);
}

/**
 * The content coding of a response (RFC 9110, section 12.5.3): `identity`
 * without `Accept-Encoding` (or with an empty one), otherwise the offer of the
 * greatest weight (on a tie, the earlier offer), unless `identity` weighs
 * more. `identity` is acceptable unless excluded (`identity;q=0`, or `*;q=0`
 * without `identity`): `false` when nothing is acceptable.
 */
export function negotiate(
  header: string | undefined,
  offers: readonly ICompressEncodings[],
): ICompressEncodings | "identity" | false {
  // No element names an offer without the header: `identity` is chosen
  const elements = AcceptEncoding.fromString(header);
  let best: ICompressEncodings | null = null;
  let weight = 0;
  for (const offer of offers) {
    const offered = weightOf(elements, offer) ?? 0;
    if (offered > weight) {
      best = offer;
      weight = offered;
    }
  }
  // Not named by the header, `identity` is acceptable, but the least preferred
  const identity = weightOf(elements, "identity");
  if (best !== null && (identity === null || weight >= identity)) {
    return best;
  }
  return identity === 0 ? false : "identity";
}

/**
 * Whether the request accepts a representation of these content codings (RFC
 * 9110, section 12.5.3): any without `Accept-Encoding`, otherwise each one
 * that the header names (`x-gzip` is `gzip`, unknown codings count too), or
 * `*`, with a weight above 0. None with an empty header, nor an invalid
 * coding (e.g. `*`).
 */
export function accepts(
  header: string | undefined,
  codings: readonly string[],
): boolean {
  return (
    typeof header === "undefined" ||
    codings.every((coding) => {
      try {
        return AcceptEncoding.negotiate([coding], header) !== false;
      } catch {
        // Not a content coding
        return false;
      }
    })
  );
}
