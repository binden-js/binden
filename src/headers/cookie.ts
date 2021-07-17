export interface ICookie {
  readonly key: string;
  readonly value: string;
  readonly expires?: Date | null;
  readonly max_age?: number | null;
  readonly domain?: string | null;
  readonly path?: string;
  readonly secure?: boolean;
  readonly http_only?: boolean;
  readonly same_site?: "Strict" | "Lax" | "None";
}

export class Cookie implements ICookie {
  readonly #key: string;
  readonly #value: string;
  readonly #expires: Date | null;
  readonly #max_age: number | null;
  readonly #domain: string | null;
  readonly #path: string;
  readonly #secure: boolean;
  readonly #http_only: boolean;
  readonly #same_site: "Strict" | "Lax" | "None";

  public constructor({
    key,
    value,
    expires = null,
    max_age = null,
    domain = null,
    path = "/",
    secure = false,
    http_only = true,
    same_site = "Lax",
  }: ICookie) {
    this.#key = key;
    this.#value = value;
    this.#max_age = max_age;
    this.#domain = domain;
    this.#path = path;
    this.#secure = secure ? true : false;
    this.#http_only = http_only ? true : false;
    this.#same_site = same_site;
    this.#expires = expires instanceof Date ? new Date(expires) : null;
  }

  public get key(): string {
    return this.#key;
  }

  public get value(): string {
    return this.#value;
  }

  public get expires(): Date | null {
    return this.#expires ? new Date(this.#expires) : null;
  }

  public get max_age(): number | null {
    return this.#max_age;
  }

  public get domain(): string | null {
    return !this.key.startsWith("__Host-") ? this.#domain : null;
  }

  public get path(): string {
    return !this.key.startsWith("__Host-") ? this.#path : "/";
  }

  public get secure(): boolean {
    return (
      this.key.startsWith("__Secure-") ||
      this.key.startsWith("__Host-") ||
      this.same_site === "None" ||
      this.#secure
    );
  }

  public get http_only(): boolean {
    return this.#http_only;
  }

  public get same_site(): "Strict" | "Lax" | "None" {
    return this.#same_site;
  }

  public toString(): string {
    const attributes: string[] = [`${this.key}=${this.value}`];

    if (this.max_age) {
      attributes.push(`Max-Age=${this.max_age}`);
    } else if (this.expires) {
      attributes.push(`Expires=${this.expires.toUTCString()}`);
    }

    if (this.domain) {
      attributes.push(`Domain=${this.domain}`);
    }

    if (this.path) {
      attributes.push(`Path=${this.path}`);
    }

    if (this.secure) {
      attributes.push("Secure");
    }

    if (this.http_only) {
      attributes.push("HttpOnly");
    }

    attributes.push(`SameSite=${this.same_site}`);

    return attributes.join("; ");
  }

  public static fromString(input?: string): Cookie[] {
    if (!input || input.length < 3) {
      return [];
    }

    const cookies = input
      .trim()
      .split("; ")
      .map((e) => e.trim())
      .filter((e) => e);

    const output: Cookie[] = [];

    for (const cookie of cookies) {
      const [key, rawValue] = cookie
        .split("=")
        .map((a) => a.trim())
        .filter((e) => e);

      const value =
        rawValue.startsWith(`"`) && rawValue.endsWith(`"`)
          ? rawValue.length > 2
            ? rawValue.slice(1, -1)
            : ""
          : rawValue;

      if (key && value && !output.find((c) => c.key === key)) {
        output.push(new Cookie({ key, value }));
      }
    }

    return output;
  }
}

export default Cookie;
