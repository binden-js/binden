import { STATUS_CODES } from "node:http";

/** The options of a `BindenError` */
export interface IBindenErrorOptions extends ErrorOptions {
  /** Sent as the body when `expose` is `true` (as JSON, instead of `message`) */
  json?: Record<string, unknown> | undefined;
  /** Sent as the body when `expose` is `true` and there is no `json` */
  message?: string | undefined;
  /** Whether the default error handler sends `json` or `message` (`false`) */
  expose?: boolean | undefined;
  /** A machine-readable reason (e.g. `deadline`), not sent to the client */
  code?: string | undefined;
}

/** An HTTP error: its status code (400 to 599) is the status of the reply */
export class BindenError extends Error {
  readonly #code: string | null;
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
      code,
    }: IBindenErrorOptions = {},
  ) {
    if (!Number.isInteger(status)) {
      throw new TypeError("Invalid status code");
    } else if (status > 599) {
      throw new RangeError("Status code is greater than 599");
    } else if (status < 400) {
      throw new RangeError("Status code is less than 400");
    } else if (typeof code !== "undefined" && typeof code !== "string") {
      throw new TypeError("`code` is not a string");
    }

    if (typeof cause === "undefined") {
      super(message);
    } else {
      super(message, { cause });
    }

    this.name = "BindenError";
    this.#code = code ?? null;
    this.#expose = Boolean(expose);
    this.#json = json ?? null;
    this.#status = status;
  }

  /** The machine-readable reason of the error, if any */
  public get code(): string | null {
    return this.#code;
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
