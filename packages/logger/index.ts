import pino, {
  type Bindings,
  type DestinationStream,
  type LevelWithSilent,
  type Logger as PinoLogger,
  type LoggerOptions as PinoLoggerOptions,
} from "pino";
import { constants } from "node:os";
import { createRequire } from "node:module";

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

/**
 * Formats the stack of an error that this package has just created, before
 * it is thrown, as binden formats its own: V8 formats it once it is first
 * read, and until then its frames hold their objects (e.g. the options of a
 * logger, as the arguments of its constructor), which an error kept by the
 * application would retain as long as it lives
 */
function formatStack<T extends Error>(error: T): T {
  try {
    Reflect.get(error, "stack");
  } catch {
    // A `prepareStackTrace` of the application that throws: the stack is
    // left to it
  }
  return error;
}

/**
 * Runs the body of an entry point of this package (e.g. what reads or calls
 * an argument): what it throws is formatted (see `formatStack()`) before the
 * caller gets it, as binden formats it (e.g. the `TypeError` of V8 for a
 * revoked proxy, or an error of `pino` for its options), and an error of the
 * application's own (e.g. of a getter) is thrown as it is (formatted too)
 */
function formatting<T>(run: () => T): T {
  try {
    return run();
  } catch (error: unknown) {
    throw formatStack(error as Error);
  }
}

/**
 * A value that an argument error of this package refuses, as its message
 * shows it, without converting it (as binden describes it): a string, a
 * number, a boolean, `undefined` or `null` as it is, a `bigint` with its `n`,
 * and anything else by its type, so that neither a conversion throws nor code
 * of the application runs (e.g. a `toString()`)
 */
function described(value: unknown): string {
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "boolean":
      return `${value}`;
    case "bigint":
      return `${value}n`;
    case "undefined":
      return "undefined";
    case "symbol":
      return "(a symbol)";
    case "function":
      return "(a function)";
    case "object":
    default:
      return value === null ? "null" : "(an object)";
  }
}

/**
 * The options of an entry point (`name` in the message), checked before any
 * of them is read (`undefined` is the default of its parameter): anything but
 * an object is refused with a `TypeError` that describes it (see
 * `described()`)
 */
function optionsOf(value: unknown, name: string): object {
  if (typeof value !== "object" || value === null) {
    throw formatStack(
      new TypeError(`\`${name}\` is not an object: ${described(value)}`),
    );
  }
  return value;
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

/** The default serializers of the `error`, `err`, `request` and `response` keys */
export interface ISerializers {
  /**
   * The type of an error, a known `code` and its `status` (with
   * `error_details`, also its message, stack and any `code`)
   */
  error(error: unknown): Record<string, unknown>;
  /**
   * The same as `error`, for the key of `pino` (an `Error` given as `extra`
   * is logged under it)
   */
  err(error: unknown): Record<string, unknown>;
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
export function createSerializers(
  options: { error_details?: boolean | undefined } = {},
): ISerializers {
  // Read once: what reading the options throws is formatted (see
  // `formatting()`)
  const { error_details = false } = formatting(() => {
    const { error_details: given } = optionsOf(options, "options") as {
      error_details?: unknown;
    };
    return { error_details: given };
  });
  if (typeof error_details !== "boolean") {
    throw formatStack(new TypeError("`error_details` is not a boolean"));
  }
  // The type of an error, a known `code` and its `status` (and, with
  // `error_details`, its message, its stack and any `code`)
  const error = (value: unknown): Record<string, unknown> => {
    const type = typeOf(value);
    if (typeof value !== "object" && typeof value !== "function") {
      return { type };
    }
    const code = property(value, "code");
    const status = property(value, "status");
    const message = property(value, "message");
    const stack = property(value, "stack");
    const known = typeof code === "string" && errorCodes.has(code);
    return {
      type,
      ...((known || error_details) && typeof code === "string" ? { code } : {}),
      ...(isStatus(status) ? { status } : {}),
      ...(error_details && typeof message === "string" ? { message } : {}),
      ...(error_details && typeof stack === "string" ? { stack } : {}),
    };
  };
  return {
    error,
    // `pino` logs an `Error` given as `extra` under `err`, which its own
    // serializer would log whole (e.g. a `config` with credentials)
    err: error,
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

/** Whether a value is an object (not `null`), e.g. a nested option of `pino` */
function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Whether a value has properties that `pino` reads as those of an object: an
 * object or a function (e.g. a `customLevels` that is a function carrying its
 * levels)
 */
function hasProperties(value: unknown): value is Record<PropertyKey, unknown> {
  return isObject(value) || typeof value === "function";
}

/** Sets a property that is not enumerable: `pino` reads it, but never spreads it */
function hide(object: object, key: string, value: unknown): void {
  Object.defineProperty(object, key, {
    value,
    enumerable: false,
    writable: true,
    configurable: true,
  });
}

/**
 * A copy of the own enumerable properties of an object (which `pino` spreads),
 * with the properties under `keys` that it reads as they are (also inherited,
 * or not enumerable) when they are not among them, each read once: those of
 * `hidden` are not enumerable in the copy, since `pino` reads them but never
 * spreads them
 */
function copyOf(
  value: Record<PropertyKey, unknown>,
  keys: readonly string[],
  hidden: readonly string[] = [],
): Record<PropertyKey, unknown> {
  const copy: Record<PropertyKey, unknown> = { ...value };
  for (const key of [...keys, ...hidden]) {
    if (!Object.hasOwn(copy, key)) {
      const read: unknown = Reflect.get(value, key);
      if (typeof read === "undefined") {
        // Nothing to copy
      } else if (keys.includes(key)) {
        copy[key] = read;
      } else {
        hide(copy, key, read);
      }
    }
  }
  return copy;
}

/**
 * A step of a pipeline of `transport`, copied as `pino` reads it: its own
 * enumerable properties, which it spreads, and its `target` (also inherited),
 * once. Its other inherited properties (e.g. a `level`) are ignored, as
 * `pino` ignores them. A function is copied as an object (`pino` reads its
 * properties as those of one).
 */
function copyStep(step: unknown): unknown {
  return hasProperties(step) ? copyOf(step, ["target"]) : step;
}

/**
 * A target of `transport`, copied as `pino` reads it (see `copyStep()`), with
 * its `pipeline` (also inherited), whose steps are copied too, and, for a
 * target with a pipeline only, its `level` (also inherited), which `pino`
 * gives to each of its steps: each once. Unless they are its own enumerable
 * properties, `pino` never spreads them, nor does the copy. A function is
 * copied as an object, as a step is.
 */
function copyTarget(target: unknown): unknown {
  if (!hasProperties(target)) {
    return target;
  }
  const copy = copyOf(target, ["target"], ["pipeline"]);
  const { pipeline } = copy;
  if (Array.isArray(pipeline)) {
    copy.pipeline = [...(pipeline as unknown[])].map(copyStep);
  }
  if (Boolean(pipeline) && !Object.hasOwn(copy, "level")) {
    hide(copy, "level", Reflect.get(target, "level"));
  }
  return copy;
}

/**
 * An object whose list under a key (the `targets` or the `pipeline` of
 * `transport`), if it is an array, is a copy of its items (see `copyTarget()`
 * and `copyStep()`)
 */
function withCopies(
  object: Record<PropertyKey, unknown>,
  key: string,
  copy: (item: unknown) => unknown,
): Record<PropertyKey, unknown> {
  const list = object[key];
  if (Array.isArray(list)) {
    object[key] = [...(list as unknown[])].map(copy);
  }
  return object;
}

/**
 * The class of the streams of `pino` (`SonicBoom`, a function of CommonJS), by
 * which it refuses one given as `transport`
 */
type SonicBoomClass = (...args: never) => unknown;

// eslint-disable-next-line init-declarations -- resolved when it is first needed (see `sonicBoom()`)
let sonicBoomClass: SonicBoomClass | null | undefined;

/**
 * The `SonicBoom` class of `pino`, resolved from `pino` as `pino` resolves
 * it (the same class), once, when a `transport` is first given, or `null`
 * where it cannot be resolved (e.g. in a bundle): `pino` then tells one by the
 * prototype that the copy of `transport` keeps (see `copyTransport()`)
 */
function sonicBoom(): SonicBoomClass | null {
  if (typeof sonicBoomClass === "undefined") {
    try {
      sonicBoomClass = createRequire(import.meta.resolve("pino"))(
        "sonic-boom",
      ) as SonicBoomClass;
    } catch {
      sonicBoomClass = null;
    }
  }
  return sonicBoomClass;
}

/**
 * `object`, with each of `values` that is not its own property yet as one, not
 * enumerable (see `hide()`): `pino` reads them, but never spreads them
 */
function hiding(
  object: Record<PropertyKey, unknown>,
  values: ReadonlyMap<string, unknown>,
): Record<PropertyKey, unknown> {
  for (const [key, value] of values) {
    if (!Object.hasOwn(object, key)) {
      hide(object, key, value);
    }
  }
  return object;
}

/**
 * `transport`, copied as `pino` reads it, in its order. First what it reads
 * to refuse a stream, each only while it has not refused it: whether it is a
 * `SonicBoom` (by its prototype chain), then its `writable`, then its
 * `_writableState` (also inherited, or not enumerable). A refused one is
 * copied as what `pino` refuses (a `SonicBoom`, or what it has read), and
 * nothing else is read. Then its `targets` (also inherited, or not
 * enumerable), which it reads to refuse a `level` formatter with them, and
 * its own enumerable properties, which it spreads (with copies of its
 * `targets` and its `pipeline`, see `copyTarget()` and `copyStep()`), reusing
 * those read before: each is read once. The copy has what `pino` reads as it
 * is but never spreads as its own properties, not enumerable, and no
 * prototype, through which `pino` would read the transport again (but where
 * the class of `SonicBoom` cannot be resolved, see `sonicBoom()`). A function
 * is copied as an object.
 */
function copyTransport(
  transport: Record<PropertyKey, unknown>,
): Record<PropertyKey, unknown> {
  const SonicBoom = sonicBoom();
  if (SonicBoom !== null && transport instanceof SonicBoom) {
    return Object.create(SonicBoom.prototype as object) as Record<
      PropertyKey,
      unknown
    >;
  }
  // Without the class, the copy keeps the prototype, by which `pino` tells a
  // `SonicBoom` itself
  const prototype =
    SonicBoom === null
      ? (Object.getPrototypeOf(transport) as object | null)
      : null;
  const copy = Object.create(null) as Record<PropertyKey, unknown>;
  const read = new Map<string, unknown>();
  for (const key of ["writable", "_writableState"]) {
    const value: unknown = Reflect.get(transport, key);
    read.set(key, value);
    // A truthy one: `pino` refuses a stream
    const refused = Boolean(value);
    if (refused) {
      return hiding(copy, read);
    }
  }
  read.set("targets", Reflect.get(transport, "targets"));
  // Spread as `pino` spreads it: for each of its own keys, its descriptor,
  // then the value of an enumerable one
  for (const key of Reflect.ownKeys(transport)) {
    if (Reflect.getOwnPropertyDescriptor(transport, key)?.enumerable === true) {
      Object.defineProperty(copy, key, {
        value:
          typeof key === "string" && read.has(key)
            ? read.get(key)
            : Reflect.get(transport, key),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return Object.setPrototypeOf(
    hiding(
      withCopies(withCopies(copy, "targets", copyTarget), "pipeline", copyStep),
      read,
    ),
    prototype,
  ) as Record<PropertyKey, unknown>;
}

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
   * key with `serializers`), or one of an existing `pino` logger (`logger`,
   * whose options apply: it cannot be combined with any other option). An
   * invalid option (e.g. an unknown `level`, or a `logger` that is not a
   * `pino` logger) throws a `TypeError`.
   */
  public constructor(all: LoggerOptions = {}) {
    // Read once, and checked: what reading them throws is formatted (see
    // `formatting()`)
    const { logger, destination, error_details, custom, options } = formatting(
      () => Logger.#read(all),
    );
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
    // What `pino` throws for its options (e.g. a destination that it cannot
    // read) is formatted (see `formatting()`)
    this.#logger = Logger.#deferred ? null : formatting(this.#create);
  }

  /**
   * The options of a logger, each read once, and checked (see the
   * constructor): anything but an object is refused with a `TypeError`
   */
  static #read(all: unknown): {
    readonly logger: PinoLogger | undefined;
    readonly destination: DestinationStream | undefined;
    readonly error_details: boolean;
    readonly custom: NonNullable<PinoLoggerOptions["serializers"]>;
    readonly options: PinoLoggerOptions;
  } {
    const given = optionsOf(all, "options") as LoggerOptions;
    const {
      logger,
      destination,
      error_details,
      serializers: custom,
      ...options
    } = given;
    if (typeof logger !== "undefined") {
      // The other options, by their names in the order of the object
      const named: Record<string, unknown> = {
        destination,
        error_details,
        serializers: custom,
        ...options,
      };
      Logger.#checkPino(
        logger,
        Object.keys(given).filter(
          (name) => name !== "logger" && typeof named[name] !== "undefined",
        ),
      );
    } else if (
      typeof error_details !== "undefined" &&
      typeof error_details !== "boolean"
    ) {
      throw formatStack(new TypeError("`error_details` is not a boolean"));
    }
    // Read once (see `#copy()`): the checks and `pino` read the copy (no
    // level is combined with `logger`)
    const copied = Logger.#copy(options, destination);
    Logger.#checkNested(copied);
    if (typeof copied.level !== "undefined") {
      const { customLevels = {}, useOnlyCustomLevels = false } = copied;
      Logger.#checkLevel(copied.level, {
        ...(useOnlyCustomLevels ? {} : pino.levels.values),
        ...customLevels,
      });
    }
    return {
      logger,
      destination,
      error_details: error_details ?? false,
      custom: custom ?? {},
      options: copied,
    };
  }

  /**
   * The options of `pino`, with a copy of those that it reads several times
   * (each level of `customLevels`, which the check of `level` reads too, the
   * `hooks`, the paths of `redact`, and the targets and steps of
   * `transport`), made as `pino` reads them: each is read once, so that a
   * getter of the application runs once. A `transport` given with a
   * `destination` that is a path is not read: `pino` refuses them before it
   * reads anything of it
   */
  static #copy(
    options: PinoLoggerOptions,
    destination: unknown,
  ): PinoLoggerOptions {
    const copied: Record<string, unknown> = { ...options };
    const { customLevels, hooks, redact, transport } = copied;
    if (hasProperties(customLevels)) {
      // Also a function carrying its levels: `pino` reads their keys
      copied.customLevels = { ...customLevels };
    }
    if (hasProperties(hooks)) {
      // Kept by `pino`, which reads `logMethod` (also inherited) at its
      // creation and at every change of its level, and `streamWrite` at
      // every record
      copied.hooks = copyOf(hooks, ["logMethod", "streamWrite"]);
    }
    if (Array.isArray(redact)) {
      copied.redact = [...(redact as unknown[])];
    } else if (isObject(redact)) {
      // What `pino` reads of it (also inherited), as it reads them
      const { paths, censor, remove } = redact;
      copied.redact = {
        paths: Array.isArray(paths) ? [...(paths as unknown[])] : paths,
        censor,
        remove,
      };
    }
    if (hasProperties(transport) && typeof destination !== "string") {
      copied.transport = copyTransport(transport);
    }
    return copied;
  }

  /**
   * Throws a `TypeError` for a nested option that `pino` would convert: a
   * level of `customLevels` that is not a number, and a path of `redact` that
   * is not a string, checked by their types (never converted)
   */
  static #checkNested({ customLevels, redact }: PinoLoggerOptions): void {
    const levels: unknown = customLevels ?? {};
    for (const level of Object.values(levels as object) as unknown[]) {
      if (typeof level !== "number") {
        throw formatStack(
          new TypeError(
            `\`customLevels\` has a level that is not a number: ${described(level)}`,
          ),
        );
      }
    }
    const paths: unknown = Array.isArray(redact)
      ? redact
      : isObject(redact)
        ? redact.paths
        : null;
    for (const path of Array.isArray(paths) ? (paths as unknown[]) : []) {
      if (typeof path !== "string") {
        throw formatStack(
          new TypeError(
            `\`redact\` has a path that is not a string: ${described(path)}`,
          ),
        );
      }
    }
  }

  /** A logger that writes with an existing `pino` logger (its options apply) */
  public static fromPino(logger: PinoLogger): Logger {
    return new Logger({ logger });
  }

  /** The level of the logger */
  public get level(): LevelWithSilent {
    return this.#pino().level as LevelWithSilent;
  }

  /** Sets the level of the logger (an unknown one throws a `TypeError`) */
  public set level(level: LevelWithSilent) {
    formatting(() => {
      const logger = this.#pino();
      Logger.#checkLevel(level, logger.levels.values);
      logger.level = level;
    });
  }

  /**
   * Whether the records of a level are written: never those of a level that
   * is not a string (it is not converted)
   */
  public isLevelEnabled(level: string): boolean {
    const given: unknown = level;
    return typeof given === "string" && this.#pino().isLevelEnabled(given);
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

  /**
   * A logger that adds `bindings` to every record (with its own level, if
   * given: an unknown one throws a `TypeError`)
   */
  public child(bindings: Bindings = {}, options: IChildOptions = {}): Logger {
    // What reading the arguments throws, also in `pino`, is formatted (see
    // `formatting()`)
    return formatting(() => {
      const { level } = options;
      const logger = this.#pino();
      if (typeof level !== "undefined") {
        Logger.#checkLevel(level, logger.levels.values);
      }
      return Logger.fromPino(
        typeof level === "undefined"
          ? logger.child(bindings)
          : logger.child(bindings, { level }),
      );
    });
  }

  /** Logs a message (with extra fields) at the `fatal` level */
  public fatal(message: string, extra: Record<string, unknown> = {}): void {
    // What `pino` throws as it reads `extra` (e.g. a revoked proxy) is
    // formatted (see `formatStack()`): inline, a hot path
    try {
      this.#pino().fatal(extra, message);
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /** Logs a message (with extra fields) at the `error` level */
  public error(message: string, extra: Record<string, unknown> = {}): void {
    // What `pino` throws as it reads `extra` (e.g. a revoked proxy) is
    // formatted (see `formatStack()`): inline, a hot path
    try {
      this.#pino().error(extra, message);
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /** Logs a message (with extra fields) at the `warn` level */
  public warn(message: string, extra: Record<string, unknown> = {}): void {
    // What `pino` throws as it reads `extra` (e.g. a revoked proxy) is
    // formatted (see `formatStack()`): inline, a hot path
    try {
      this.#pino().warn(extra, message);
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /** Logs a message (with extra fields) at the `info` level */
  public info(message: string, extra: Record<string, unknown> = {}): void {
    // What `pino` throws as it reads `extra` (e.g. a revoked proxy) is
    // formatted (see `formatStack()`): inline, a hot path
    try {
      this.#pino().info(extra, message);
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /** Logs a message (with extra fields) at the `debug` level */
  public debug(message: string, extra: Record<string, unknown> = {}): void {
    // What `pino` throws as it reads `extra` (e.g. a revoked proxy) is
    // formatted (see `formatStack()`): inline, a hot path
    try {
      this.#pino().debug(extra, message);
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /** Logs a message (with extra fields) at the `trace` level */
  public trace(message: string, extra: Record<string, unknown> = {}): void {
    // What `pino` throws as it reads `extra` (e.g. a revoked proxy) is
    // formatted (see `formatStack()`): inline, a hot path
    try {
      this.#pino().trace(extra, message);
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
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
  public static getLevel(env_name?: string): LevelWithSilent {
    // A string before it is read, which would convert it (the default
    // computed inside the formatting, see `formatting()`)
    const given: unknown =
      typeof env_name === "undefined"
        ? formatting(() => this.ENV_VARIABLE_NAME)
        : env_name;
    if (typeof given !== "string") {
      throw formatStack(
        new TypeError(`\`env_name\` is not a string: ${described(given)}`),
      );
    }
    const {
      env: { [given]: LEVEL },
    } = process;

    const level = (LEVEL ?? "").trim().toLowerCase();

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

  /** Throws a `TypeError` unless a level is `silent` or one of the known ones */
  static #checkLevel(level: unknown, known: Record<string, number>): void {
    if (
      typeof level !== "string" ||
      (level !== "silent" && !Object.hasOwn(known, level))
    ) {
      // Described without converting it (see `described()`)
      throw formatStack(new TypeError(`Unknown level: ${described(level)}`));
    }
  }

  /**
   * Throws a `TypeError` unless `logger` is a `pino` logger (with its methods)
   * that no other option is combined with: they would not apply to it
   */
  static #checkPino(logger: unknown, others: readonly string[]): void {
    const methods = [
      "child",
      "flush",
      "isLevelEnabled",
      "fatal",
      "error",
      "warn",
      "info",
      "debug",
      "trace",
    ];
    if (
      typeof logger !== "object" ||
      logger === null ||
      // Read as they are: what a getter or a proxy throws is thrown
      !methods.every((name) => typeof Reflect.get(logger, name) === "function")
    ) {
      throw formatStack(new TypeError("`logger` is not a `pino` logger"));
    }
    const [other] = others;
    if (typeof other !== "undefined") {
      throw formatStack(
        new TypeError(`\`logger\` cannot be combined with \`${other}\``),
      );
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
