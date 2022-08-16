import { Range, IRange } from "./range.js";

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
    } else if (size !== "*" && size <= 0) {
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

  public static fromString(input?: string): [] | [ContentRange] {
    if (typeof input === "undefined") {
      return [];
    }

    const trimmed = input.trim();

    if (!trimmed.startsWith("bytes ")) {
      return [];
    }

    const [rawRange, rawSize] = trimmed
      .substring(6)
      .split("/")
      .map((e) => e.trim())
      .filter((e) => e);

    if (rawRange === "*") {
      try {
        return [new ContentRange({ size: Number(rawSize) })];
      } catch {
        return [];
      }
    }

    const [start, end] = rawRange
      .split("-")
      .map((e) => e.trim())
      .filter((e) => e)
      .map((e) => Number(e));

    try {
      const size = rawSize === "*" ? rawSize : Number(rawSize);
      return [new ContentRange({ start, end, size })];
    } catch {
      return [];
    }
  }
}

export default ContentRange;
