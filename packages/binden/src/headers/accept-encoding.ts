import { preferred, qvalue, token } from "./list.js";

/** The content codings of `Accept-Encoding` that are known (and `*`) */
export type IAcceptEncodings =
  "*" | "br" | "compress" | "deflate" | "gzip" | "identity" | "x-gzip" | "zstd";

/** An element of `Accept-Encoding` */
export interface IAcceptEncoding {
  /** A known content coding in lowercase, or `*` (any other coding) */
  encoding: IAcceptEncodings;
  /** The weight: a qvalue from 0 to 1 (none by default, which weighs 1) */
  q_value?: number | null;
}

/** An element of the `Accept-Encoding` header (RFC 9110, section 12.5.3) */
export class AcceptEncoding implements IAcceptEncoding {
  readonly #encoding: IAcceptEncodings;
  readonly #q_value: number | null;

  /**
   * A known content coding (or `*`) and its weight (a qvalue): invalid ones
   * throw a `TypeError`
   */
  public constructor({ encoding, q_value = null }: IAcceptEncoding) {
    if (!AcceptEncoding.#encodings.includes(encoding)) {
      throw new TypeError(`Unknown content coding: ${String(encoding)}`);
    } else if (q_value !== null && !qvalue.test(`${q_value}`)) {
      throw new TypeError(`\`q_value\` is not a qvalue: ${q_value}`);
    }
    this.#encoding = encoding;
    this.#q_value = q_value;
  }

  /** The content coding, or `*` */
  public get encoding(): IAcceptEncodings {
    return this.#encoding;
  }

  /** The weight, or `null` without one (it weighs 1) */
  public get q_value(): number | null {
    return this.#q_value;
  }

  /** The element as in the header: `coding;q=weight` */
  public toString(): string {
    const { q_value, encoding } = this;
    return typeof q_value === "number" ? `${encoding};q=${q_value}` : encoding;
  }

  /**
   * The elements of the header with a known coding (in lowercase) and a valid
   * weight, from the greatest weight (a missing one is 1), in their order on a
   * tie
   */
  public static fromString(string?: string[] | string): AcceptEncoding[] {
    return AcceptEncoding.#parse(string)
      .filter((e): e is [IAcceptEncodings, number | null] =>
        AcceptEncoding.#encodings.includes(e[0]),
      )
      .map(([encoding, q_value]) => new AcceptEncoding({ encoding, q_value }))
      .sort(({ q_value: a }, { q_value: b }) => (b ?? 1) - (a ?? 1));
  }

  /**
   * The preferred one of the offered content codings (tokens), as given: the
   * first one without the header, otherwise the one of the greatest weight,
   * given by the element of the coding (case-insensitive, `x-gzip` is `gzip`),
   * then `*`, or `false` when none is acceptable (RFC 9110, section 12.5.3).
   * Unknown codings of the header count too. `identity` is acceptable unless
   * excluded (`identity;q=0`, or `*;q=0` without `identity`), but the least
   * preferred when the header does not name it. An offer that is not a token
   * throws a `TypeError`.
   */
  public static negotiate(
    offers: readonly string[],
    input?: string[] | string,
  ): string | false {
    for (const offer of offers) {
      if (!token.test(offer) || offer === "*") {
        throw new TypeError(`Invalid content coding: ${offer}`);
      }
    }
    if (typeof input === "undefined") {
      return offers.at(0) ?? false;
    }
    const elements = AcceptEncoding.#parse(input).map(([coding, q_value]) => ({
      coding: AcceptEncoding.#canonical(coding),
      q_value,
      implicit: false,
    }));
    // The smallest weight, less specific than any element of the header
    elements.push({ coding: "identity", q_value: 0.001, implicit: true });
    return preferred(offers, elements, ({ coding, implicit }, offer) => {
      const match = coding === AcceptEncoding.#canonical(offer);
      if (implicit) {
        return match ? -1 : null;
      }
      return coding === "*" ? 0 : match ? 1 : null;
    });
  }

  /** A content coding in lowercase, with `x-gzip` as `gzip` */
  static #canonical(coding: string): string {
    const lower = coding.toLowerCase();
    return lower === "x-gzip" ? "gzip" : lower;
  }

  /**
   * Every element of the header (with its coding in lowercase) and its weight,
   * in their order: an element whose weight is not a qvalue is skipped
   */
  static #parse(
    input: string[] | string | undefined,
  ): [string, number | null][] {
    if (typeof input === "undefined") {
      return [];
    }

    // Content codings and the `q` parameter are case-insensitive (RFC 9110)
    return (Array.isArray(input) ? input.join(",") : input)
      .split(",")
      .map<[string, number | null] | null>((part) => {
        const [coding = "", ...params] = part
          .split(";")
          .map((param) => param.trim());
        const q = params
          .map((param) => /^q\s*=\s*(?<value>.*)$/iu.exec(param)?.groups?.value)
          .find((value) => typeof value === "string");
        if (typeof q === "undefined") {
          return [coding.toLowerCase(), null];
        }
        // A weight is a qvalue (RFC 9110, section 12.4.2), or the element is invalid
        const value = q.trim();
        return qvalue.test(value)
          ? [coding.toLowerCase(), Number(value)]
          : null;
      })
      .filter((e) => e !== null);
  }

  static readonly #encodings: readonly string[] = [
    "gzip",
    "x-gzip",
    "compress",
    "deflate",
    "br",
    "zstd",
    "*",
    "identity",
  ];
}

export default AcceptEncoding;
