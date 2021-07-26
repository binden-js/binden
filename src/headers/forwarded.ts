export interface IForwarded {
  for: string;
  by?: string;
  host?: string;
  proto?: string;
  secret?: string;
}

export class Forwarded implements IForwarded {
  readonly #for: string;
  readonly #by?: string;
  readonly #host?: string;
  readonly #secret?: string;
  readonly #proto?: string;

  public constructor({ by, host, secret, proto, ..._ }: IForwarded) {
    this.#for = _.for;
    this.#by = by;
    this.#host = host;
    this.#secret = secret;
    this.#proto = proto;
  }

  public get for(): string {
    return this.#for;
  }

  public get by(): string | undefined {
    return this.#by;
  }

  public get host(): string | undefined {
    return this.#host;
  }

  public get secret(): string | undefined {
    return this.#secret;
  }

  public get proto(): string | undefined {
    return this.#proto;
  }

  public toString(): string {
    let output = `for=${Forwarded.#formatDirective(this.for)}`;
    const { by, host, secret, proto } = this;
    output += by ? `;by=${Forwarded.#formatDirective(by)}` : "";
    output += host ? `;host=${Forwarded.#formatDirective(host)}` : "";
    output += secret ? `;secret=${secret}` : "";
    output += proto ? `;proto=${proto}` : "";
    return output;
  }

  public static fromString(input?: string): Forwarded[] {
    if (!input?.length) {
      return [];
    }

    return input
      .split(",")
      .map((e) => Forwarded.#parseDirectives(e))
      .filter((e): e is IForwarded => (e ? true : false))
      .map((e) => new Forwarded(e));
  }

  static #formatDirective(input: string): string {
    return input?.startsWith("[") && input.includes("]") ? `"${input}"` : input;
  }

  static #parseDirectives(input: string): IForwarded | null {
    const props = ["for", "by", "secret", "host", "proto"];

    const directives = input
      .split(";")
      .map((e) => e.split("="))
      .map<[string, string]>(([k, v]) => [k.trim(), v?.trim() ?? ""])
      .map<[string, string]>(([k, v]) => [
        k.toLowerCase(),
        v.startsWith(`"`) && v.endsWith(`"`)
          ? v.length > 2
            ? v.substring(1, v.length - 1)
            : ""
          : v,
      ])
      .filter(([k, v]) => k && v && props.includes(k));

    return directives.length
      ? directives.reduce<IForwarded>((a, [k, v]) => ({ ...a, [k]: v }), {
          for: "unknown",
        })
      : null;
  }
}

export default Forwarded;
