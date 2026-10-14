import { split, unquote } from "./list.js";

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
      ? `${this.type}; boundary=${ContentType.#quote(this.boundary)}`
      : typeof this.charset === "string" && this.charset
        ? `${this.type}; charset=${this.charset}`
        : this.type;
  }

  /** `type/subtype *( OWS ";" OWS parameter )` (RFC 9110, section 8.3.1) */
  public static fromString(input?: string): ContentType | null {
    const [rawType = "", ...rest] = split(input ?? "", ";");
    const type = rawType.trim().toLowerCase();

    if (!type) {
      return null;
    }

    // Parameter names are case-insensitive (RFC 9110, section 5.6.6)
    const parameters = new Map<string, string>();
    for (const parameter of rest) {
      const index = parameter.indexOf("=");
      const name = parameter.slice(0, Math.max(index, 0)).trim().toLowerCase();
      if (index > 0 && !parameters.has(name)) {
        const value = parameter.slice(index + 1).trim();
        parameters.set(name, unquote(value));
      }
    }

    if (type === "multipart/form-data") {
      const boundary = parameters.get("boundary") ?? "";
      return boundary ? new ContentType({ type, boundary }) : null;
    }

    const charset = parameters.get("charset")?.toLowerCase() ?? null;
    return new ContentType({ type, charset });
  }

  /** A token as is, anything else as a quoted string */
  static #quote(value: string): string {
    return /^[!#$%&'*+.^_`|~\w-]+$/u.test(value)
      ? value
      : `"${value.replaceAll(/(?<char>["\\])/gu, "\\$<char>")}"`;
  }
}

export default ContentType;
