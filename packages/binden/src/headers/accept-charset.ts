import {
  fieldLinesOf,
  isQvalue,
  offersOf,
  preferred,
  qvalueRefusal,
  stringOf,
  token,
  weighted,
} from "./list.js";
import { formatting, objectOf } from "../formatting.js";
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
   * a `TypeError`, and so does an init that is not an object. What reading it
   * throws (e.g. a revoked proxy) is formatted (see `formatting()`).
   */
  public constructor(init: IAcceptCharset) {
    // Each value is read once (e.g. by a getter), and converted once when it
    // is not a string (see `stringOf()`): the values checked are the ones kept
    const checked = formatting(() =>
      AcceptCharset.#read(objectOf(init, "init") as IAcceptCharset),
    );
    const refusal = AcceptCharset.#refusal(checked);
    if (refusal !== null) {
      throw formatStack(new TypeError(refusal));
    }
    this.#charset = checked.charset;
    this.#q_value = checked.q_value;
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
   * a tie. An input that is neither a string, an array of strings nor
   * `undefined` throws a `TypeError`.
   */
  public static fromString(input?: string[] | string): AcceptCharset[] {
    return formatting(() =>
      AcceptCharset.#parse(fieldLinesOf(input)).toSorted(
        ({ q_value: a }, { q_value: b }) => (b ?? 1) - (a ?? 1),
      ),
    );
  }

  /**
   * The preferred one of the offered charsets, as given: the first one without
   * the header, otherwise the one of the greatest weight, given by the element
   * of the charset (case-insensitive), then `*`, or `false` when none is
   * acceptable. An offer that is not a token (also one that is not a
   * string), offers that are not an array and a header of another type than
   * `fromString()` takes throw a `TypeError`.
   */
  public static negotiate(
    offers: readonly string[],
    input?: string[] | string,
  ): string | false {
    return formatting(() => {
      const list = offersOf(
        offers,
        "Invalid charset",
        (offer) => token.test(offer) && offer !== "*",
      );
      const header = fieldLinesOf(input);
      if (typeof header === "undefined") {
        return list.at(0) ?? false;
      }
      return preferred(list, AcceptCharset.#parse(header), (element, offer) => {
        const charset = element.charset.toLowerCase();
        return charset === "*" ? 0 : charset === offer.toLowerCase() ? 1 : null;
      });
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

  /** The values of an init, each read once, the charset converted once */
  static #read({ charset, q_value = null }: IAcceptCharset): {
    readonly charset: string;
    readonly q_value: number | null;
  } {
    return { charset: stringOf(charset), q_value };
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
