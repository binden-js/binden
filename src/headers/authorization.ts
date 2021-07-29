export type IAuthenticationType =
  | "Basic"
  | "Bearer"
  | "Digest"
  | "HOBA"
  | "Mutual"
  | "OAuth"
  | "SCRAM-SHA-1"
  | "SCRAM-SHA-256"
  | "vapid"
  | "AWS4-HMAC-SHA256";

export interface IAuthorization {
  type: IAuthenticationType;
  credentials?: string;
}

export class Authorization implements IAuthorization {
  readonly #type: IAuthenticationType;
  readonly #credentials?: string;

  public constructor({ type, credentials }: IAuthorization) {
    this.#type = type;
    this.#credentials = credentials;
  }

  public get type(): IAuthenticationType {
    return this.#type;
  }

  public get credentials(): string | undefined {
    return this.#credentials;
  }

  public toString(): string {
    return this.#credentials
      ? `${this.#type} ${this.#credentials}`
      : this.#type;
  }

  public static fromString(input?: string): Authorization | null {
    if (!input?.length) {
      return null;
    }

    const [type, credentials = ""] = input.trim().split(" ");

    return !Authorization.isValidType(type)
      ? null
      : new Authorization({ type, credentials });
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
