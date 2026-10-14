import { split, unquote } from "./list.js";

export interface IForwarded {
  for: string;
  by?: string | null;
  host?: string | null;
  proto?: string | null;
  secret?: string | null;
}

export class Forwarded implements IForwarded {
  readonly #for: string;
  readonly #by?: string | null;
  readonly #host?: string | null;
  readonly #secret?: string | null;
  readonly #proto?: string | null;

  public constructor({ by, host, secret, proto, ..._ }: IForwarded) {
    this.#for = _.for;
    this.#by = by ?? null;
    this.#host = host ?? null;
    this.#secret = secret ?? null;
    this.#proto = proto ?? null;
  }

  public get for(): string {
    return this.#for;
  }

  public get by(): string | null {
    return this.#by ?? null;
  }

  public get host(): string | null {
    return this.#host ?? null;
  }

  public get secret(): string | null {
    return this.#secret ?? null;
  }

  public get proto(): string | null {
    return this.#proto ?? null;
  }

  public toString(): string {
    let output = `for=${Forwarded.#formatDirective(this.for)}`;
    const { by, host, secret, proto } = this;
    output +=
      typeof by === "string" ? `;by=${Forwarded.#formatDirective(by)}` : "";
    output +=
      typeof host === "string"
        ? `;host=${Forwarded.#formatDirective(host)}`
        : "";
    output += typeof secret === "string" ? `;secret=${secret}` : "";
    output += typeof proto === "string" ? `;proto=${proto}` : "";
    return output;
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

  static #formatDirective(input: string): string {
    return input.startsWith("[") && input.includes("]") ? `"${input}"` : input;
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
    return new Forwarded({
      for: parameters.get("for") ?? "unknown",
      by: parameters.get("by") ?? null,
      host: parameters.get("host") ?? null,
      proto: parameters.get("proto") ?? null,
      secret: parameters.get("secret") ?? null,
    });
  }
}

export default Forwarded;
