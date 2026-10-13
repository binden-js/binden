import { parseHttpDate } from "./http-date.js";

export interface IIfModifiedSince {
  readonly date: Date;
}

export class IfModifiedSince implements IIfModifiedSince {
  readonly #date: Date;

  public constructor({ date }: IIfModifiedSince) {
    this.#date = new Date(date);
  }

  public get date(): Date {
    return new Date(this.#date);
  }

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
