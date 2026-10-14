import { fieldValue } from "./list.js";

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
  type: IAuthenticationType;
  credentials?: string | null;
}

/** The `Authorization` header (RFC 9110, section 11.6.2) */
export class Authorization implements IAuthorization {
  readonly #type: IAuthenticationType;
  readonly #credentials: string | null;

  /**
   * A supported scheme (in its usual casing) and its credentials: `null`, or
   * what a field value can carry, without leading or trailing whitespace.
   * Anything else throws a `TypeError`.
   */
  public constructor({ type, credentials = null }: IAuthorization) {
    if (!Authorization.isValidType(type)) {
      throw new TypeError(`Unsupported authentication scheme: ${String(type)}`);
    } else if (
      credentials !== null &&
      (credentials === "" ||
        credentials !== credentials.trim() ||
        !fieldValue.test(credentials))
    ) {
      throw new TypeError("Invalid credentials");
    }
    this.#type = type;
    this.#credentials = credentials;
  }

  public get type(): IAuthenticationType {
    return this.#type;
  }

  public get credentials(): string | null {
    return this.#credentials;
  }

  public toString(): string {
    return typeof this.#credentials === "string"
      ? `${this.#type} ${this.#credentials}`
      : this.#type;
  }

  public static fromString(input?: string): Authorization | null {
    // auth-scheme [ 1*SP ( token68 / #auth-param ) ] (RFC 9110, section 11.4)
    const { scheme = "", rest = "" } =
      /^(?<scheme>[!#$%&'*+.^_`|~\w-]+)(?: +(?<rest>.*))?$/u.exec(
        input?.trim() ?? "",
      )?.groups ?? {};
    // The scheme is case-insensitive (RFC 9110, section 11.1)
    const type = Authorization.#types.get(scheme.toLowerCase());

    if (typeof type === "undefined") {
      return null;
    }

    const credentials = rest.trim();
    try {
      return new Authorization({
        type,
        credentials: credentials === "" ? null : credentials,
      });
    } catch {
      // E.g. control characters
      return null;
    }
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
