export type IEncodings = "br" | "compress" | "deflate" | "gzip" | "x-gzip";

export interface IContentEncoding {
  encoding: IEncodings;
}

export class ContentEncoding implements IContentEncoding {
  readonly #encoding: IEncodings;

  public constructor({ encoding }: IContentEncoding) {
    this.#encoding = encoding;
  }

  public get encoding(): IEncodings {
    return this.#encoding;
  }

  public toString(): string {
    return this.#encoding;
  }

  /**
   * The codings in the order to remove them (the last applied first), or `null`
   * when one of them is unknown or malformed: the content cannot be decoded
   * then (RFC 9110, section 8.4)
   */
  public static fromString(input?: string): ContentEncoding[] | null {
    if (typeof input === "undefined") {
      return [];
    }

    // Codings are case-insensitive, empty list elements are ignored (RFC 9110,
    // sections 8.4.1 and 5.6.1)
    const codings = input
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e !== "");

    if (!codings.every((e) => ContentEncoding.#encodings.has(e))) {
      return null;
    }

    return (codings as IEncodings[])
      .map((encoding) => new ContentEncoding({ encoding }))
      .reverse();
  }

  static readonly #encodings: ReadonlySet<string> = new Set([
    "gzip",
    "x-gzip",
    "compress",
    "deflate",
    "br",
  ]);
}

export default ContentEncoding;
