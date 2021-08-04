import { STATUS_CODES } from "http";

export interface IKauaiErrorOptions {
  json?: Record<string, unknown>;
  message?: string;
  expose?: boolean;
}

export class KauaiError extends Error {
  readonly #expose: boolean;
  readonly #json: Record<string, unknown> | null;
  readonly #status: number;

  public constructor(
    status: number,
    { message = STATUS_CODES[status], expose, json }: IKauaiErrorOptions = {}
  ) {
    if (status > 599) {
      throw new RangeError("Status code is greater than 599");
    } else if (!STATUS_CODES[status]) {
      throw new TypeError("Invalid status code");
    } else if (status < 400) {
      throw new RangeError("Status code is less than 400");
    }

    super(message);

    this.name = "KauaiError";
    this.#expose = expose ? true : false;
    this.#json = json ?? null;
    this.#status = status;
  }

  public get expose(): boolean {
    return this.#expose;
  }

  public get status(): number {
    return this.#status;
  }

  public get json(): Record<string, unknown> | null {
    return this.#json ? { ...this.#json } : null;
  }
}

export default KauaiError;