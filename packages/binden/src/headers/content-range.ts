import { type IRange, Range } from "./range.js";
import { formatStack } from "../exchange.js";

/** The range of `Content-Range` (none when unsatisfied) and the size of the content */
export interface IContentRange extends IRange {
  /** The size of the whole content in bytes, or `*` when it is unknown */
  readonly size: number | "*";
}

/** The `Content-Range` header (RFC 9110, section 14.4) */
export class ContentRange extends Range implements IContentRange {
  readonly #size: number | "*";

  /**
   * The range of `start` to `end` (non-negative integers, `end` within `size`),
   * or neither of them (an unsatisfied range, which needs a numeric `size`),
   * and the size of the content: anything else throws a `TypeError`
   */
  public constructor({ start = null, end = null, size }: IContentRange) {
    const refusal = ContentRange.#refusal({ start, end, size });
    if (refusal !== null) {
      throw formatStack(new TypeError(refusal));
    }

    super({ start, end });
    this.#size = size;
  }

  /** The size of the whole content in bytes, or `*` */
  public get size(): number | "*" {
    return this.#size;
  }

  /**
   * The field value: `bytes start-end/size`, or `bytes *\/size` for an
   * unsatisfied range
   */
  public toString(): string {
    return typeof this.start === "number" && typeof this.end === "number"
      ? `${this.unit} ${this.start}-${this.end}/${this.size}`
      : `${this.unit} */${this.size}`;
  }

  /**
   * A range (`bytes 0-9/100`, or with an unknown size `*`) or an unsatisfied
   * range (an asterisk and the size) of RFC 9110 (section 14.4), with decimal
   * positions only: anything else is not a content range
   */
  public static fromString(input?: string): [] | [ContentRange] {
    const {
      first,
      last,
      size = "",
      length,
    } = /^[ \t]*bytes (?:(?<first>\d+)-(?<last>\d+)\/(?<size>\d+|\*)|\*\/(?<length>\d+))[ \t]*$/iu.exec(
      input ?? "",
    )?.groups ?? {};

    const init: IContentRange | null =
      typeof length === "string"
        ? { size: Number(length) }
        : typeof first === "string" && typeof last === "string"
          ? {
              start: Number(first),
              end: Number(last),
              size: size === "*" ? size : Number(size),
            }
          : null;
    // Checked first: an invalid range (e.g. `bytes 1-0/5`, or a position that
    // is not a safe integer) creates no error, whose stack would be formatted
    // (see `formatStack()`). A valid one is a valid `Range` as well.
    return init !== null && ContentRange.#refusal(init) === null
      ? [new ContentRange(init)]
      : [];
  }

  /**
   * Why a content range is invalid (see the constructor), `null` when it is
   * valid (and so is its range)
   */
  static #refusal({
    start = null,
    end = null,
    size,
  }: IContentRange): string | null {
    if (typeof start === "number" && !Number.isSafeInteger(start)) {
      return "`start` is not an integer";
    } else if (typeof start === "number" && start < 0) {
      return "`start` is less than zero";
    } else if (typeof end === "number" && !Number.isSafeInteger(end)) {
      return "`end` is not an integer";
    } else if (typeof end === "number" && end < 0) {
      return "`end` is less than zero";
    } else if (size !== "*" && !Number.isSafeInteger(size)) {
      return "`size` is not an integer";
    } else if (size !== "*" && size < 0) {
      return "`size` is less than zero";
    } else if (typeof end === "number" && size !== "*" && end >= size) {
      return "`end` is greater than `size`";
    } else if (start === null && end === null && size === "*") {
      // `bytes *\/*` is not a content range (RFC 9110, section 14.4)
      return "An unsatisfied range needs a `size`";
    } else if (typeof start !== "number" && typeof end === "number") {
      return "`start` is missing";
    } else if (typeof start === "number" && typeof end !== "number") {
      return "`end` is missing";
    } else if (
      typeof start === "number" &&
      typeof end === "number" &&
      end < start
    ) {
      return "`end` is less than `start`";
    }
    return null;
  }
}

export default ContentRange;
