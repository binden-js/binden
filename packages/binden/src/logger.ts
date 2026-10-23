import { BindenAbortError, formatStack } from "./exchange.js";
import {
  type ILogger,
  Logger,
  serializers as defaultSerializers,
} from "@binden/logger";
import { formatting, objectOf } from "./formatting.js";
import { BindenError } from "./error.js";
import { constants } from "node:os";
import { isContext } from "./brands.js";
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

/**
 * A level of the records of a logger (see `ILogger`): a method of it that
 * `record()` calls
 *
 * @internal
 */
export type ILogLevel = "debug" | "error" | "fatal" | "info" | "trace" | "warn";

const levels: readonly ILogLevel[] = [
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
 * The private paths of the loggers of binden (see `SafeLogger`), set by the
 * static block of the class: functions of this module, never properties of
 * the class, which the application reaches (the `constructor` of a logger)
 * and may replace
 */
interface IPaths {
  /** Whether a value is a logger of binden, by its private brand */
  isSafe(value: unknown): value is ILogger;
  /** Writes a record through a logger (see `record()`) */
  record(
    logger: unknown,
    level: ILogLevel,
    message: string,
    extra?: Record<string, unknown>,
  ): void;
  /** A child of a logger of binden (see `childLogger()`) */
  child(logger: ILogger, bindings: Record<string, unknown>): ILogger;
}

// eslint-disable-next-line init-declarations -- set by the static block of `SafeLogger`
let paths: IPaths;

/**
 * A logger whose calls never fail: a method (or `child()`) that throws is
 * ignored, and a rejected promise that it returns is observed. Its `child()`
 * always gives a new one: over a child that is a logger, or over the logger
 * itself when it fails (or does not return a logger, e.g. a promise). Its
 * methods are its own, bound to it: none depends on its receiver, so that an
 * object derived from it (e.g. with `Object.create()`) or a proxy of it logs
 * through its logger. Over a logger of binden, it takes the logger of that
 * one (see the constructor): one level deep at most. binden writes its own
 * records by their private paths (see `record()`), never through these
 * methods, which the application may replace.
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
  public readonly child = (bindings: Record<string, unknown>): ILogger =>
    this.#child(bindings);

  public constructor(logger: ILogger) {
    // Flat: over a logger of binden, its logger, to which it would delegate
    // anyway, so that none is ever nested deeper than one level (whatever
    // a `child()` of the application gives, e.g. an earlier `context.log`),
    // and none keeps the loggers of binden made before it
    this.#logger = SafeLogger.#isSafe(logger) ? logger.#logger : logger;
  }

  static {
    paths = {
      isSafe: (value): value is SafeLogger => SafeLogger.#isSafe(value),
      record: (logger, level, message, extra): void => {
        SafeLogger.#send(logger, level, message, extra);
      },
      child: (logger, bindings): ILogger =>
        (SafeLogger.#isSafe(logger) ? logger : new SafeLogger(logger)).#child(
          bindings,
        ),
    };
  }

  /**
   * Whether a value is a logger that this class has made, by its private
   * brand: no trap of a proxy runs, and an object derived from one (or a
   * proxy of one) is not
   */
  static #isSafe(value: unknown): value is SafeLogger {
    return typeof value === "object" && value !== null && #logger in value;
  }

  /**
   * Writes a record through a logger: a logger of binden by its private path
   * (see `#call()`), never by its methods, which the application may have
   * replaced, and anything else by its method, whose failure (also what
   * reading it throws) is ignored, and whose rejected promise is observed
   */
  static #send(
    logger: unknown,
    level: ILogLevel,
    message: string,
    extra?: Record<string, unknown>,
  ): void {
    if (SafeLogger.#isSafe(logger)) {
      logger.#call(level, message, extra);
      return;
    }
    try {
      const target = logger as ILogger;
      const result: unknown =
        typeof extra === "undefined"
          ? target[level](message)
          : target[level](message, extra);
      if (typeof property(result, "then") === "function") {
        Promise.resolve(result).catch(ignore);
      }
    } catch {
      // Nothing else to report it to
    }
  }

  #call(
    level: ILogLevel,
    message: string,
    extra?: Record<string, unknown>,
  ): void {
    SafeLogger.#send(this.#logger, level, message, extra);
  }

  /**
   * A new logger of this class: over the child that its logger (never one
   * of binden, see the constructor) gives, or over that logger itself when
   * it fails (or does not give a logger, e.g. a promise). Never one that the
   * application holds (whose methods it may have replaced), nor this one.
   */
  #child(bindings: Record<string, unknown>): SafeLogger {
    const logger = this.#logger;
    try {
      const child: unknown = logger.child(bindings);
      if (typeof property(child, "then") === "function") {
        // Not a logger (e.g. of an `async` function): its rejection is
        // observed, and the logger itself is used
        Promise.resolve(child).catch(ignore);
      } else if (SafeLogger.#isSafe(child) || isLogger(child)) {
        return new SafeLogger(child);
      }
    } catch {
      // The logger itself
    }
    return new SafeLogger(logger);
  }
}

/**
 * A logger whose calls never fail (see `SafeLogger`): one that binden has
 * made is used as it is, anything else (also an object derived from one) is
 * wrapped
 */
export function safe(logger: ILogger): ILogger {
  return paths.isSafe(logger) ? logger : new SafeLogger(logger);
}

/**
 * Writes a record of binden itself through a logger (e.g. `context.log`),
 * never throwing: a logger of binden by its private path (the method of its
 * logger, called as its own methods call it), never through its methods,
 * which the application may replace, and anything else (e.g. what the `log`
 * of a subclass of `Context` gives) through its method, guarded in the same
 * way (see `SafeLogger`). A `level` that is not one of `ILogLevel` drops the
 * record. For the packages of binden only.
 *
 * @internal
 */
export function record(
  logger: unknown,
  level: ILogLevel,
  message: string,
  extra?: Record<string, unknown>,
): void {
  // Another level (e.g. a value of a package that is not one) drops the
  // record: it is never converted
  if (levels.includes(level)) {
    paths.record(logger, level, message, extra);
  }
}

/**
 * A child of a logger (see `SafeLogger.child()`) by the private path of a
 * logger of binden, never its `child()`, which the application may replace
 * (anything else, e.g. what a context that only looks like one gives, is
 * wrapped first): never throws, and always gives a new logger of binden. For
 * the packages of binden only (e.g. the logger of a parser, a child of
 * `context.log`), which write their records through it with `record()`.
 *
 * @internal
 */
export function childLogger(
  logger: ILogger,
  bindings: Record<string, unknown>,
): ILogger {
  return paths.child(logger, bindings);
}

/**
 * Writes a record of binden itself through the logger of a context (see
 * `record()`): what getting it throws (e.g. a `log` getter of a subclass of
 * `Context`, or of the context itself) drops the record, never out of the
 * caller. For the packages of binden only.
 *
 * @internal
 */
export function logTo(
  context: { readonly log: unknown },
  level: ILogLevel,
  message: string,
  extra?: Record<string, unknown>,
): void {
  try {
    const { log } = context;
    record(log, level, message, extra);
  } catch {
    // Dropped
  }
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
      if (!isContext(input)) {
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
