import { isQvalue, preferred, token, weighted } from "./list.js";

/** An element of `Accept-Charset` */
export interface IAcceptCharset {
  /** A charset (a token), or `*` */
  charset: string;
  q_value?: number | null | undefined;
}

/** An element of the `Accept-Charset` header (RFC 9110, section 12.5.2) */
export class AcceptCharset implements IAcceptCharset {
  readonly #charset: string;
  readonly #q_value: number | null;

  /**
   * A charset (a token, or `*`) and its weight (a qvalue). Invalid ones throw
   * a `TypeError`.
   */
  public constructor({ charset, q_value = null }: IAcceptCharset) {
    if (!token.test(charset)) {
      throw new TypeError(`Invalid charset: ${charset}`);
    } else if (!isQvalue(q_value)) {
      throw new TypeError(`\`q_value\` is not a qvalue: ${q_value}`);
    }
    this.#charset = charset;
    this.#q_value = q_value;
  }

  public get charset(): string {
    return this.#charset;
  }

  public get q_value(): number | null {
    return this.#q_value;
  }

  public toString(): string {
    const { charset, q_value } = this;
    return q_value === null ? charset : `${charset};q=${q_value}`;
  }

  /**
   * The valid elements of the header (other parameters than the weight are
   * ignored), from the greatest weight (a missing one is 1), in their order on
   * a tie
   */
  public static fromString(input?: string[] | string): AcceptCharset[] {
    return AcceptCharset.#parse(input).toSorted(
      ({ q_value: a }, { q_value: b }) => (b ?? 1) - (a ?? 1),
    );
  }

  /**
   * The preferred one of the offered charsets, as given: the first one without
   * the header, otherwise the one of the greatest weight, given by the element
   * of the charset (case-insensitive), then `*`, or `false` when none is
   * acceptable. An offer that is not a token throws a `TypeError`.
   */
  public static negotiate(
    offers: readonly string[],
    input?: string[] | string,
  ): string | false {
    for (const offer of offers) {
      if (!token.test(offer) || offer === "*") {
        throw new TypeError(`Invalid charset: ${offer}`);
      }
    }
    if (typeof input === "undefined") {
      return offers.at(0) ?? false;
    }
    return preferred(offers, AcceptCharset.#parse(input), (element, offer) => {
      const charset = element.charset.toLowerCase();
      return charset === "*" ? 0 : charset === offer.toLowerCase() ? 1 : null;
    });
  }

  /** The valid elements of the header, in their order */
  static #parse(input?: string[] | string): AcceptCharset[] {
    return weighted(input).flatMap(({ value: charset, q_value }) => {
      try {
        return [new AcceptCharset({ charset, q_value })];
      } catch {
        return [];
      }
    });
  }
}

export default AcceptCharset;
