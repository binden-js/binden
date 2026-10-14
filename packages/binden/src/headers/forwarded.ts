import { fieldValue, quote, split, unquote } from "./list.js";

/** The parameters of a `Forwarded` element */
export interface IForwarded {
  /**
   * The client of the proxy (`for`): an address (maybe with a port), `unknown`
   * or an obfuscated identifier
   */
  for: string;
  /**
   * The interface of the proxy that has received the request (`by`), or `null`
   */
  by?: string | null;
  /** The `Host` that the proxy has received (`host`), or `null` */
  host?: string | null;
  /**
   * The protocol that the proxy has received (`proto`, e.g. `https`), or `null`
   */
  proto?: string | null;
  /**
   * The `secret` extension parameter (e.g. a token shared with the proxy), or
   * `null`
   */
  secret?: string | null;
}

/** An element of the `Forwarded` header (RFC 7239) */
export class Forwarded implements IForwarded {
  readonly #for: string;
  readonly #by?: string | null;
  readonly #host?: string | null;
  readonly #secret?: string | null;
  readonly #proto?: string | null;

  /**
   * The parameters of an element: strings that a field value can carry (no
   * control characters but tabs), sent as quoted strings when they are not
   * tokens. Anything else throws a `TypeError`.
   */
  public constructor({ by, host, secret, proto, ..._ }: IForwarded) {
    const parameters = { for: _.for, by, host, secret, proto };
    for (const [name, value] of Object.entries(parameters)) {
      const optional = name !== "for" && (value ?? null) === null;
      if (!optional && !(typeof value === "string" && fieldValue.test(value))) {
        throw new TypeError(`Invalid \`${name}\` parameter`);
      }
    }
    this.#for = _.for;
    this.#by = by ?? null;
    this.#host = host ?? null;
    this.#secret = secret ?? null;
    this.#proto = proto ?? null;
  }

  /** The client of the proxy (`for`), `unknown` when the element has none */
  public get for(): string {
    return this.#for;
  }

  /** The interface of the proxy (`by`), or `null` */
  public get by(): string | null {
    return this.#by ?? null;
  }

  /** The `Host` that the proxy has received (`host`), or `null` */
  public get host(): string | null {
    return this.#host ?? null;
  }

  /** The `secret` extension parameter, or `null` */
  public get secret(): string | null {
    return this.#secret ?? null;
  }

  /** The protocol that the proxy has received (`proto`), or `null` */
  public get proto(): string | null {
    return this.#proto ?? null;
  }

  /** The element, with its values that are not tokens as quoted strings */
  public toString(): string {
    const { by, host, secret, proto } = this;
    return Object.entries({ for: this.for, by, host, secret, proto })
      .filter((entry): entry is [string, string] => entry[1] !== null)
      .map(([name, value]) => `${name}=${quote(value)}`)
      .join(";");
  }

  /** The valid elements of the header (see `.parse()`) */
  public static fromString(input?: string): Forwarded[] {
    return Forwarded.parse(input).filter(
      (element): element is Forwarded => element !== null,
    );
  }

  /**
   * The elements of the header in their order, `null` for an invalid one
   * (RFC 7239, section 4): a parameter that is not `name=value` (a quoted
   * string, or a value without spaces and separators, also the unquoted IPv6
   * addresses and ports that some proxies send), or that occurs more than
   * once. Empty elements are ignored (RFC 9110, section 5.6.1). Their position
   * tells which proxy has added them: every proxy appends its own.
   */
  public static parse(input?: string): (Forwarded | null)[] {
    if (typeof input === "undefined") {
      return [];
    }
    return split(input, ",")
      .filter((element) => !/^[\s;]*$/u.test(element))
      .map((element) => Forwarded.#parseElement(element));
  }

  static #parseElement(input: string): Forwarded | null {
    const parameters = new Map<string, string>();
    const pairs = split(input, ";").filter((pair) => pair.trim() !== "");
    for (const pair of pairs) {
      const { name = "", value = "" } =
        /^\s*(?<name>[!#$%&'*+.^_`|~\w-]+)\s*=\s*(?<value>[^\s",;]+|"(?:[^"\\]|\\.)*")\s*$/u.exec(
          pair,
        )?.groups ?? {};
      const key = name.toLowerCase();
      if (key === "" || parameters.has(key)) {
        return null;
      }
      parameters.set(key, unquote(value));
    }
    try {
      return new Forwarded({
        for: parameters.get("for") ?? "unknown",
        by: parameters.get("by") ?? null,
        host: parameters.get("host") ?? null,
        proto: parameters.get("proto") ?? null,
        secret: parameters.get("secret") ?? null,
      });
    } catch {
      // E.g. control characters in a quoted string
      return null;
    }
  }
}

export default Forwarded;
