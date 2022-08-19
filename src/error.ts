import { STATUS_CODES } from "node:http";

export interface IBindenErrorOptions extends ErrorOptions {
  json?: Record<string, unknown>;
  message?: string;
  expose?: boolean;
}

export class BindenError extends Error {
  readonly #expose: boolean;
  readonly #json: Record<string, unknown> | null;
  readonly #status: number;

  public constructor(
    status: number,
    {
      message = STATUS_CODES[status],
      expose = false,
      json,
      cause,
    }: IBindenErrorOptions = {}
  ) {
    if (status > 599) {
      throw new RangeError("Status code is greater than 599");
    } else if (typeof STATUS_CODES[status] === "undefined") {
      throw new TypeError("Invalid status code");
    } else if (status < 400) {
      throw new RangeError("Status code is less than 400");
    }

    super(message, cause ? { cause } : {});

    this.name = "BindenError";
    this.#expose = Boolean(expose);
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
