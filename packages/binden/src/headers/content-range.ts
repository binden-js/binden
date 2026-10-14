import { Range, type IRange } from "./range.js";

export interface IContentRange extends IRange {
  readonly size: number | "*";
}

export class ContentRange extends Range implements IContentRange {
  readonly #size: number | "*";

  public constructor({ start = null, end = null, size }: IContentRange) {
    if (typeof start === "number" && !Number.isSafeInteger(start)) {
      throw new TypeError("`start` is not an integer");
    } else if (typeof start === "number" && start < 0) {
      throw new TypeError("`start` is less than zero");
    } else if (typeof end === "number" && !Number.isSafeInteger(end)) {
      throw new TypeError("`end` is not an integer");
    } else if (typeof end === "number" && end < 0) {
      throw new TypeError("`end` is less than zero");
    } else if (size !== "*" && !Number.isSafeInteger(size)) {
      throw new TypeError("`size` is not an integer");
    } else if (size !== "*" && size < 0) {
      throw new TypeError("`size` is less than zero");
    } else if (typeof end === "number" && size !== "*" && end >= size) {
      throw new TypeError("`end` is greater than `size`");
    } else if (typeof start !== "number" && typeof end === "number") {
      throw new TypeError("`start` is missing");
    } else if (typeof start === "number" && typeof end !== "number") {
      throw new TypeError("`end` is missing");
    } else if (
      typeof start === "number" &&
      typeof end === "number" &&
      end < start
    ) {
      throw new TypeError("`end` is less than `start`");
    }

    super({ start, end });
    this.#size = size;
  }

  public get size(): number | "*" {
    return this.#size;
  }

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
