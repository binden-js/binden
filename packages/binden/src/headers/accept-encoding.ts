export type IAcceptEncodings =
  "*" | "br" | "compress" | "deflate" | "gzip" | "identity" | "x-gzip" | "zstd";

export interface IAcceptEncoding {
  encoding: IAcceptEncodings;
  q_value?: number | null;
}

/** A weight from 0 to 1, with at most 3 decimals (RFC 9110, section 12.4.2) */
const qvalue = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/u;

export class AcceptEncoding implements IAcceptEncoding {
  readonly #encoding: IAcceptEncodings;
  readonly #q_value: number | null;

  public constructor({ encoding, q_value = null }: IAcceptEncoding) {
    if (!AcceptEncoding.#encodings.includes(encoding)) {
      throw new TypeError(`Unknown content coding: ${String(encoding)}`);
    } else if (q_value !== null && !qvalue.test(`${q_value}`)) {
      throw new TypeError(`\`q_value\` is not a qvalue: ${q_value}`);
    }
    this.#encoding = encoding;
    this.#q_value = q_value;
  }

  public get encoding(): IAcceptEncodings {
    return this.#encoding;
  }

  public get q_value(): number | null {
    return this.#q_value;
  }

  public toString(): string {
    const { q_value, encoding } = this;
    return typeof q_value === "number" ? `${encoding};q=${q_value}` : encoding;
  }

  public static fromString(string?: string[] | string): AcceptEncoding[] {
    let input = string;

    if (typeof input === "undefined") {
      return [];
    } else if (Array.isArray(input)) {
      input = input.join(",");
    }

    // Content codings and the `q` parameter are case-insensitive (RFC 9110)
    return input
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
      .filter(
        (e): e is [IAcceptEncodings, number | null] =>
          e !== null && AcceptEncoding.#encodings.includes(e[0]),
      )
      .map(([encoding, q_value]) => new AcceptEncoding({ encoding, q_value }))
      .sort(({ q_value: a }, { q_value: b }) => (b ?? 1) - (a ?? 1));
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
