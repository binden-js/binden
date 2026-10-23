import { checkFieldValue, fieldValue, stringOf } from "./list.js";
import { described, formatting, objectOf } from "../formatting.js";
import { formatStack } from "../exchange.js";

/** The supported authentication schemes, in their usual casing */
export type IAuthenticationType =
  | "AWS4-HMAC-SHA256"
  | "Basic"
  | "Bearer"
  | "Digest"
  | "HOBA"
  | "Mutual"
  | "OAuth"
  | "SCRAM-SHA-1"
  | "SCRAM-SHA-256"
  | "vapid";

/** The scheme and the credentials of `Authorization` */
export interface IAuthorization {
  /** The authentication scheme, in its usual casing (e.g. `Bearer`) */
  type: IAuthenticationType;
  /**
   * What follows the scheme (a token68 or auth-params, as received), or `null`
   * (by default) for none
   */
  credentials?: string | null;
}

/** The `Authorization` header (RFC 9110, section 11.6.2) */
export class Authorization implements IAuthorization {
  readonly #type: IAuthenticationType;
  readonly #credentials: string | null;

  /**
   * A supported scheme (in its usual casing) and its credentials: `null`, or
   * what a field value can carry, without leading or trailing whitespace.
   * Anything else throws a `TypeError` (an unsupported scheme described
   * without converting it, see `described()`), and so does an init that is
   * not an object. What reading it throws (e.g. a revoked proxy) is formatted
   * (see `formatting()`).
   */
  public constructor(init: IAuthorization) {
    // Each value is read once (e.g. by a getter), and the credentials
    // converted once when they are not a string (see `stringOf()`): the
    // values checked are the ones kept
    const checked = formatting(() =>
      Authorization.#read(objectOf(init, "init") as IAuthorization),
    );
    const refusal = Authorization.#refusal(checked);
    if (refusal !== null) {
      throw formatStack(new TypeError(refusal));
    }
    this.#type = checked.type;
    this.#credentials = checked.credentials;
  }

  /** The authentication scheme, in its usual casing */
  public get type(): IAuthenticationType {
    return this.#type;
  }

  /** The credentials as received (e.g. the base64 of `Basic`), or `null` */
  public get credentials(): string | null {
    return this.#credentials;
  }

  /** The field value: the scheme, then a space and the credentials */
  public toString(): string {
    return typeof this.#credentials === "string"
      ? `${this.#type} ${this.#credentials}`
      : this.#type;
  }

  /**
   * The header (its scheme in any case), or `null` when it is missing,
   * malformed, of an unsupported scheme or with invalid credentials (e.g.
   * control characters). An input that is neither a string nor `undefined`
   * throws a `TypeError`.
   */
  public static fromString(input?: string): Authorization | null {
    checkFieldValue(input);
    // auth-scheme [ 1*SP ( token68 / #auth-param ) ] (RFC 9110, section 11.4),
    // split at the first space (a regular expression with ` +` before `.*`
    // would backtrack polynomially on long runs of spaces)
    const value = input?.trim() ?? "";
    const space = value.indexOf(" ");
    const head = space === -1 ? value : value.slice(0, space);
    const scheme = /^[!#$%&'*+.^_`|~\w-]+$/u.test(head) ? head : "";
    const rest = space === -1 ? "" : value.slice(space + 1);
    // The scheme is case-insensitive (RFC 9110, section 11.1)
    const type = Authorization.#types.get(scheme.toLowerCase());

    if (typeof type === "undefined") {
      return null;
    }

    const credentials = rest.trim();
    const init = { type, credentials: credentials === "" ? null : credentials };
    // Checked first: invalid credentials (e.g. with control characters)
    // create no error, whose stack would be formatted (see `formatStack()`)
    return Authorization.#refusal(init) === null
      ? new Authorization(init)
      : null;
  }

  /** The values of an init, each read once, the credentials converted once */
  static #read({ type, credentials = null }: IAuthorization): {
    readonly type: IAuthenticationType;
    readonly credentials: string | null;
  } {
    return {
      type,
      credentials: credentials === null ? null : stringOf(credentials),
    };
  }

  /**
   * Why a header is invalid (see the constructor), `null` when it is valid
   */
  static #refusal({ type, credentials = null }: IAuthorization): string | null {
    if (!Authorization.isValidType(type)) {
      return `Unsupported authentication scheme: ${described(type)}`;
    } else if (
      credentials !== null &&
      (credentials === "" ||
        credentials !== credentials.trim() ||
        !fieldValue.test(credentials))
    ) {
      return "Invalid credentials";
    }
    return null;
  }

  /** The supported schemes by their lowercase names */
  static readonly #types: ReadonlyMap<string, IAuthenticationType> = new Map(
    (
      [
        "AWS4-HMAC-SHA256",
        "Basic",
        "Bearer",
        "Digest",
        "HOBA",
        "Mutual",
        "OAuth",
        "SCRAM-SHA-1",
        "SCRAM-SHA-256",
        "vapid",
      ] as const
    ).map((type) => [type.toLowerCase(), type]),
  );

  /** Whether the input is a supported scheme, in its usual casing */
  public static isValidType(input?: string): input is IAuthenticationType {
    return (
      typeof input === "string" &&
      Authorization.#types.get(input.toLowerCase()) === input
    );
  }
}

export default Authorization;
