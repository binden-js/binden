import { parseHttpDate } from "./http-date.js";

/** The date of `If-Modified-Since` */
export interface IIfModifiedSince {
  readonly date: Date;
}

/** The `If-Modified-Since` header (RFC 9110, section 13.1.3) */
export class IfModifiedSince implements IIfModifiedSince {
  readonly #date: Date;

  /**
   * A date that is an HTTP-date (from the year 0 to 9999): an invalid one
   * throws a `TypeError`
   */
  public constructor({ date }: IIfModifiedSince) {
    const value = new Date(date);
    const year = value.getUTCFullYear();
    if (Number.isNaN(year)) {
      throw new TypeError("Invalid date");
    } else if (year < 0 || year > 9999) {
      throw new TypeError("The date is not an HTTP-date");
    }
    this.#date = value;
  }

  public get date(): Date {
    return new Date(this.#date);
  }

  public toString(): string {
    return this.#date.toUTCString();
  }

  /** An HTTP-date, or `null` (a recipient ignores any other value) */
  public static fromString(input?: string): IfModifiedSince | null {
    const date = parseHttpDate(input?.trim() ?? "");
    return date ? new IfModifiedSince({ date }) : null;
  }
}

export default IfModifiedSince;
