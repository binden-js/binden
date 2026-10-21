import {
  isQvalue,
  preferred,
  qvalueRefusal,
  stringOf,
  token,
  weighted,
} from "./list.js";
import { formatStack } from "../exchange.js";

/** An element of `Accept-Charset` */
export interface IAcceptCharset {
  /** A charset (a token), or `*` */
  charset: string;
  /** The weight: a qvalue from 0 to 1 (none by default, which weighs 1) */
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
    // Each value is read once (e.g. by a getter), and converted once when it
    // is not a string (see `stringOf()`): the values checked are the ones kept
    const init = { charset: stringOf(charset), q_value };
    const refusal = AcceptCharset.#refusal(init);
    if (refusal !== null) {
      throw formatStack(new TypeError(refusal));
    }
    this.#charset = init.charset;
    this.#q_value = init.q_value;
  }

  /** The charset (a token), or `*` */
  public get charset(): string {
    return this.#charset;
  }

  /** The weight, or `null` without one (it weighs 1) */
  public get q_value(): number | null {
    return this.#q_value;
  }

  /** The element as in the header: `charset;q=weight` */
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
        throw formatStack(new TypeError(`Invalid charset: ${offer}`));
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
      // Checked first: an invalid element (e.g. of a client) creates no
      // error, whose stack would be formatted (see `formatStack()`)
      const init = { charset, q_value };
      return AcceptCharset.#refusal(init) === null
        ? [new AcceptCharset(init)]
        : [];
    });
  }

  /**
   * Why an element is invalid (see the constructor), `null` when it is valid
   */
  static #refusal({ charset, q_value = null }: IAcceptCharset): string | null {
    if (!token.test(charset)) {
      return `Invalid charset: ${charset}`;
    } else if (!isQvalue(q_value)) {
      return qvalueRefusal(q_value);
    }
    return null;
  }
}

export default AcceptCharset;
