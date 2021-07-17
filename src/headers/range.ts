export interface IRange {
  readonly start?: number;
  readonly end?: number;
}

export class Range implements IRange {
  readonly #start?: number;
  readonly #end?: number;

  public constructor({ start, end }: IRange) {
    if (Number.isSafeInteger(start)) {
      this.#start = start;
    }
    if (Number.isSafeInteger(end)) {
      this.#end = Number(end);
    }
  }

  public get unit(): "bytes" {
    return "bytes";
  }

  public get start(): number | undefined {
    return this.#start;
  }

  public get end(): number | undefined {
    return this.#end;
  }

  public toString(): string {
    return `${this.unit}=${this.start ?? ""}-${this.end ?? ""}`;
  }

  public static fromString(input?: string): Range[] {
    if (!input) {
      return [];
    }

    const trimmed = input.trim();

    if (!trimmed.startsWith("bytes=")) {
      return [];
    }

    return trimmed
      .substring(6)
      .split(",")
      .map((e) => e.trim().split("-", 2))
      .map(([start, end]) => [start?.trim() ?? "", end?.trim() ?? ""])
      .map(([start, end]) => [
        !start ? NaN : Number(start),
        !end ? NaN : Number(end),
      ])
      .filter(
        ([start, end]) =>
          (Number.isSafeInteger(start) &&
            Number.isSafeInteger(end) &&
            start >= 0 &&
            start <= end) ||
          (Number.isSafeInteger(start) &&
            !Number.isSafeInteger(end) &&
            start >= 0) ||
          (!Number.isSafeInteger(start) && Number.isSafeInteger(end) && end > 0)
      )
      .map(([start, end]) => new Range({ start, end }));
  }
}

export default Range;
