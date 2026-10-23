import { checkFieldValue, stringOf, timeOf } from "./list.js";
import { described, formatting, objectOf } from "../formatting.js";
import { formatStack } from "../exchange.js";

/** A cookie: its name, value and attributes (RFC 6265) */
export interface ICookie {
  /** The name of the cookie: a token */
  readonly key: string;
  /**
   * The value: cookie-octets (no spaces, `"`, `,`, `;` or `\`), maybe in double
   * quotes
   */
  readonly value: string;
  /**
   * When the cookie expires (`Expires`) unless `max_age` is set, or `null` (by
   * default) for a session cookie
   */
  readonly expires?: Date | null;
  /**
   * The lifetime in seconds (`Max-Age`, an integer), which takes precedence
   * over `expires`, or `null` (by default)
   */
  readonly max_age?: number | null;
  /**
   * The domain whose hosts get the cookie (`Domain`), or `null` (by default)
   * for the host of the origin only
   */
  readonly domain?: string | null;
  /**
   * The path prefix of the requests that get the cookie (`Path`, `/` by
   * default), or `null`
   */
  readonly path?: string | null;
  /**
   * Whether the cookie is sent over HTTPS only (`Secure`, `false` by default)
   */
  readonly secure?: boolean;
  /** Whether scripts cannot read the cookie (`HttpOnly`, `true` by default) */
  readonly http_only?: boolean;
  /** Which cross-site requests get the cookie (`SameSite`, `Lax` by default) */
  readonly same_site?: "Lax" | "None" | "Strict";
  /** Partitioned by the top-level site (CHIPS): implies `Secure` */
  readonly partitioned?: boolean;
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

/** A cookie of `Cookie`, or of `Set-Cookie` with its attributes */
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
  readonly #partitioned: boolean;

  /**
   * A cookie with its attributes (by default `Path=/`, `HttpOnly` and
   * `SameSite=Lax`): a name, a value or an attribute that could add attributes
   * to `Set-Cookie` throws a `TypeError`, and so does an init that is not an
   * object. What reading it throws (e.g. a revoked proxy) is formatted (see
   * `formatting()`).
   */
  public constructor(init: ICookie) {
    // Each attribute is read once (e.g. by a getter), and its value converted
    // once when it is not a string (see `stringOf()`): the values checked are
    // the ones kept, and so is the copy of the date (whose methods could tell
    // another time than its own, e.g. of a subclass)
    const checked = formatting(() =>
      Cookie.#read(objectOf(init, "init") as ICookie),
    );
    const refusal = Cookie.#refusal(checked);
    if (refusal !== null) {
      throw formatStack(new TypeError(refusal));
    }

    this.#key = checked.key;
    this.#value = checked.value;
    this.#max_age = checked.max_age;
    this.#domain = checked.domain;
    this.#path = checked.path;
    this.#secure = checked.secure;
    this.#http_only = checked.http_only;
    this.#same_site = checked.same_site;
    this.#partitioned = checked.partitioned;
    this.#expires = checked.expires;
  }

  /**
   * The attributes of an init, each read once, with their defaults, the
   * strings converted once (see `stringOf()`) and the date copied (see
   * `#copy()`)
   */
  static #read({
    key,
    value,
    expires = null,
    max_age = null,
    domain = null,
    path = "/",
    secure = false,
    http_only = true,
    same_site = "Lax",
    partitioned = false,
  }: ICookie): Required<ICookie> & {
    readonly expires: Date | null;
    readonly max_age: number | null;
  } {
    return {
      key: stringOf(key),
      value: stringOf(value),
      expires: Cookie.#copy(expires),
      max_age,
      domain: domain === null ? null : stringOf(domain),
      path: path === null ? null : stringOf(path),
      same_site,
      secure: Boolean(secure),
      http_only: Boolean(http_only),
      partitioned: Boolean(partitioned),
    };
  }

  /**
   * The copy of the `Expires` of a cookie: a `Date` (also of a subclass) by
   * its time, which the engine reads (see `timeOf()`), anything else `null`.
   * A proxy of a `Date`, which has no time of its own, is refused with a
   * `TypeError`. Called inside the boundary of the constructor (see
   * `formatting()`), which formats what checking it throws (e.g. of a revoked
   * proxy).
   */
  static #copy(expires: unknown): Date | null {
    if (!(expires instanceof Date)) {
      return null;
    }
    const time = timeOf(expires);
    if (time === null) {
      throw formatStack(new TypeError("The Expires is not a Date"));
    }
    return new Date(time);
  }

  /**
   * Why a cookie is invalid (see the constructor), `null` when it is valid:
   * a refused value is described without converting it (see `described()`)
   */
  static #refusal({
    key,
    value,
    expires = null,
    max_age = null,
    domain = null,
    path = "/",
    same_site = "Lax",
  }: ICookie): string | null {
    // An invalid name or attribute could add attributes to `Set-Cookie`
    if (!token.test(key)) {
      return `Invalid cookie name: ${key}`;
    } else if (!cookieValue.test(value)) {
      return "Invalid cookie value";
    } else if (max_age !== null && !Number.isSafeInteger(max_age)) {
      return `Invalid cookie Max-Age: ${described(max_age)}`;
    } else if (expires instanceof Date && Number.isNaN(expires.getTime())) {
      return "Invalid cookie Expires";
    } else if (domain !== null && !domainValue.test(domain)) {
      return `Invalid cookie Domain: ${domain}`;
    } else if (path !== null && !attributeValue.test(path)) {
      return `Invalid cookie Path: ${path}`;
    } else if (!sameSite.has(same_site)) {
      return `Invalid cookie SameSite: ${described(same_site)}`;
    }
    return null;
  }

  /** The name of the cookie */
  public get key(): string {
    return this.#key;
  }

  /** The value of the cookie */
  public get value(): string {
    return this.#value;
  }

  /** When the cookie expires (a copy), or `null` */
  public get expires(): Date | null {
    return this.#expires ? new Date(this.#expires) : null;
  }

  /** The lifetime in seconds, or `null` */
  public get max_age(): number | null {
    return this.#max_age;
  }

  /** The `Domain` attribute, or `null` (always for a `__Host-` cookie) */
  public get domain(): string | null {
    return this.key.startsWith("__Host-") ? null : this.#domain;
  }

  /** The `Path` attribute, or `null` (always `/` for a `__Host-` cookie) */
  public get path(): string | null {
    return this.key.startsWith("__Host-") ? "/" : this.#path;
  }

  /**
   * Whether the cookie has `Secure`: also implied by the `__Secure-` and
   * `__Host-` prefixes, `SameSite=None` and `Partitioned`
   */
  public get secure(): boolean {
    return (
      this.key.startsWith("__Secure-") ||
      this.key.startsWith("__Host-") ||
      this.same_site === "None" ||
      this.#partitioned ||
      this.#secure
    );
  }

  /** Whether the cookie has `HttpOnly` */
  public get http_only(): boolean {
    return this.#http_only;
  }

  /** The `SameSite` attribute */
  public get same_site(): "Lax" | "None" | "Strict" {
    return this.#same_site;
  }

  /** Whether the cookie has `Partitioned` */
  public get partitioned(): boolean {
    return this.#partitioned;
  }

  /**
   * The value of a `Set-Cookie` field: `name=value` and the attributes
   * (`Max-Age` instead of `Expires` when both are set)
   */
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
    output += this.partitioned ? "; Partitioned" : "";
    return output;
  }

  /**
   * The valid cookies of a `Cookie` header (`name=value` pairs, separated by
   * `;`), with the double quotes of their values removed: the first cookie of a
   * name wins, and invalid ones are skipped. An input that is neither a
   * string nor `undefined` throws a `TypeError`.
   */
  public static fromString(input?: string): Cookie[] {
    checkFieldValue(input);
    if (typeof input !== "string") {
      return [];
    }

    const output: Cookie[] = [];
    // The names of the cookies found so far: linear in the number of cookies
    const names = new Set<string>();

    for (const pair of input.split(";")) {
      // The value may contain `=` (e.g. base64)
      const index = pair.indexOf("=");
      const key = pair.slice(0, Math.max(index, 0)).trim();
      const raw = pair.slice(index + 1).trim();
      const value =
        raw.length >= 2 && raw.startsWith(`"`) && raw.endsWith(`"`)
          ? raw.slice(1, -1)
          : raw;

      // An empty value is a value (RFC 6265, section 4.1.1)
      if (index > 0 && !names.has(key)) {
        // Checked first: an invalid cookie (e.g. of a client) is skipped,
        // and creates no error, whose stack would be formatted (see
        // `formatStack()`)
        const init = { key, value };
        if (Cookie.#refusal(init) === null) {
          output.push(new Cookie(init));
          names.add(key);
        }
      }
    }

    return output;
  }
}

export default Cookie;
