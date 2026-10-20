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
    if (typeof start === "number" && !Number.isSafeInteger(start)) {
      throw formatStack(new TypeError("`start` is not an integer"));
    } else if (typeof start === "number" && start < 0) {
      throw formatStack(new TypeError("`start` is less than zero"));
    } else if (typeof end === "number" && !Number.isSafeInteger(end)) {
      throw formatStack(new TypeError("`end` is not an integer"));
    } else if (typeof end === "number" && end < 0) {
      throw formatStack(new TypeError("`end` is less than zero"));
    } else if (size !== "*" && !Number.isSafeInteger(size)) {
      throw formatStack(new TypeError("`size` is not an integer"));
    } else if (size !== "*" && size < 0) {
      throw formatStack(new TypeError("`size` is less than zero"));
    } else if (typeof end === "number" && size !== "*" && end >= size) {
      throw formatStack(new TypeError("`end` is greater than `size`"));
    } else if (start === null && end === null && size === "*") {
      // `bytes *\/*` is not a content range (RFC 9110, section 14.4)
      throw formatStack(new TypeError("An unsatisfied range needs a `size`"));
    } else if (typeof start !== "number" && typeof end === "number") {
      throw formatStack(new TypeError("`start` is missing"));
    } else if (typeof start === "number" && typeof end !== "number") {
      throw formatStack(new TypeError("`end` is missing"));
    } else if (
      typeof start === "number" &&
      typeof end === "number" &&
      end < start
    ) {
      throw formatStack(new TypeError("`end` is less than `start`"));
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

    try {
      if (typeof length === "string") {
        return [new ContentRange({ size: Number(length) })];
      } else if (typeof first === "string" && typeof last === "string") {
        return [
          new ContentRange({
            start: Number(first),
            end: Number(last),
            size: size === "*" ? size : Number(size),
          }),
        ];
      }
    } catch {
      // E.g. `bytes 1-0/5`, or a position that is not a safe integer
    }
    return [];
  }
}

export default ContentRange;
