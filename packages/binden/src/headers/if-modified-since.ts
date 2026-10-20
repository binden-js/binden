import { formatStack } from "../exchange.js";
import { parseHttpDate } from "./http-date.js";

/** The date of `If-Modified-Since` */
export interface IIfModifiedSince {
  /** The date (the header has a precision of one second) */
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
      throw formatStack(new TypeError("Invalid date"));
    } else if (year < 0 || year > 9999) {
      throw formatStack(new TypeError("The date is not an HTTP-date"));
    }
    this.#date = value;
  }

  /** The date (a copy) */
  public get date(): Date {
    return new Date(this.#date);
  }

  /** The date as an HTTP-date (`Sun, 06 Nov 1994 08:49:37 GMT`) */
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
