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

  public static fromString(input?: string): Forwarded[] {
    if (typeof input === "undefined" || input.length === 0) {
      return [];
    }

    return input
      .split(",")
      .map((e) => Forwarded.#parseDirectives(e))
      .filter((e): e is IForwarded => Boolean(e))
      .map((e) => new Forwarded(e));
  }

  static #formatDirective(input: string): string {
    return input.startsWith("[") && input.includes("]") ? `"${input}"` : input;
  }

  static #parseDirectives(input: string): IForwarded | null {
    const props = ["for", "by", "secret", "host", "proto"];

    const directives = input
      .split(";")
      .map((e) => e.split("="))
      .map<[string, string]>(([k, v]) => [
        k.trim(),
        (v as string | undefined)?.trim() ?? "",
      ])
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
