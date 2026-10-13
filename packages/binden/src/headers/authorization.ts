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
    if (typeof input === "undefined" || input.length === 0) {
      return null;
    }

    const [type, credentials = ""] = input.trim().split(" ");

    return Authorization.isValidType(type)
      ? new Authorization({ type, credentials })
      : null;
  }

  public static isValidType(input?: string): input is IAuthenticationType {
    switch (input) {
      case "Basic":
      case "Bearer":
      case "Digest":
      case "HOBA":
      case "Mutual":
      case "OAuth":
      case "SCRAM-SHA-1":
      case "SCRAM-SHA-256":
      case "vapid":
      case "AWS4-HMAC-SHA256":
        return true;
      default:
        return false;
    }
  }
}

export default Authorization;
