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

  public static fromString(input?: string): Range[] {
    if (typeof input !== "string" || !input) {
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
      .map(([start, end]) => [
        start.trim(),
        (end as string | undefined)?.trim() ?? "",
      ])
      .map(([start, end]) => [
        start ? Number(start) : NaN,
        end ? Number(end) : NaN,
      ])
      .filter(
        ([start, end]) =>
          (!isNaN(start) && !isNaN(end) && start >= 0 && start <= end) ||
          (!isNaN(start) && isNaN(end) && start >= 0) ||
          (isNaN(start) && !isNaN(end) && end > 0)
      )
      .map(([start, end]) => new Range({ start, end }));
  }
}

export default Range;
