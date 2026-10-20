import {
  fieldValue,
  isQvalue,
  preferred,
  quote,
  token,
  weighted,
} from "./list.js";
import { formatStack } from "../exchange.js";

/** An element of `Accept`: a media range, its parameters and weight */
export interface IAccept {
  /** A media range: `*\/*`, `type/*` or `type/subtype` */
  type: string;
  /** The parameters of the media range (their names are case-insensitive) */
  parameters?: Readonly<Record<string, string>> | undefined;
  /** The weight: a qvalue from 0 to 1 (none by default, which weighs 1) */
  q_value?: number | null | undefined;
}

/** A media type of an offer, with its parameters by lowercase name */
interface IMediaType {
  readonly type: string;
  readonly subtype: string;
  readonly parameters: ReadonlyMap<string, string>;
}

/** An element of the `Accept` header (RFC 9110, section 12.5.1) */
export class Accept implements IAccept {
  readonly #type: string;
  readonly #parameters: ReadonlyMap<string, string>;
  readonly #q_value: number | null;

  /**
   * A media range (`*\/*`, `type/*` or `type/subtype`, of tokens), its
   * parameters (a token as name, other than `q`, and a value without control
   * characters) and its weight (a qvalue). Invalid ones throw a `TypeError`.
   */
  public constructor(init: IAccept) {
    const refusal = Accept.#refusal(init);
    if (refusal !== null) {
      throw formatStack(new TypeError(refusal));
    }
    const { type, parameters = {}, q_value = null } = init;
    const all = new Map<string, string>();
    for (const [name, value] of Object.entries(parameters)) {
      const key = name.toLowerCase();
      if (!all.has(key)) {
        all.set(key, value);
      }
    }
    this.#type = type;
    this.#parameters = all;
    this.#q_value = q_value;
  }

  /** The media range (in lowercase when parsed) */
  public get type(): string {
    return this.#type;
  }

  /** Every parameter (but the weight), by its name in lowercase */
  public get parameters(): Record<string, string> {
    return Object.fromEntries(this.#parameters);
  }

  /** The weight, or `null` without one (it weighs 1) */
  public get q_value(): number | null {
    return this.#q_value;
  }

  /**
   * The element as in the header: `type/subtype;name=value;q=weight`, with the
   * values that are not tokens quoted
   */
  public toString(): string {
    const parameters = [...this.#parameters].map(
      ([name, value]) => `;${name}=${quote(value)}`,
    );
    const weight = this.#q_value === null ? "" : `;q=${this.#q_value}`;
    return `${this.#type}${parameters.join("")}${weight}`;
  }

  /**
   * The valid elements of the header (with their media ranges in lowercase),
   * from the greatest weight (a missing one is 1), in their order on a tie
   */
  public static fromString(input?: string[] | string): Accept[] {
    return Accept.#parse(input).toSorted(
      ({ q_value: a }, { q_value: b }) => (b ?? 1) - (a ?? 1),
    );
  }

  /**
   * The preferred one of the offered media types (`type/subtype`, maybe with
   * parameters), as given: the first one without the header, otherwise the one
   * of the greatest weight, given by the most specific media range that matches
   * it (`text/html;level=1`, then `text/html`, `text/*` and `*\/*`), or `false`
   * when none is acceptable (RFC 9110, section 12.5.1). An offer that is not a
   * media type throws a `TypeError`.
   */
  public static negotiate(
    offers: readonly string[],
    input?: string[] | string,
  ): string | false {
    const types = new Map(offers.map((offer) => [offer, Accept.#offer(offer)]));
    if (typeof input === "undefined") {
      return offers.at(0) ?? false;
    }
    return preferred(offers, Accept.#parse(input), (range, offer) =>
      Accept.#specificity(range, types.get(offer) as IMediaType),
    );
  }

  /** The valid elements of the header, in their order */
  static #parse(input?: string[] | string): Accept[] {
    return weighted(input).flatMap(({ value, parameters, q_value }) => {
      // Checked first: an invalid element (e.g. of a client) creates no
      // error, whose stack would be formatted (see `formatStack()`)
      const init = {
        type: value.toLowerCase(),
        parameters: Object.fromEntries(parameters),
        q_value,
      };
      return Accept.#refusal(init) === null ? [new Accept(init)] : [];
    });
  }

  /**
   * Why an element is invalid (see the constructor), `null` when it is valid
   */
  static #refusal({
    type,
    parameters = {},
    q_value = null,
  }: IAccept): string | null {
    const [main = "", subtype = "", ...rest] = type.split("/");
    if (
      rest.length > 0 ||
      !token.test(main) ||
      !token.test(subtype) ||
      (main === "*" && subtype !== "*")
    ) {
      return `Invalid media range: ${type}`;
    } else if (!isQvalue(q_value)) {
      return `\`q_value\` is not a qvalue: ${q_value}`;
    }
    for (const [name, value] of Object.entries(parameters)) {
      const key = name.toLowerCase();
      if (!token.test(key) || key === "q") {
        return `Invalid parameter name: ${name}`;
      } else if (!fieldValue.test(value)) {
        return `Invalid value of the parameter ${name}`;
      }
    }
    return null;
  }

  /** A media type, without wildcards nor a weight, or a `TypeError` */
  static #offer(offer: string): IMediaType {
    // One element (without a weight): an offer with a `,` would be several
    const [element = null, ...others] = weighted(offer);
    const [type = "", subtype = "", ...rest] =
      element?.value.toLowerCase().split("/") ?? [];
    if (
      element === null ||
      others.length > 0 ||
      element.q_value !== null ||
      rest.length > 0 ||
      !token.test(type) ||
      !token.test(subtype) ||
      type === "*" ||
      subtype === "*"
    ) {
      throw formatStack(new TypeError(`Invalid media type: ${offer}`));
    }
    return { type, subtype, parameters: new Map(element.parameters) };
  }

  /**
   * How specific a media range that matches the media type is (its type,
   * subtype and parameters), or `null` when it does not match. The names of
   * the parameters are case-insensitive, and so is the value of `charset`
   * only (RFC 9110, section 8.3.1): the other values are compared as they are.
   */
  static #specificity(range: Accept, media: IMediaType): number | null {
    const [type = "", subtype = ""] = range.type.toLowerCase().split("/");
    const parameters = [...range.#parameters];
    const level = type === "*" ? 0 : subtype === "*" ? 1 : 2;
    const same = (name: string, value: string): boolean => {
      const offered = media.parameters.get(name);
      return name === "charset"
        ? offered?.toLowerCase() === value.toLowerCase()
        : offered === value;
    };
    if (
      (level > 0 && type !== media.type) ||
      (level > 1 && subtype !== media.subtype) ||
      parameters.some(([name, value]) => !same(name, value))
    ) {
      return null;
    }
    return level * 1000 + parameters.length;
  }
}

export default Accept;
