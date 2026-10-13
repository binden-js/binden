export type IAcceptEncodings =
  | "*"
  | "br"
  | "compress"
  | "deflate"
  | "gzip"
  | "identity"
  | "x-gzip";

export interface IAcceptEncoding {
  encoding: IAcceptEncodings;
  q_value?: number | null;
}

export class AcceptEncoding implements IAcceptEncoding {
  readonly #encoding: IAcceptEncodings;
  readonly #q_value: number | null;

  public constructor({ encoding, q_value = null }: IAcceptEncoding) {
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

    const encodings = [
      "gzip",
      "x-gzip",
      "compress",
      "deflate",
      "br",
      "*",
      "identity",
    ];

    return input
      .split(",")
      .map((e) => e.trim().split(";q="))
      .map<[string, number]>(([e, q]) => [
        e.trim(),
        Number((q as string | undefined)?.trim()),
      ])
      .filter((e): e is [IAcceptEncodings, number] => encodings.includes(e[0]))
      .map(([encoding, q_value]) => {
        if (isNaN(q_value)) {
          return new AcceptEncoding({ encoding });
        }
        return new AcceptEncoding({ encoding, q_value });
      })
      .sort(({ q_value: a }, { q_value: b }) => (b ?? 1) - (a ?? 1));
  }
}

export default AcceptEncoding;
