import { BindenAbortError, formatStack } from "./exchange.js";
import {
  type ILogger,
  Logger,
  serializers as defaultSerializers,
} from "@binden/logger";
import { formatting, objectOf } from "./formatting.js";
import { BindenError } from "./error.js";
import { Context } from "./context.js";
import { constants } from "node:os";
import { isProxy } from "node:util/types";
import { isStatus } from "./status.js";
import { property } from "./property.js";

/** Where the framework has met an error */
export type ILocation =
  "cleanup" | "error_handler" | "middleware" | "send" | "shutdown";

/** The error classes that a snapshot names (a subclass gets the name of its parent) */
const errorTypes: ReadonlyMap<object, string> = new Map<object, string>([
  [BindenError.prototype, "BindenError"],
  [BindenAbortError.prototype, "BindenAbortError"],
  [AggregateError.prototype, "AggregateError"],
  [EvalError.prototype, "EvalError"],
  [RangeError.prototype, "RangeError"],
  [ReferenceError.prototype, "ReferenceError"],
  [SyntaxError.prototype, "SyntaxError"],
  [TypeError.prototype, "TypeError"],
  [URIError.prototype, "URIError"],
  [Error.prototype, "Error"],
]);

/**
 * The codes that a snapshot keeps: system errors, some stream and HTTP ones,
 * and the codes of the framework
 */
const errorCodes: ReadonlySet<string> = new Set([
  ...Object.keys(constants.errno),
  "ERR_HTTP_CONTENT_LENGTH_MISMATCH",
  "ERR_HTTP_HEADERS_SENT",
  "ERR_HTTP_INVALID_HEADER_VALUE",
  "ERR_INVALID_ARG_TYPE",
  "ERR_INVALID_CHAR",
  "ERR_STREAM_ALREADY_FINISHED",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_PREMATURE_CLOSE",
  "ERR_STREAM_WRITE_AFTER_END",
  "aborted",
  "deadline",
]);

/** The name of the nearest known error class of a value (never one it defines itself) */
function typeOf(value: unknown): string {
  if (value === null) {
    return "null";
  } else if (typeof value !== "object" && typeof value !== "function") {
    return typeof value;
  }
  try {
    // Bounded: a proxy may return itself, or another proxy every time
    const seen = new Set<object>();
    let prototype = Object.getPrototypeOf(value) as object | null;
    while (prototype !== null && !seen.has(prototype) && seen.size < 64) {
      seen.add(prototype);
      const type = errorTypes.get(prototype);
      if (typeof type === "string") {
        return type;
      }
      prototype = Object.getPrototypeOf(prototype) as object | null;
    }
  } catch {
    // A proxy that refuses to tell its prototype
  }
  return typeof value;
}

/**
 * Whether a value is an instance of a class (e.g. a request of binden), read
 * without running code of the application: neither the value nor an object
 * of its prototype chain may be a proxy, whose traps are code of the
 * application (e.g. a `getPrototypeOf` that throws, or one that lies), and
 * which has none of the private fields of what it proxies. For binden only.
 *
 * @internal
 */
export function isInstance<T>(
  value: unknown,
  type: { readonly prototype: T },
): value is T {
  const { prototype } = type;
  let current = value;
  while (typeof current === "object" && current !== null && !isProxy(current)) {
    current = Object.getPrototypeOf(current);
    if (current === prototype) {
      return true;
    }
  }
  return false;
}

/** The options of a snapshot */
export interface ISnapshotOptions {
  /** Where in the framework the error has occurred */
  readonly location: ILocation;
  /** The id of the request, if any */
  readonly request_id?: string | undefined;
  /** Whether the message, the stack, the cause and any `code` are added */
  readonly details: boolean;
  /** The status of the reply, instead of the one of the error */
  readonly status?: number | undefined;
}

/**
 * What the framework logs of an error: an allowlist of details read without
 * trusting the value (whatever is thrown), so that the input of a request
 * (which an error message, its stack or its cause may quote) stays out of
 * the logs unless `details` is `true`
 */
export function snapshot(
  error: unknown,
  { location, request_id, details, status }: ISnapshotOptions,
  depth = 0,
): Record<string, unknown> {
  const own = property(error, "status");
  const code = property(error, "code");
  const kept = typeof code === "string" && (details || errorCodes.has(code));
  const message = details ? property(error, "message") : null;
  const stack = details ? property(error, "stack") : null;
  const cause = details && depth < 3 ? property(error, "cause") : null;
  return {
    type: typeOf(error),
    ...(kept ? { code } : {}),
    ...(typeof status === "number"
      ? { status }
      : isStatus(own)
        ? { status: own }
        : {}),
    ...(depth === 0
      ? {
          location,
          ...(typeof request_id === "string" ? { request_id } : {}),
        }
      : {}),
    ...(typeof message === "string" ? { message } : {}),
    ...(typeof stack === "string" ? { stack } : {}),
    ...(cause === null || typeof cause === "undefined"
      ? {}
      : { cause: snapshot(cause, { location, details }, depth + 1) }),
  };
}

type ILevel = "debug" | "error" | "fatal" | "info" | "trace" | "warn";

const levels: readonly ILevel[] = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
];

/**
 * Whether a value has the methods of a logger. What reading them throws (e.g.
 * a getter of the application, or a revoked proxy) means `false`, unless
 * `strict`: then it is thrown as it is (to the boundary of the caller, see
 * `formatting()`), as when an option of the application is checked.
 */
export function isLogger(value: unknown, strict = false): value is ILogger {
  return (
    typeof value === "object" &&
    value !== null &&
    [...levels, "child" as const].every(
      (method) =>
        typeof (strict
          ? (Reflect.get(value, method) as unknown)
          : property(value, method)) === "function",
    )
  );
}

/** Does nothing (e.g. with a rejection that is observed) */
function ignore(): void {
  // Observed
}

/**
 * A logger whose calls never fail: a method (or `child()`) that throws is
 * ignored, and a rejected promise that it returns is observed. A `child()`
 * that fails (or that does not return a logger, e.g. a promise) gives the
 * logger itself. Its methods are its own, bound to it: none depends on its
 * receiver, so that an object derived from it (e.g. with `Object.create()`,
 * to override one of them) or a proxy of it logs through its logger.
 */
class SafeLogger implements ILogger {
  readonly #logger: ILogger;

  /** Logs at `fatal` */
  public readonly fatal = (
    message: string,
    extra?: Record<string, unknown>,
  ): void => {
    this.#call("fatal", message, extra);
  };

  /** Logs at `error` */
  public readonly error = (
    message: string,
    extra?: Record<string, unknown>,
  ): void => {
    this.#call("error", message, extra);
  };

  /** Logs at `warn` */
  public readonly warn = (
    message: string,
    extra?: Record<string, unknown>,
  ): void => {
    this.#call("warn", message, extra);
  };

  /** Logs at `info` */
  public readonly info = (
    message: string,
    extra?: Record<string, unknown>,
  ): void => {
    this.#call("info", message, extra);
  };

  /** Logs at `debug` */
  public readonly debug = (
    message: string,
    extra?: Record<string, unknown>,
  ): void => {
    this.#call("debug", message, extra);
  };

  /** Logs at `trace` */
  public readonly trace = (
    message: string,
    extra?: Record<string, unknown>,
  ): void => {
    this.#call("trace", message, extra);
  };

  /** A child of the logger (the logger itself when it fails) */
  public readonly child = (bindings: Record<string, unknown>): ILogger => {
    try {
      const child: unknown = this.#logger.child(bindings);
      if (typeof property(child, "then") === "function") {
        // Not a logger (e.g. of an `async` function): its rejection is
        // observed, and the logger itself is used
        Promise.resolve(child).catch(ignore);
      } else if (isLogger(child)) {
        return SafeLogger.isSafe(child) ? child : new SafeLogger(child);
      }
    } catch {
      // The logger itself
    }
    return this;
  };

  public constructor(logger: ILogger) {
    this.#logger = logger;
  }

  /**
   * Whether a value is a logger that this class has made, by its private
   * brand: no trap of a proxy runs, and an object derived from one (or a
   * proxy of one) is not
   */
  public static isSafe(value: unknown): value is SafeLogger {
    return typeof value === "object" && value !== null && #logger in value;
  }

  #call(level: ILevel, message: string, extra?: Record<string, unknown>): void {
    try {
      const result: unknown =
        typeof extra === "undefined"
          ? this.#logger[level](message)
          : this.#logger[level](message, extra);
      if (typeof property(result, "then") === "function") {
        Promise.resolve(result).catch(ignore);
      }
    } catch {
      // Nothing else to report it to
    }
  }
}

/**
 * A logger whose calls never fail (see `SafeLogger`): one that binden has
 * made is used as it is, anything else (also an object derived from one) is
 * wrapped
 */
export function safe(logger: ILogger): ILogger {
  return SafeLogger.isSafe(logger) ? logger : new SafeLogger(logger);
}

/**
 * The serializers of binden (see `createSerializers()`): a type alias, so
 * that they can be given as they are to the `serializers` of a logger
 */
export type IBindenSerializers = Record<
  "context" | "err" | "error" | "request" | "response",
  (value: unknown) => Record<string, unknown>
> &
  Record<"body", (body?: unknown) => string>;

/**
 * The serializers of a logger of binden: those of `@binden/logger` (an
 * allowlist of the details of a request and a response), an `error` (and
 * `err`, the key of `pino`) that names the errors of binden, a redacted
 * `body` and a `context` without the fields that the application sets on it.
 * With `error_details`, an `error` adds its message, its stack, its cause and
 * any `code`, which may quote the input of a request (as `log_error_details`
 * does for the framework logs). Options that are not an object throw a
 * `TypeError`, and what reading them throws (e.g. a revoked proxy) is
 * formatted (see `formatting()`).
 */
export function createSerializers(options?: {
  readonly error_details?: boolean | undefined;
}): IBindenSerializers {
  const error_details = formatting(() => {
    const { error_details: details = false } = objectOf(
      options,
      "options",
      true,
    ) as { readonly error_details?: unknown };
    return details;
  });
  if (typeof error_details !== "boolean") {
    throw formatStack(new TypeError("`error_details` is not a boolean"));
  }
  const error = (value: unknown): Record<string, unknown> => {
    const logged = snapshot(value, {
      location: "middleware",
      details: error_details,
    });
    // Where the framework met it: not known here
    delete logged.location;
    return logged;
  };
  return {
    ...defaultSerializers,
    error,
    err: error,
    body: (): string => "[Redacted]",
    context: (input: unknown): Record<string, unknown> => {
      if (!isInstance(input, Context)) {
        return { type: typeOf(input) };
      }
      // What its getters throw (e.g. of a subclass) is formatted
      return formatting(() => ({
        id: input.id,
        request: defaultSerializers.request(input.request),
        response: defaultSerializers.response(input.response),
      }));
    },
  };
}

/** The serializers of the default logger of binden (without the details of the errors) */
export const serializers: IBindenSerializers = createSerializers();

let instance: ILogger | null = null;

/**
 * The default logger of binden, created on first use: its level is
 * `BINDEN_LOG_LEVEL` (`silent` without it)
 */
export function defaultLogger(): ILogger {
  instance ??= new Logger({ serializers });
  return instance;
}
