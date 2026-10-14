import { constants } from "node:os";
import pino, {
  type Bindings,
  type DestinationStream,
  type LevelWithSilent,
  type Logger as PinoLogger,
  type LoggerOptions as PinoLoggerOptions,
} from "pino";

/** The options of a `Logger` */
export interface LoggerOptions extends PinoLoggerOptions {
  /** Where the records are written (`stdout` by default) */
  destination?: DestinationStream | undefined;
  /** An existing `pino` logger to use as it is (see `Logger.fromPino()`) */
  logger?: PinoLogger | undefined;
  /**
   * Whether the default `error` serializer adds the message, the stack and
   * any `code` of an error (`false`): they may quote the input
   */
  error_details?: boolean | undefined;
}

/** The options of `Logger.child()` */
export interface IChildOptions {
  /** The level of the child (the level of its parent by default) */
  level?: LevelWithSilent | undefined;
}

/** A logger that binden can use: the `Logger` of this package, or any object with these methods */
export interface ILogger {
  /** Logs a message (with extra fields) at the `fatal` level */
  fatal(message: string, extra?: Record<string, unknown>): unknown;
  /** Logs a message (with extra fields) at the `error` level */
  error(message: string, extra?: Record<string, unknown>): unknown;
  /** Logs a message (with extra fields) at the `warn` level */
  warn(message: string, extra?: Record<string, unknown>): unknown;
  /** Logs a message (with extra fields) at the `info` level */
  info(message: string, extra?: Record<string, unknown>): unknown;
  /** Logs a message (with extra fields) at the `debug` level */
  debug(message: string, extra?: Record<string, unknown>): unknown;
  /** Logs a message (with extra fields) at the `trace` level */
  trace(message: string, extra?: Record<string, unknown>): unknown;
  /** A logger that adds the bindings to every record */
  child(bindings: Record<string, unknown>): ILogger;
}

/** The built-in error classes, the nearest of which is the type of an error */
const errorTypes: ReadonlyMap<object, string> = new Map<object, string>([
  [AggregateError.prototype, "AggregateError"],
  [EvalError.prototype, "EvalError"],
  [RangeError.prototype, "RangeError"],
  [ReferenceError.prototype, "ReferenceError"],
  [SyntaxError.prototype, "SyntaxError"],
  [TypeError.prototype, "TypeError"],
  [URIError.prototype, "URIError"],
  [Error.prototype, "Error"],
]);

/** The codes of an error that are logged: system errors and some stream/HTTP ones */
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
]);

/** A property of any value: `null` instead of an error (e.g. a throwing getter) */
function property(value: unknown, key: string): unknown {
  try {
    return Reflect.get(value as object, key) as unknown;
  } catch {
    return null;
  }
}

/** The type of a value: for an object, its nearest built-in error class */
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

/** Whether a value is a status code: an integer from 100 to 599 */
function isStatus(value: unknown): value is number {
  return (
    Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599
  );
}

/**
 * The path of a request-target: never its query or fragment, nor the scheme,
 * the authority or the userinfo of an absolute-form target
 */
function pathOf(target: string): string {
  if (target.startsWith("/")) {
    return target.replace(/[?#].*$/su, "");
  }
  return URL.canParse(target) ? new URL(target).pathname : "";
}

/** The default serializers of the `error`, `request` and `response` keys */
export interface ISerializers {
  /**
   * The type of an error, a known `code` and its `status` (with
   * `error_details`, also its message, stack and any `code`)
   */
  error(error: unknown): Record<string, unknown>;
  /** The method and the path (without the query) of a request */
  request(request: unknown): Record<string, unknown>;
  /** The status of a response */
  response(response: unknown): Record<string, unknown>;
}

/**
 * The default serializers: an allowlist of details, found by duck typing, so
 * that the input of the requests (credentials, query strings, bodies, error
 * messages that quote them) stays out of the logs. A value of another kind is
 * reduced to its type.
 */
export function createSerializers({
  error_details = false,
}: { error_details?: boolean | undefined } = {}): ISerializers {
  return {
    // The type of an error, a known `code` and its `status` (and, with
    // `error_details`, its message, its stack and any `code`)
    error: (error: unknown): Record<string, unknown> => {
      const type = typeOf(error);
      if (typeof error !== "object" && typeof error !== "function") {
        return { type };
      }
      const code = property(error, "code");
      const status = property(error, "status");
      const message = property(error, "message");
      const stack = property(error, "stack");
      const known = typeof code === "string" && errorCodes.has(code);
      return {
        type,
        ...((known || error_details) && typeof code === "string"
          ? { code }
          : {}),
        ...(isStatus(status) ? { status } : {}),
        ...(error_details && typeof message === "string" ? { message } : {}),
        ...(error_details && typeof stack === "string" ? { stack } : {}),
      };
    },
    // The method and the path (without the query string) of a request
    request: (request: unknown): Record<string, unknown> => {
      const method = property(request, "method");
      const url = property(request, "url");
      if (typeof method !== "string" && typeof url !== "string") {
        return { type: typeOf(request) };
      }
      return {
        ...(typeof method === "string" ? { method } : {}),
        ...(typeof url === "string" ? { path: pathOf(url) } : {}),
      };
    },
    // The status of a response
    response: (response: unknown): Record<string, unknown> => {
      const status = property(response, "statusCode");
      return isStatus(status) ? { status } : { type: typeOf(response) };
    },
  };
}

/** The default serializers (without the details of the errors) */
export const serializers: ISerializers = createSerializers();

// eslint-disable-next-line init-declarations -- set by the static block of `Logger`
let createDefault: () => Logger;

/** A logger based on `pino`, with safe default serializers */
export class Logger implements ILogger {
  static #deferred = false;

  #logger: PinoLogger | null;
  readonly #create: () => PinoLogger;

  static {
    // Its `pino` logger is created when it is first used: importing this
    // package has no side effect, and `BINDEN_LOG_LEVEL` is read then
    createDefault = (): Logger => {
      Logger.#deferred = true;
      try {
        return new Logger();
      } finally {
        Logger.#deferred = false;
      }
    };
  }

  /**
   * A logger with the options of `pino` (and its safe serializers, merged by
   * key with `serializers`), or one of an existing `pino` logger (`logger`):
   * `logger` with `destination`, or an `error_details` that is not a boolean,
   * throws a `TypeError`
   */
  public constructor({
    logger,
    destination,
    error_details = false,
    serializers: custom = {},
    ...options
  }: LoggerOptions = {}) {
    if (typeof logger !== "undefined" && typeof destination !== "undefined") {
      throw new TypeError("`logger` and `destination` cannot both be set");
    } else if (typeof error_details !== "boolean") {
      throw new TypeError("`error_details` is not a boolean");
    }
    this.#create = (): PinoLogger => {
      if (typeof logger !== "undefined") {
        return logger;
      }
      const merged: PinoLoggerOptions = {
        level: Logger.getLevel(),
        ...options,
        serializers: { ...createSerializers({ error_details }), ...custom },
      };
      return typeof destination === "undefined"
        ? pino(merged)
        : pino(merged, destination);
    };
    this.#logger = Logger.#deferred ? null : this.#create();
  }

  /** A logger that writes with an existing `pino` logger (its options apply) */
  public static fromPino(logger: PinoLogger): Logger {
    return new Logger({ logger });
  }

  /** The level of the logger */
  public get level(): LevelWithSilent {
    return this.#pino().level as LevelWithSilent;
  }

  /** Sets the level of the logger */
  public set level(level: LevelWithSilent) {
    this.#pino().level = level;
  }

  /** Whether the records of a level are written */
  public isLevelEnabled(level: string): boolean {
    return this.#pino().isLevelEnabled(level);
  }

  /** Writes the buffered records (e.g. before the process exits) */
  public flush(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#pino().flush((error?: Error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /** A logger that adds `bindings` to every record (with its own level, if given) */
  public child(bindings: Bindings = {}, { level }: IChildOptions = {}): Logger {
    const logger = this.#pino();
    return Logger.fromPino(
      typeof level === "undefined"
        ? logger.child(bindings)
        : logger.child(bindings, { level }),
    );
  }

  /** Logs a message (with extra fields) at the `fatal` level */
  public fatal(message: string, extra: Record<string, unknown> = {}): void {
    this.#pino().fatal(extra, message);
  }

  /** Logs a message (with extra fields) at the `error` level */
  public error(message: string, extra: Record<string, unknown> = {}): void {
    this.#pino().error(extra, message);
  }

  /** Logs a message (with extra fields) at the `warn` level */
  public warn(message: string, extra: Record<string, unknown> = {}): void {
    this.#pino().warn(extra, message);
  }

  /** Logs a message (with extra fields) at the `info` level */
  public info(message: string, extra: Record<string, unknown> = {}): void {
    this.#pino().info(extra, message);
  }

  /** Logs a message (with extra fields) at the `debug` level */
  public debug(message: string, extra: Record<string, unknown> = {}): void {
    this.#pino().debug(extra, message);
  }

  /** Logs a message (with extra fields) at the `trace` level */
  public trace(message: string, extra: Record<string, unknown> = {}): void {
    this.#pino().trace(extra, message);
  }

  /** The environment variable of the default level: `BINDEN_LOG_LEVEL` */
  public static get ENV_VARIABLE_NAME(): string {
    return "BINDEN_LOG_LEVEL";
  }

  /**
   * The level that an environment variable names (in any case,
   * `BINDEN_LOG_LEVEL` by default): `silent` without it, or for an unknown
   * level
   */
  public static getLevel(env_name = this.ENV_VARIABLE_NAME): LevelWithSilent {
    const {
      env: { [env_name]: LEVEL },
    } = process;

    const level = LEVEL?.trim().toLowerCase();

    switch (level) {
      case "trace":
      case "debug":
      case "info":
      case "warn":
      case "error":
      case "fatal":
        return level;
      default:
        return "silent";
    }
  }

  /** The `pino` logger, created on first use for the default logger */
  #pino(): PinoLogger {
    this.#logger ??= this.#create();
    return this.#logger;
  }
}

/** The default logger: its level is `BINDEN_LOG_LEVEL` (`silent` without it) */
export default createDefault();
