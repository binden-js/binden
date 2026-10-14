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
  /**
   * Headers that the default error handler sends with the error (e.g.
   * `Allow`, `Retry-After` or `WWW-Authenticate`), but none of the framing,
   * the representation or the connection
   */
  headers?: Readonly<Record<string, string | readonly string[]>> | undefined;
}

/** The headers that the reply of an error sets itself */
const forbidden: ReadonlySet<string> = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "content-range",
  "content-type",
  "transfer-encoding",
]);

/** A header name: an HTTP token (RFC 9110, section 5.1) */
const token = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

/** A header value: no control characters but HTAB (RFC 9110, section 5.5) */
const fieldValue = /^[\t\x20-\x7e\x80-\xff]*$/u;

/** A frozen copy of valid headers (a `TypeError` otherwise) */
function copyHeaders(
  headers: unknown,
): Readonly<Record<string, string | readonly string[]>> {
  if (
    typeof headers !== "object" ||
    headers === null ||
    Array.isArray(headers)
  ) {
    throw new TypeError("`headers` is not an object");
  }
  const copy: [string, string | readonly string[]][] = [];
  const names = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!token.test(name)) {
      throw new TypeError(`Invalid header name: ${name}`);
    } else if (forbidden.has(lower)) {
      throw new TypeError(`The \`${name}\` header cannot be set by an error`);
    } else if (names.has(lower)) {
      throw new TypeError(`Duplicate header: ${name}`);
    }
    const values: unknown[] = Array.isArray(value) ? value : [value];
    if (
      !values.every(
        (item): item is string =>
          typeof item === "string" && fieldValue.test(item),
      )
    ) {
      throw new TypeError(`Invalid value of the \`${name}\` header`);
    }
    names.add(lower);
    copy.push([
      name,
      Array.isArray(value) ? Object.freeze([...values]) : (value as string),
    ]);
  }
  return Object.freeze(Object.fromEntries(copy));
}

/** An HTTP error: its status code (400 to 599) is the status of the reply */
export class BindenError extends Error {
  readonly #code: string | null;
  readonly #headers: Readonly<Record<string, string | readonly string[]>>;
  readonly #expose: boolean;
  readonly #json: Record<string, unknown> | null;
  readonly #status: number;

  /**
   * An error of an HTTP status (400 to 599, a `RangeError` otherwise) whose
   * reply the options describe: invalid options (e.g. a forbidden header) throw
   * a `TypeError`
   */
  public constructor(
    status: number,
    {
      message = STATUS_CODES[status],
      expose = false,
      json,
      cause,
      code,
      headers = {},
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
    const copy = copyHeaders(headers);

    if (typeof cause === "undefined") {
      super(message);
    } else {
      super(message, { cause });
    }

    this.name = "BindenError";
    this.#code = code ?? null;
    this.#headers = copy;
    this.#expose = Boolean(expose);
    this.#json = json ?? null;
    this.#status = status;
  }

  /** The machine-readable reason of the error, if any */
  public get code(): string | null {
    return this.#code;
  }

  /** The headers that the default error handler sends with the error */
  public get headers(): Readonly<Record<string, string | readonly string[]>> {
    return this.#headers;
  }

  /**
   * Whether the default error handler sends `json` or the message as the body
   */
  public get expose(): boolean {
    return this.#expose;
  }

  /** The status code of the reply: 400 to 599 */
  public get status(): number {
    return this.#status;
  }

  /** The JSON body sent when `expose` is `true` (a shallow copy), or `null` */
  public get json(): Record<string, unknown> | null {
    return this.#json ? { ...this.#json } : null;
  }
}
