import {
  checkFieldValue,
  fieldValue,
  split,
  stringOf,
  unquote,
} from "./list.js";
import { described, formatting, objectOf } from "../formatting.js";
import { formatStack } from "../exchange.js";

/** A media type of `Content-Type` and its parameters */
export interface IContentType {
  /** The media type: `type/subtype`, of tokens */
  type: string;
  /**
   * The `charset` parameter, or `null` (by default): not of
   * `multipart/form-data`. A value of another type is refused.
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

/**
 * A valid media type (converted once, see `stringOf()`), its options, and all
 * its parameters by name
 */
interface IChecked {
  readonly type: string;
  charset: string | null;
  boundary: string | null;
  readonly parameters: ReadonlyMap<string, string>;
}

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
   * token. Invalid ones throw a `TypeError`, and so does an init or parameters
   * that are not an object, or a `charset` that is not a string (nor `null`),
   * described without converting it. What reading them throws (e.g. a
   * revoked proxy) is formatted (see `formatting()`).
   */
  public constructor(init: IContentType) {
    // Each value is read once (e.g. by a getter), and so are the parameters
    // (see `#checked()`): the values checked are the ones kept
    const checked = formatting(() => {
      const {
        type,
        charset = null,
        boundary = null,
        parameters = {},
      } = objectOf(init, "init") as IContentType;
      return ContentType.#checked({ type, charset, boundary, parameters });
    });
    if (typeof checked === "string") {
      throw formatStack(new TypeError(checked));
    }
    this.#type = checked.type;
    this.#boundary = checked.boundary;
    this.#charset = checked.charset;
    this.#parameters = checked.parameters;
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

  /**
   * `type/subtype *( OWS ";" OWS parameter )` (RFC 9110, section 8.3.1), or
   * `null` (invalid or missing). An input that is neither a string nor
   * `undefined` throws a `TypeError`.
   */
  public static fromString(input?: string): ContentType | null {
    checkFieldValue(input);
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

    const init = {
      type,
      charset: parameters.get("charset") ?? null,
      boundary: parameters.get("boundary") ?? null,
      parameters: Object.fromEntries(parameters),
    };
    // Checked first: an invalid header (e.g. not a media type, or
    // `multipart/form-data` without a boundary) creates no error, whose stack
    // would be formatted (see `formatStack()`)
    return typeof ContentType.#checked(init) === "string"
      ? null
      : new ContentType(init);
  }

  /**
   * The state of a valid media type (see the constructor): its `charset`, its
   * `boundary` and all its parameters by their names in lowercase (the first
   * one of a name wins, but the options), the media type and the values of
   * the parameters converted once when they are not strings (see
   * `stringOf()`), or why it is invalid (e.g. a `charset` of another type than
   * a string, refused by its type, for every media type)
   */
  static #checked({
    type,
    charset = null,
    boundary = null,
    parameters = {},
  }: IContentType): IChecked | string {
    const media = stringOf(type);
    if (!mediaType.test(media)) {
      return `Invalid media type: ${media}`;
    } else if (
      typeof parameters !== "object" ||
      (parameters as unknown) === null
    ) {
      return `\`parameters\` is not an object: ${described(parameters)}`;
    } else if (charset !== null && typeof charset !== "string") {
      // Never converted, nor dropped
      return `\`charset\` is not a string: ${described(charset)}`;
    }
    const all = new Map<string, string>();
    for (const [name, value] of Object.entries(parameters)) {
      const key = name.toLowerCase();
      if (!all.has(key)) {
        all.set(key, stringOf(value));
      }
    }
    // `boundary` (of `multipart/form-data` only, in any case) and `charset`
    // (of the other types) are the options themselves
    const state: IChecked = {
      type: media,
      charset: null,
      boundary: null,
      parameters: all,
    };
    if (media.toLowerCase() === "multipart/form-data") {
      if (typeof boundary !== "string" || !boundary) {
        return "`boundary` is missing";
      }
      state.boundary = boundary;
      all.set("boundary", boundary);
      all.delete("charset");
    } else {
      all.delete("boundary");
      if (typeof charset === "string" && charset) {
        state.charset = charset;
        all.set("charset", charset);
      } else {
        all.delete("charset");
      }
    }
    for (const [name, value] of all) {
      if (!parameterName.test(name)) {
        return `Invalid parameter name: ${name}`;
      } else if (!fieldValue.test(value)) {
        return `Invalid value of the parameter ${name}`;
      }
    }
    return state;
  }

  /** A token as is, anything else as a quoted string */
  static #quote(value: string): string {
    return /^[!#$%&'*+.^_`|~\w-]+$/u.test(value)
      ? value
      : `"${value.replaceAll(/(?<char>["\\])/gu, "\\$<char>")}"`;
  }
}

export default ContentType;
