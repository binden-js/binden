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

export interface IAuthorization {
  type: IAuthenticationType;
  credentials?: string | null;
}

export class Authorization implements IAuthorization {
  readonly #type: IAuthenticationType;
  readonly #credentials: string | null;

  public constructor({ type, credentials = null }: IAuthorization) {
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
    return new Authorization({
      type,
      credentials: credentials === "" ? null : credentials,
    });
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
