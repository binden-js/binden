import { isQvalue, preferred, weighted } from "./list.js";
import { formatStack } from "../exchange.js";

/** An element of `Accept-Language` */
export interface IAcceptLanguage {
  /** A language range: `*`, or a language tag (e.g. `en`, `en-US`) */
  language: string;
  /** The weight: a qvalue from 0 to 1 (none by default, which weighs 1) */
  q_value?: number | null | undefined;
}

/** `1*8ALPHA *( "-" 1*8alphanum )` (RFC 4647, section 2.1) */
const tag = /^[A-Za-z]{1,8}(?:-[A-Za-z\d]{1,8})*$/u;

/** An element of the `Accept-Language` header (RFC 9110, section 12.5.4) */
export class AcceptLanguage implements IAcceptLanguage {
  readonly #language: string;
  readonly #q_value: number | null;

  /**
   * A language range (`*`, or subtags of up to 8 letters and digits, the first
   * one of letters) and its weight (a qvalue). Invalid ones throw a
   * `TypeError`.
   */
  public constructor({ language, q_value = null }: IAcceptLanguage) {
    // Each value is read once (e.g. by a getter): the values checked are the
    // ones kept
    const refusal = AcceptLanguage.#refusal({ language, q_value });
    if (refusal !== null) {
      throw formatStack(new TypeError(refusal));
    }
    this.#language = language;
    this.#q_value = q_value;
  }

  /** The language range: a language tag, or `*` */
  public get language(): string {
    return this.#language;
  }

  /** The weight, or `null` without one (it weighs 1) */
  public get q_value(): number | null {
    return this.#q_value;
  }

  /** The element as in the header: `language;q=weight` */
  public toString(): string {
    const { language, q_value } = this;
    return q_value === null ? language : `${language};q=${q_value}`;
  }

  /**
   * The valid elements of the header (other parameters than the weight are
   * ignored), from the greatest weight (a missing one is 1), in their order on
   * a tie
   */
  public static fromString(input?: string[] | string): AcceptLanguage[] {
    return AcceptLanguage.#parse(input).toSorted(
      ({ q_value: a }, { q_value: b }) => (b ?? 1) - (a ?? 1),
    );
  }

  /**
   * The preferred one of the offered language tags, as given: the first one
   * without the header, otherwise the one of the greatest weight, given by the
   * longest language range that is the tag or one of its prefixes (basic
   * filtering, RFC 4647, section 3.3.1), then `*`, or `false` when none is
   * acceptable. An offer that is not a language tag throws a `TypeError`.
   */
  public static negotiate(
    offers: readonly string[],
    input?: string[] | string,
  ): string | false {
    for (const offer of offers) {
      if (!tag.test(offer)) {
        throw formatStack(new TypeError(`Invalid language tag: ${offer}`));
      }
    }
    if (typeof input === "undefined") {
      return offers.at(0) ?? false;
    }
    return preferred(offers, AcceptLanguage.#parse(input), (range, offer) => {
      const language = range.language.toLowerCase();
      const lower = offer.toLowerCase();
      if (language === "*") {
        return 0;
      } else if (lower === language || lower.startsWith(`${language}-`)) {
        return language.split("-").length;
      }
      return null;
    });
  }

  /** The valid elements of the header, in their order */
  static #parse(input?: string[] | string): AcceptLanguage[] {
    return weighted(input).flatMap(({ value: language, q_value }) => {
      // Checked first: an invalid element (e.g. of a client) creates no
      // error, whose stack would be formatted (see `formatStack()`)
      const init = { language, q_value };
      return AcceptLanguage.#refusal(init) === null
        ? [new AcceptLanguage(init)]
        : [];
    });
  }

  /**
   * Why an element is invalid (see the constructor), `null` when it is valid
   */
  static #refusal({
    language,
    q_value = null,
  }: IAcceptLanguage): string | null {
    if (language !== "*" && !tag.test(language)) {
      return `Invalid language range: ${language}`;
    } else if (!isQvalue(q_value)) {
      return `\`q_value\` is not a qvalue: ${q_value}`;
    }
    return null;
  }
}

export default AcceptLanguage;
