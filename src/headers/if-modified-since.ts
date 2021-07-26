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

  public static fromString(input?: string): IfModifiedSince | null {
    if (!input) {
      return null;
    }

    const date = new Date(input.trim());

    return isNaN(date.getTime()) ? null : new IfModifiedSince({ date });
  }
}

export default IfModifiedSince;
