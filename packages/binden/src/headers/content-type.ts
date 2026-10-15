import { fieldValue, split, unquote } from "./list.js";

/** A media type of `Content-Type` and its parameters */
export interface IContentType {
  /** The media type: `type/subtype`, of tokens */
  type: string;
  /**
   * The `charset` parameter, or `null` (by default): not of
   * `multipart/form-data`
   */
  charset?: string | null;
  /**
   * The `boundary` parameter: required by `multipart/form-data`, ignored for
   * any other type
   */
  boundary?: string | null;
  /** Other parameters (their names are case-insensitive) */
  parameters?: Readonly<Record<string, string>>;
}

const token = "[!#$%&'*+.^_`|~\\w-]+";

/** `type/subtype` */
const mediaType = new RegExp(`^${token}/${token}$`, "u");

/** The name of a parameter */
const parameterName = new RegExp(`^${token}$`, "u");

/** The `Content-Type` header (RFC 9110, section 8.3) */
export class ContentType implements IContentType {
  readonly #type: string;
  readonly #charset: string | null;
  readonly #boundary: string | null;
  readonly #parameters: ReadonlyMap<string, string>;

  /**
   * A media type (`type/subtype`, of tokens) with its parameters: a token as
   * name, and a value that a field value can carry (no control characters but
   * tabs, nothing above `\xFF`), sent as a quoted string when it is not a
   * token. Invalid ones throw a `TypeError`.
   */
  public constructor({
    type,
    charset = null,
    boundary = null,
    parameters = {},
  }: IContentType) {
    if (!mediaType.test(type)) {
      throw new TypeError(`Invalid media type: ${type}`);
    }
    const all = new Map<string, string>();
    for (const [name, value] of Object.entries(parameters)) {
      const key = name.toLowerCase();
      if (!all.has(key)) {
        all.set(key, value);
      }
    }
    this.#type = type;
    this.#boundary = null;
    this.#charset = null;
    // `boundary` (of `multipart/form-data` only, in any case) and `charset`
    // (of the other types) are the options themselves
    if (type.toLowerCase() === "multipart/form-data") {
      if (typeof boundary !== "string" || !boundary) {
        throw new TypeError("`boundary` is missing");
      }
      this.#boundary = boundary;
      all.set("boundary", boundary);
      all.delete("charset");
    } else {
      all.delete("boundary");
      if (typeof charset === "string" && charset) {
        this.#charset = charset;
        all.set("charset", charset);
      } else {
        all.delete("charset");
      }
    }
    for (const [name, value] of all) {
      if (!parameterName.test(name)) {
        throw new TypeError(`Invalid parameter name: ${name}`);
      } else if (!fieldValue.test(value)) {
        throw new TypeError(`Invalid value of the parameter ${name}`);
      }
    }
    this.#parameters = all;
  }

  /** The media type (in lowercase when parsed) */
  public get type(): string {
    return this.#type;
  }

  /** The `charset` parameter (in lowercase when parsed), or `null` */
  public get charset(): string | null {
    return this.#charset;
  }

  /** The `boundary` of `multipart/form-data`, or `null` for any other type */
  public get boundary(): string | null {
    return this.#boundary;
  }

  /** Every parameter, by its name in lowercase */
  public get parameters(): Record<string, string> {
    return Object.fromEntries(this.#parameters);
  }

  /**
   * The field value: the media type and its parameters, joined by `; `, with
   * the values that are not tokens quoted
   */
  public toString(): string {
    return [
      this.type,
      ...[...this.#parameters].map(
        ([name, value]) => `${name}=${ContentType.#quote(value)}`,
      ),
    ].join("; ");
  }

  /** `type/subtype *( OWS ";" OWS parameter )` (RFC 9110, section 8.3.1) */
  public static fromString(input?: string): ContentType | null {
    const [rawType = "", ...rest] = split(input ?? "", ";");
    const type = rawType.trim().toLowerCase();

    // Parameter names are case-insensitive (RFC 9110, section 5.6.6)
    const parameters = new Map<string, string>();
    for (const parameter of rest) {
      const index = parameter.indexOf("=");
      const name = parameter.slice(0, Math.max(index, 0)).trim().toLowerCase();
      if (parameterName.test(name) && !parameters.has(name)) {
        const value = unquote(parameter.slice(index + 1).trim());
        parameters.set(name, name === "charset" ? value.toLowerCase() : value);
      }
    }

    try {
      return new ContentType({
        type,
        charset: parameters.get("charset") ?? null,
        boundary: parameters.get("boundary") ?? null,
        parameters: Object.fromEntries(parameters),
      });
    } catch {
      // E.g. not a media type, or `multipart/form-data` without a boundary
      return null;
    }
  }

  /** A token as is, anything else as a quoted string */
  static #quote(value: string): string {
    return /^[!#$%&'*+.^_`|~\w-]+$/u.test(value)
      ? value
      : `"${value.replaceAll(/(?<char>["\\])/gu, "\\$<char>")}"`;
  }
}

export default ContentType;
