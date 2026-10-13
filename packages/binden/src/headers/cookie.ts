export interface ICookie {
  readonly key: string;
  readonly value: string;
  readonly expires?: Date | null;
  readonly max_age?: number | null;
  readonly domain?: string | null;
  readonly path?: string | null;
  readonly secure?: boolean;
  readonly http_only?: boolean;
  readonly same_site?: "Lax" | "None" | "Strict";
}

/** A token (RFC 9110, section 5.6.2) */
const token = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

/** cookie-octets, maybe in double quotes (RFC 6265, section 4.1.1) */
const cookieValue =
  /^(?:"[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*"|[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*)$/u;

/** Any character but the controls and `;` (RFC 6265, section 4.1.1) */
const attributeValue = /^[\x20-\x3A\x3C-\x7E]*$/u;

/** Labels of letters, digits and hyphens (a leading dot is allowed) */
const domainValue =
  /^\.?[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/u;

const sameSite: ReadonlySet<string> = new Set(["Lax", "None", "Strict"]);

export class Cookie implements ICookie {
  readonly #key: string;
  readonly #value: string;
  readonly #expires: Date | null;
  readonly #max_age: number | null;
  readonly #domain: string | null;
  readonly #path: string | null;
  readonly #secure: boolean;
  readonly #http_only: boolean;
  readonly #same_site: "Lax" | "None" | "Strict";

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
    // An invalid name or attribute could add attributes to `Set-Cookie`
    if (!token.test(key)) {
      throw new TypeError(`Invalid cookie name: ${key}`);
    } else if (!cookieValue.test(value)) {
      throw new TypeError("Invalid cookie value");
    } else if (max_age !== null && !Number.isSafeInteger(max_age)) {
      throw new TypeError(`Invalid cookie Max-Age: ${max_age}`);
    } else if (expires instanceof Date && Number.isNaN(expires.getTime())) {
      throw new TypeError("Invalid cookie Expires");
    } else if (domain !== null && !domainValue.test(domain)) {
      throw new TypeError(`Invalid cookie Domain: ${domain}`);
    } else if (path !== null && !attributeValue.test(path)) {
      throw new TypeError(`Invalid cookie Path: ${path}`);
    } else if (!sameSite.has(same_site)) {
      throw new TypeError(`Invalid cookie SameSite: ${same_site}`);
    }

    this.#key = key;
    this.#value = value;
    this.#max_age = max_age;
    this.#domain = domain;
    this.#path = path;
    this.#secure = Boolean(secure);
    this.#http_only = Boolean(http_only);
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
    return this.key.startsWith("__Host-") ? null : this.#domain;
  }

  public get path(): string | null {
    return this.key.startsWith("__Host-") ? "/" : this.#path;
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

  public get same_site(): "Lax" | "None" | "Strict" {
    return this.#same_site;
  }

  public toString(): string {
    let output = `${this.key}=${this.value}`;
    output +=
      typeof this.max_age === "number"
        ? `; Max-Age=${this.max_age}`
        : this.expires
          ? `; Expires=${this.expires.toUTCString()}`
          : "";
    output += typeof this.domain === "string" ? `; Domain=${this.domain}` : "";
    output += typeof this.path === "string" ? `; Path=${this.path}` : "";
    output += this.secure ? `; Secure` : "";
    output += this.http_only ? `; HttpOnly` : "";
    output += `; SameSite=${this.same_site}`;
    return output;
  }

  public static fromString(input?: string): Cookie[] {
    if (typeof input !== "string" || input.length < 3) {
      return [];
    }

    const output: Cookie[] = [];

    for (const pair of input.split(";")) {
      // The value may contain `=` (e.g. base64)
      const index = pair.indexOf("=");
      const key = pair.slice(0, Math.max(index, 0)).trim();
      const raw = pair.slice(index + 1).trim();
      const value =
        raw.length >= 2 && raw.startsWith(`"`) && raw.endsWith(`"`)
          ? raw.slice(1, -1)
          : raw;

      if (index > 0 && value && !output.some((c) => c.key === key)) {
        try {
          output.push(new Cookie({ key, value }));
        } catch {
          // Not a valid cookie: skipped
        }
      }
    }

    return output;
  }
}

export default Cookie;
