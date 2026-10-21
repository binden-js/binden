import { checkFieldValue, trimOws } from "./list.js";
import { formatting, objectOf } from "../formatting.js";
import { formatStack } from "../exchange.js";

/** A range of `Range`: its first and last positions, either one optional */
export interface IRange {
  /**
   * The first position, or `null` (by default) for a suffix range (the last
   * `end` bytes)
   */
  readonly start?: number | null;
  /**
   * The last position (included), the length of a suffix range, or `null` (by
   * default) for the rest of the content
   */
  readonly end?: number | null;
}

/** The range units */
export type IUnit = "bytes";

/** A range of the `Range` header (RFC 9110, section 14.2) */
export class Range implements IRange {
  readonly #start: number | null;
  readonly #end: number | null;
  readonly #unit: IUnit;

  /**
   * A range of `start` to `end` (non-negative integers), from `start` to the
   * end (without `end`), or of the last `end` bytes (without `start`): anything
   * else throws a `TypeError`, and so does an init that is not an object. What
   * reading it throws (e.g. a revoked proxy) is formatted (see
   * `formatting()`).
   */
  public constructor(init: IRange) {
    // Each value is read once (e.g. by a getter): the values checked are the
    // ones kept
    const checked = formatting(() =>
      Range.#read(objectOf(init, "init") as IRange),
    );
    for (const [name, value] of [
      ["start", checked.start],
      ["end", checked.end],
    ] as const) {
      if (value !== null && !(Number.isSafeInteger(value) && value >= 0)) {
        throw formatStack(
          new TypeError(`\`${name}\` is not a non-negative integer`),
        );
      }
    }
    // Only an unsatisfied `ContentRange` has neither
    if (
      new.target === Range &&
      checked.start === null &&
      checked.end === null
    ) {
      throw formatStack(new TypeError("A range has a `start` or an `end`"));
    } else if (
      checked.start !== null &&
      checked.end !== null &&
      checked.end < checked.start
    ) {
      throw formatStack(new TypeError("`end` is less than `start`"));
    }
    this.#unit = "bytes";
    this.#start = checked.start;
    this.#end = checked.end;
  }

  /** The values of an init, each read once */
  static #read({ start = null, end = null }: IRange): {
    readonly start: number | null;
    readonly end: number | null;
  } {
    return { start, end };
  }

  /** The range unit: `bytes` */
  public get unit(): IUnit {
    return this.#unit;
  }

  /** The first position, or `null` for a suffix range */
  public get start(): number | null {
    return this.#start;
  }

  /**
   * The last position (included), the length of a suffix range, or `null` for
   * the rest of the content
   */
  public get end(): number | null {
    return this.#end;
  }

  /**
   * The range as in the header: `bytes=start-end`, either of them maybe empty
   */
  public toString(): string {
    return `${this.unit}=${this.start ?? ""}-${this.end ?? ""}`;
  }

  /**
   * The byte ranges (RFC 9110, section 14.1.1): `first-pos "-" [ last-pos ]` or
   * `"-" suffix-length`, of plain digits. Spaces and tabs may surround them, and
   * an invalid range is skipped. An input that is neither a string nor
   * `undefined` throws a `TypeError`.
   */
  public static fromString(input?: string): Range[] {
    checkFieldValue(input);
    // The unit is case-insensitive (RFC 9110, section 14.1)
    const ranges =
      /^[ \t]*bytes=(?<ranges>.*)$/iu.exec(input ?? "")?.groups?.ranges ?? "";
    const output: Range[] = [];

    for (const element of ranges.split(",")) {
      // Trimmed first: `[ \t]*` on both sides of an empty `\d*` would backtrack
      // polynomially on long runs of tabs
      const { first = "", last = "" } =
        /^(?<first>\d*)[ \t]*-[ \t]*(?<last>\d*)$/u.exec(trimOws(element))
          ?.groups ?? {};
      const start = first === "" ? null : Number(first);
      const end = last === "" ? null : Number(last);
      const valid =
        start === null
          ? end !== null
          : Number.isSafeInteger(start) && (end === null || start <= end);

      if (valid && (end === null || Number.isSafeInteger(end))) {
        output.push(new Range({ start, end }));
      }
    }

    return output;
  }
}

export default Range;
