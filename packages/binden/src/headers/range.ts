export interface IRange {
  readonly start?: number | null;
  readonly end?: number | null;
}

export type IUnit = "bytes";

export class Range implements IRange {
  readonly #start: number | null;
  readonly #end: number | null;
  readonly #unit: IUnit;

  public constructor({ start = null, end = null }: IRange) {
    this.#unit = "bytes";
    this.#start =
      typeof start === "number" && Number.isSafeInteger(start) ? start : null;
    this.#end =
      typeof end === "number" && Number.isSafeInteger(end) ? end : null;
  }

  public get unit(): IUnit {
    return this.#unit;
  }

  public get start(): number | null {
    return this.#start;
  }

  public get end(): number | null {
    return this.#end;
  }

  public toString(): string {
    return `${this.unit}=${this.start ?? ""}-${this.end ?? ""}`;
  }

  /**
   * The byte ranges (RFC 9110, section 14.1.1): `first-pos "-" [ last-pos ]` or
   * `"-" suffix-length`, of plain digits. Spaces and tabs may surround them, and
   * an invalid range is skipped.
   */
  public static fromString(input?: string): Range[] {
    // The unit is case-insensitive (RFC 9110, section 14.1)
    const ranges =
      /^[ \t]*bytes=(?<ranges>.*)$/iu.exec(input ?? "")?.groups?.ranges ?? "";
    const output: Range[] = [];

    for (const element of ranges.split(",")) {
      const { first = "", last = "" } =
        /^[ \t]*(?<first>\d*)[ \t]*-[ \t]*(?<last>\d*)[ \t]*$/u.exec(element)
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
