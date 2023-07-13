export interface IContentType {
  type: string;
  charset?: string | null;
  boundary?: string | null;
}

export class ContentType implements IContentType {
  readonly #type: string;
  readonly #charset: string | null;
  readonly #boundary: string | null;

  public constructor({ type, charset = null, boundary = null }: IContentType) {
    this.#type = type;
    this.#boundary = null;
    this.#charset = null;
    if (type === "multipart/form-data") {
      if (typeof boundary !== "string" || !boundary) {
        throw new TypeError("`boundary` is missing");
      }
      this.#boundary = boundary;
    } else if (typeof charset === "string" && charset) {
      this.#charset = charset;
    }
  }

  public get type(): string {
    return this.#type;
  }

  public get charset(): string | null {
    return this.#charset;
  }

  public get boundary(): string | null {
    return this.#boundary;
  }

  public toString(): string {
    return typeof this.boundary === "string"
      ? `${this.type}; boundary=${this.boundary}`
      : typeof this.charset === "string" && this.charset
      ? `${this.type}; charset=${this.charset}`
      : this.type;
  }

  public static fromString(input?: string): ContentType | null {
    if (typeof input === "undefined" || input.length === 0) {
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
