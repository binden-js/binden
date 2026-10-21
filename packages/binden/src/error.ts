import { formatting, objectOf } from "./formatting.js";
import { STATUS_CODES } from "node:http";
import { formatStack } from "./exchange.js";

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

/**
 * The values of an array, each read once by its index (an iterator of its
 * own, e.g. of a subclass, could give others than those checked)
 */
function valuesOf(value: readonly unknown[]): unknown[] {
  const { length } = value;
  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    values.push(value[index]);
  }
  return values;
}

/**
 * A frozen copy of valid headers (a `TypeError` otherwise), each value read
 * once: the values checked are the ones kept
 */
function copyHeaders(
  headers: unknown,
): Readonly<Record<string, string | readonly string[]>> {
  if (
    typeof headers !== "object" ||
    headers === null ||
    Array.isArray(headers)
  ) {
    throw formatStack(new TypeError("`headers` is not an object"));
  }
  const copy: [string, string | readonly string[]][] = [];
  const names = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!token.test(name)) {
      throw formatStack(new TypeError(`Invalid header name: ${name}`));
    } else if (forbidden.has(lower)) {
      throw formatStack(
        new TypeError(`The \`${name}\` header cannot be set by an error`),
      );
    } else if (names.has(lower)) {
      throw formatStack(new TypeError(`Duplicate header: ${name}`));
    }
    const list = Array.isArray(value);
    const values = list ? valuesOf(value) : [value];
    if (
      !values.every(
        (item): item is string =>
          typeof item === "string" && fieldValue.test(item),
      )
    ) {
      throw formatStack(
        new TypeError(`Invalid value of the \`${name}\` header`),
      );
    }
    names.add(lower);
    copy.push([name, list ? Object.freeze(values) : (value as string)]);
  }
  return Object.freeze(Object.fromEntries(copy));
}

/** The options of a `BindenError`, read once and checked */
interface IChecked {
  readonly message: string | undefined;
  readonly expose: boolean;
  readonly json: Record<string, unknown> | undefined;
  readonly cause: unknown;
  readonly code: string | undefined;
  readonly headers: Readonly<Record<string, string | readonly string[]>>;
}

/** Whether a value is a plain object (of `Object`, or without a prototype) */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * An HTTP error: its status code (400 to 599) is the status of the reply. Its
 * stack is formatted in its constructor, unless it is an instance of a
 * subclass, which keeps the header that its own constructor gives it
 */
export class BindenError extends Error {
  readonly #code: string | null;
  readonly #headers: Readonly<Record<string, string | readonly string[]>>;
  readonly #expose: boolean;
  readonly #json: Record<string, unknown> | null;
  readonly #status: number;

  /**
   * An error of an HTTP status (400 to 599, a `RangeError` otherwise) whose
   * reply the options describe: invalid options (e.g. a forbidden header, an
   * `expose` that is not a boolean, a `json` that is not a plain object or a
   * `message` that is not a string) throw a `TypeError`, and so do options
   * that are not an object. The status is checked first (the default message
   * is the one of the status), and each option is read once (`json` is
   * copied then): what reading them throws (e.g. a revoked proxy, or a getter
   * of `json`) is formatted (see `formatting()`).
   */
  public constructor(status: number, options?: IBindenErrorOptions) {
    const checked = BindenError.#checked(status, options);

    if (typeof checked.cause === "undefined") {
      super(checked.message);
    } else {
      super(checked.message, { cause: checked.cause });
    }

    this.name = "BindenError";
    this.#code = checked.code ?? null;
    this.#headers = checked.headers;
    this.#expose = checked.expose;
    this.#json = checked.json ?? null;
    this.#status = status;
    if (new.target === BindenError) {
      // Formatted at once (see `formatStack()`), whoever creates it (binden,
      // its packages or the application): kept, it retains nothing of its
      // frames (e.g. the request whose URL it refuses). Not an instance of a
      // subclass, whose own constructor may still give its stack its header
      // (e.g. its `name`), once this one has returned
      formatStack(this);
    }
  }

  /**
   * The checked options of an error of the status (see the constructor):
   * the status first, never converted (e.g. by the lookup of its default
   * message), then the options, each read once
   */
  static #checked(status: unknown, options: unknown): IChecked {
    if (typeof status !== "number" || !Number.isInteger(status)) {
      throw formatStack(new TypeError("Invalid status code"));
    } else if (status > 599) {
      throw formatStack(new RangeError("Status code is greater than 599"));
    } else if (status < 400) {
      throw formatStack(new RangeError("Status code is less than 400"));
    }
    return formatting(() => {
      const {
        message = STATUS_CODES[status],
        expose = false,
        json,
        cause,
        code,
        headers = {},
      } = objectOf(options, "options", true) as IBindenErrorOptions;
      if (typeof code !== "undefined" && typeof code !== "string") {
        throw formatStack(new TypeError("`code` is not a string"));
      } else if (typeof expose !== "boolean") {
        throw formatStack(new TypeError("`expose` is not a boolean"));
      } else if (typeof json !== "undefined" && !isPlainObject(json)) {
        // E.g. an array or a string, which `json` is not sent as
        throw formatStack(new TypeError("`json` is not a plain object"));
      } else if (
        typeof message !== "undefined" &&
        typeof message !== "string"
      ) {
        throw formatStack(new TypeError("`message` is not a string"));
      }
      return {
        message,
        expose,
        // Copied once (e.g. its getters run here): the getter of `json` copies
        // the copy, and runs no code of the application
        json: typeof json === "undefined" ? json : { ...json },
        cause,
        code,
        headers: copyHeaders(headers),
      };
    });
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

  /**
   * The JSON body sent when `expose` is `true`, or `null`: a shallow copy of
   * the one that the constructor has copied from its `json`
   */
  public get json(): Record<string, unknown> | null {
    return this.#json ? { ...this.#json } : null;
  }
}
