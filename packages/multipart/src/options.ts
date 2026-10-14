import type { BusboyConfig, Limits } from "busboy";
import type { IMiddlewareParams } from "binden";

/**
 * The configuration of busboy: its `limits`, the charsets of the parts and
 * the sizes of its buffers (its `headers` are those of the request: a
 * `headers` key is ignored)
 */
export type IMultipartConfig = Omit<BusboyConfig, "headers">;

/** The options of `Multipart` */
export interface IMultipartOptions extends IMiddlewareParams {
  /** The configuration of busboy, e.g. its `limits` (none by default but `fieldSize`, 1 MiB) */
  config?: IMultipartConfig | undefined;
  /**
   * Whether a request that reaches a limit of `config.limits` is refused
   * with `413 Content Too Large` (`true`), instead of truncated
   */
  throw_limits?: boolean | undefined;
  /**
   * The largest body in bytes, all of its parts included (no limit by
   * default, as with `Infinity`): a larger one is not read further, and
   * gets a `413 Content Too Large`, whatever `throw_limits`
   */
  limit?: number | undefined;
}

/** The options of a parse, checked, with their defaults */
export interface IParserOptions {
  readonly config: IMultipartConfig;
  readonly throw_limits: boolean;
  readonly limit: number;
}

/** The options of `Multipart` that its parent class takes */
type IMiddlewareOptions = Pick<IMiddlewareParams, "disabled" | "ignore_errors">;

const optionNames: ReadonlySet<string> = new Set([
  "disabled",
  "ignore_errors",
  "config",
  "throw_limits",
  "limit",
]);

const configNames: ReadonlySet<string> = new Set([
  "headers",
  "limits",
  "highWaterMark",
  "fileHwm",
  "defCharset",
  "defParamCharset",
  "preservePath",
]);

const limitNames: ReadonlySet<string> = new Set<keyof Limits>([
  "fieldNameSize",
  "fieldSize",
  "fields",
  "fileSize",
  "files",
  "parts",
  "headerPairs",
]);

/** The charsets that busboy decodes (in lowercase) */
const charsets: ReadonlySet<string> = new Set([
  "utf-8",
  "utf8",
  "latin1",
  "ascii",
  "us-ascii",
  "iso-8859-1",
  "iso8859-1",
  "iso88591",
  "iso_8859-1",
  "windows-1252",
  "iso_8859-1:1987",
  "cp1252",
  "x-cp1252",
  "utf16le",
  "utf-16le",
  "ucs2",
  "ucs-2",
  "base64",
]);

/** Whether a value is an object (not an array) */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An object of known keys (a `TypeError` otherwise) */
function checkObject(
  value: unknown,
  name: string,
  keys: ReadonlySet<string>,
): Record<string, unknown> {
  if (!isObject(value)) {
    throw new TypeError(`\`${name}\` is not an object`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) {
      throw new TypeError(`Unknown option: \`${name}.${key}\``);
    }
  }
  return value;
}

/** A size: a non-negative integer, or `Infinity` */
function checkSize(value: unknown, name: string): number {
  if (typeof value !== "number") {
    throw new TypeError(`\`${name}\` is not a number`);
  } else if (
    value !== Number.POSITIVE_INFINITY &&
    !(Number.isSafeInteger(value) && value >= 0)
  ) {
    throw new RangeError(`\`${name}\` is not a non-negative integer`);
  }
  return value;
}

/** The size of a buffer: a non-negative integer */
function checkBuffer(value: unknown, name: string): number {
  if (typeof value !== "number") {
    throw new TypeError(`\`${name}\` is not a number`);
  } else if (!(Number.isSafeInteger(value) && value >= 0)) {
    throw new RangeError(`\`${name}\` is not a non-negative integer`);
  }
  return value;
}

/** A charset that busboy decodes */
function checkCharset(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`\`${name}\` is not a string`);
  } else if (!charsets.has(value.toLowerCase())) {
    throw new RangeError(`\`${name}\` is not a charset that busboy decodes`);
  }
  return value;
}

/** The limits of busboy */
function checkLimits(value: unknown): Limits {
  const limits = checkObject(value, "config.limits", limitNames);
  return Object.fromEntries(
    Object.entries(limits)
      .filter(([, size]) => typeof size !== "undefined")
      .map(([name, size]) => [name, checkSize(size, `config.limits.${name}`)]),
  );
}

/**
 * The configuration of busboy, without `headers`: the parameters of the
 * parts (e.g. their file names) are decoded as UTF-8 by default
 */
function checkConfig(value: unknown): IMultipartConfig {
  const {
    limits,
    highWaterMark,
    fileHwm,
    defCharset,
    defParamCharset = "utf8",
    preservePath,
  } = checkObject(value, "config", configNames);
  if (
    typeof preservePath !== "undefined" &&
    typeof preservePath !== "boolean"
  ) {
    throw new TypeError("`config.preservePath` is not a boolean");
  }
  return {
    defParamCharset: checkCharset(defParamCharset, "config.defParamCharset"),
    ...(typeof limits === "undefined" ? {} : { limits: checkLimits(limits) }),
    ...(typeof highWaterMark === "undefined"
      ? {}
      : { highWaterMark: checkBuffer(highWaterMark, "config.highWaterMark") }),
    ...(typeof fileHwm === "undefined"
      ? {}
      : { fileHwm: checkBuffer(fileHwm, "config.fileHwm") }),
    ...(typeof defCharset === "undefined"
      ? {}
      : { defCharset: checkCharset(defCharset, "config.defCharset") }),
    ...(typeof preservePath === "undefined" ? {} : { preservePath }),
  };
}

/**
 * The options of `Multipart`, checked (a `TypeError` for an unknown option
 * or a value of another type, a `RangeError` for a value out of its range),
 * with their defaults
 */
export function validateOptions(input: unknown): {
  middleware: IMiddlewareOptions;
  parser: IParserOptions;
} {
  const {
    disabled,
    ignore_errors,
    config = {},
    throw_limits = true,
    limit = Number.POSITIVE_INFINITY,
  } = checkObject(input, "options", optionNames);
  if (typeof throw_limits !== "boolean") {
    throw new TypeError("`throw_limits` is not a boolean");
  }
  return {
    middleware: {
      disabled: disabled as boolean | undefined,
      ignore_errors: ignore_errors as boolean | undefined,
    },
    parser: {
      config: checkConfig(config),
      throw_limits,
      limit: checkSize(limit, "limit"),
    },
  };
}
