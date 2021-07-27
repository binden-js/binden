export interface IContentType {
  type: string;
  charset?: string;
  boundary?: string;
}

export class ContentType implements IContentType {
  readonly #type: string;
  readonly #charset?: string;
  readonly #boundary?: string;

  public constructor({ type, charset, boundary }: IContentType) {
    this.#type = type;
    if (this.#type === "multipart/form-data") {
      if (!boundary) {
        throw new TypeError("`boundary` is missing");
      }
      this.#boundary = boundary;
    } else if (charset) {
      this.#charset = charset;
    }
  }

  public get type(): string {
    return this.#type;
  }

  public get charset(): string | undefined {
    return this.#charset;
  }

  public get boundary(): string | undefined {
    return this.#boundary;
  }

  public toString(): string {
    return this.boundary
      ? `${this.type}; boundary=${this.boundary}`
      : this.charset
      ? `${this.type}; charset=${this.charset}`
      : this.type;
  }

  public static fromString(input?: string): ContentType | null {
    if (!input?.length) {
      return null;
    }

    const [rawType, extra = ""] = input.split(";").map((e) => e.trim());

    if (!rawType) {
      return null;
    }

    const type = rawType.toLowerCase();

    const [key = "", boundary = ""] = extra
      .split("=")
      .map((e) => e.trim())
      .filter((e) => e);

    if (type === "multipart/form-data") {
      return key.toLowerCase() !== "boundary" || !boundary
        ? null
        : new ContentType({ type, boundary });
    }

    if (key.toLowerCase() === "charset") {
      return new ContentType({
        type,
        charset:
          boundary.startsWith(`"`) && boundary.endsWith(`"`)
            ? boundary.length > 2
              ? boundary.substring(1, boundary.length - 1).toLowerCase()
              : ""
            : boundary.toLowerCase(),
      });
    }

    return new ContentType({ type });
  }
}

export default ContentType;
