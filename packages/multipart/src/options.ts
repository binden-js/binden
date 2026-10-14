import type { BusboyConfig, Limits } from "busboy";
import type { Context, IMiddlewareParams } from "binden";
import type { Readable } from "node:stream";
import { resolve } from "node:path";

/**
 * The configuration of busboy: its `limits`, the charsets of the parts and
 * the sizes of its buffers (its `headers` are those of the request: a
 * `headers` key is ignored)
 */
export type IMultipartConfig = Omit<BusboyConfig, "headers">;

/**
 * What a file part declares of itself, none of which is checked against its
 * content (e.g. its type is the one the client has chosen)
 */
export interface IFileInfo {
  /** The name of the field */
  field: string;
  /**
   * The name of the file as the client has sent it, without its control
   * characters, cut to 255 bytes, `"blob"` when it is empty: metadata, never
   * a path to write to
   */
  filename: string;
  /** The media type of the part (`Content-Type`, `text/plain` by default) */
  mime_type: string;
  /** The `Content-Transfer-Encoding` of the part (`7bit` by default) */
  encoding: string;
}

/**
 * Whether a file is accepted, from what it declares: a `Promise` is awaited
 * (until the request is aborted), and must resolve to a boolean
 */
export type IFileFilter = (
  info: IFileInfo,
  context: Context,
) => boolean | Promise<boolean>;

/** A file of the stream storage: what it declares, and its content */
export interface IStreamFile extends IFileInfo {
  /**
   * The content: what `on_file` has not read once it has settled is read
   * and discarded
   */
  readonly stream: Readable;
  /** Whether the content has been truncated to `fileSize` (known once it has been read) */
  truncated(): boolean;
}

/**
 * Streams each file to `on_file` (e.g. to a storage service) instead of
 * keeping it: `request.body` is a `FormData` of the fields only
 */
export interface IStreamStorage {
  /**
   * Handles a file: it should read the whole stream before it settles. It is
   * awaited (until the request is aborted) before the body is parsed; it
   * fails the request with a `BindenError` it throws, or a `500`.
   */
  on_file(file: IStreamFile, context: Context): unknown;
}

/**
 * Stores each file on the disk (see `IStoredFile`): `request.body` is an
 * `IStoredForm`
 */
export interface IDiskStorage {
  /** The directory of the private directories of the requests (`os.tmpdir()`) */
  dir?: string | undefined;
}

/**
 * Where the files go: in memory (`"memory"`), on the disk (`{ dir }`), or to
 * a handler (`{ on_file }`)
 */
export type IStorage = "memory" | IDiskStorage | IStreamStorage;

/** The storage of a parse */
export type IMode =
  | { readonly kind: "disk"; readonly dir: string | null }
  | { readonly kind: "memory" }
  | { readonly kind: "stream"; readonly on_file: IStreamStorage["on_file"] };

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
  /**
   * Whether a file is accepted, from what it declares (its metadata, never
   * its content), before it is read: all of them by default
   */
  file_filter?: IFileFilter | undefined;
  /**
   * What happens to a file that `file_filter` refuses: the request is
   * refused with `415 Unsupported Media Type` (`"reject"`), or the file is
   * read and discarded (`"skip"`)
   */
  filtered?: "reject" | "skip" | undefined;
  /**
   * Where the files go: in memory, as a `MultipartFile` of the `FormData`
   * (`"memory"`), on the disk (`{ dir }`), or to a handler (`{ on_file }`)
   */
  storage?: IStorage | undefined;
}

/** The options of a parse, checked, with their defaults */
export interface IParserOptions {
  /** The configuration of busboy */
  readonly config: IMultipartConfig;
  /** Whether a limit of busboy refuses the request (`413`) */
  readonly throw_limits: boolean;
  /** The largest body in bytes (`Infinity` for none) */
  readonly limit: number;
  /** Whether a file is accepted (`null`: all of them) */
  readonly file_filter: IFileFilter | null;
  /** What happens to a file that `file_filter` refuses */
  readonly filtered: "reject" | "skip";
  /** Where the files go */
  readonly mode: IMode;
}

/** The options of `Multipart` that its parent class takes */
type IMiddlewareOptions = Pick<IMiddlewareParams, "disabled" | "ignore_errors">;

const optionNames: ReadonlySet<string> = new Set([
  "disabled",
  "ignore_errors",
  "config",
  "throw_limits",
  "limit",
  "file_filter",
  "filtered",
  "storage",
]);

const storageNames: ReadonlySet<string> = new Set(["dir", "on_file"]);

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

/** The storage of the files: its directory is resolved now */
function checkStorage(value: unknown): IMode {
  if (value === "memory") {
    return { kind: "memory" };
  }
  const storage = checkObject(value, "storage", storageNames);
  const { dir, on_file } = storage;
  if ("on_file" in storage) {
    if ("dir" in storage) {
      throw new TypeError("`storage.dir` and `storage.on_file` are exclusive");
    } else if (typeof on_file !== "function") {
      throw new TypeError("`storage.on_file` is not a function");
    }
    return { kind: "stream", on_file: on_file as IStreamStorage["on_file"] };
  } else if (typeof dir === "undefined") {
    return { kind: "disk", dir: null };
  } else if (typeof dir !== "string" || dir === "") {
    throw new TypeError("`storage.dir` is not a non-empty string");
  }
  return { kind: "disk", dir: resolve(dir) };
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
    file_filter = null,
    filtered = "reject",
    storage = "memory",
  } = checkObject(input, "options", optionNames);
  if (typeof throw_limits !== "boolean") {
    throw new TypeError("`throw_limits` is not a boolean");
  } else if (file_filter !== null && typeof file_filter !== "function") {
    throw new TypeError("`file_filter` is not a function");
  } else if (filtered !== "reject" && filtered !== "skip") {
    throw new TypeError('`filtered` is not "reject" or "skip"');
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
      file_filter: file_filter as IFileFilter | null,
      filtered,
      mode: checkStorage(storage),
    },
  };
}
