import { checkFieldValue, timeOf } from "./list.js";
import { described, formatting, objectOf } from "../formatting.js";
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
   * A date that is an HTTP-date (from the year 0 to 9999): a `Date` (by its
   * time, which the engine reads, never its methods), or, as `new Date()`
   * reads them, a number or a string. An invalid one throws a `TypeError`,
   * and so does any other value (described without converting it, see
   * `described()`) or an init that is not an object. What reading it throws
   * (e.g. a revoked proxy) is formatted (see `formatting()`).
   */
  public constructor(init: IIfModifiedSince) {
    const value = formatting(() =>
      IfModifiedSince.#copy((objectOf(init, "init") as IIfModifiedSince).date),
    );
    const year = value.getUTCFullYear();
    if (Number.isNaN(year)) {
      throw formatStack(new TypeError("Invalid date"));
    } else if (year < 0 || year > 9999) {
      throw formatStack(new TypeError("The date is not an HTTP-date"));
    }
    this.#date = value;
  }

  /** A copy of a date: of a `Date`, a number or a string (a `TypeError` otherwise) */
  static #copy(date: unknown): Date {
    if (typeof date === "number" || typeof date === "string") {
      return new Date(date);
    }
    const time = timeOf(date);
    if (time === null) {
      throw formatStack(
        new TypeError(`The date is not a Date: ${described(date)}`),
      );
    }
    return new Date(time);
  }

  /** The date (a copy) */
  public get date(): Date {
    return new Date(this.#date);
  }

  /** The date as an HTTP-date (`Sun, 06 Nov 1994 08:49:37 GMT`) */
  public toString(): string {
    return this.#date.toUTCString();
  }

  /**
   * An HTTP-date, or `null` (a recipient ignores any other value). An input
   * that is neither a string nor `undefined` throws a `TypeError`.
   */
  public static fromString(input?: string): IfModifiedSince | null {
    checkFieldValue(input);
    const date = parseHttpDate(input?.trim() ?? "");
    return date ? new IfModifiedSince({ date }) : null;
  }
}

export default IfModifiedSince;
