import {
  BindenResponse,
  type ContentType,
  type Context,
  type IMiddlewareParams,
  Middleware,
  described,
  formatStack,
  formatting,
} from "binden";
import { CompressedResponse, type ISettings, skip } from "./src/response.js";
import {
  type ICompressEncodings,
  type ICompressorOptions,
  codings,
  createCompressor,
  hasZstd,
} from "./src/codings.js";
import { type ICompressionFilter, isCompressible } from "./src/filter.js";
import zlib, {
  type BrotliOptions,
  type ZlibOptions,
  type ZstdOptions,
} from "node:zlib";

export { type ICompressionFilter, isCompressible } from "./src/filter.js";
export type { ICompressEncodings } from "./src/codings.js";

/** The `format` of a compression: `auto` negotiates it, the others are fixed */
export type ICompressFormats = ICompressEncodings | "auto";

/** The options of a `Compression` */
export interface ICompressionOptions extends IMiddlewareParams {
  /**
   * The content coding: `auto` (the default) negotiates it with
   * `Accept-Encoding` among `encodings`; a fixed one is the only coding
   * offered (the request must accept it)
   */
  format?: ICompressFormats | undefined;
  /**
   * The codings that `auto` offers, the preferred first (`["br", "gzip",
   * "deflate"]`): `zstd` is offered only when listed
   */
  encodings?: readonly ICompressEncodings[] | undefined;
  /**
   * The `Content-Length` (in bytes) below which a response is not compressed
   * (`1024`); a response without one is compressed
   */
  threshold?: number | undefined;
  /**
   * Whether a response is compressed, by its `Content-Type` (`null` without a
   * valid one), called synchronously once, when its representation is chosen
   * (see the README): it must return a boolean, anything else (e.g. a
   * promise) is a configuration error that replaces the response with `500`.
   * `isCompressible()` by default.
   */
  filter?: ICompressionFilter | undefined;
  /** The options of the `gzip` compressor */
  gzip?: ZlibOptions | undefined;
  /** The options of the `deflate` compressor */
  deflate?: ZlibOptions | undefined;
  /** The options of the `br` compressor (`BROTLI_PARAM_QUALITY` is `4` by default) */
  brotli?: BrotliOptions | undefined;
  /** The options of the `zstd` compressor */
  zstd?: ZstdOptions | undefined;
}

const formats: readonly unknown[] = ["auto", ...codings];

const defaultEncodings: readonly ICompressEncodings[] = [
  "br",
  "gzip",
  "deflate",
];

/** Throws a `TypeError` unless the option is an object (or not set) */
function checkObject(name: string, value: unknown): void {
  if (
    typeof value !== "undefined" &&
    (typeof value !== "object" || value === null || Array.isArray(value))
  ) {
    throw formatStack(new TypeError(`\`${name}\` is not an object`));
  }
}

/**
 * The codings of `encodings`: a non-empty list of distinct codings, read once
 * (by its indexes), whose copy is checked and kept
 */
function checkEncodings(encodings: unknown): readonly ICompressEncodings[] {
  const copy: unknown[] = [];
  if (Array.isArray(encodings)) {
    const { length } = encodings;
    for (let index = 0; index < length; index += 1) {
      copy.push(encodings[index]);
    }
  }
  if (
    copy.length === 0 ||
    !copy.every((coding) => codings.includes(coding as ICompressEncodings)) ||
    new Set(copy).size !== copy.length
  ) {
    throw formatStack(
      new TypeError(
        "`encodings` is not a non-empty list of distinct codings (br, deflate, gzip, zstd)",
      ),
    );
  }
  return Object.freeze(copy as ICompressEncodings[]);
}

/** The options of a `Compression`, each read once (see `readOptions()`) */
interface IReadOptions {
  readonly format: ICompressFormats;
  readonly encodings: readonly ICompressEncodings[] | undefined;
  readonly threshold: number;
  readonly filter: ICompressionFilter;
  readonly gzip: ZlibOptions;
  readonly deflate: ZlibOptions;
  readonly brotli: BrotliOptions;
  readonly zstd: ZstdOptions;
  readonly rest: IMiddlewareParams;
}

/**
 * Reads the options of a `Compression` once, with their defaults: anything but
 * an object (or `undefined`, the defaults) is refused with a `TypeError`
 * before anything is read, which describes it (see `described()`)
 */
function readOptions(options: unknown): IReadOptions {
  if (typeof options !== "object" || options === null) {
    throw formatStack(
      new TypeError(`\`options\` is not an object: ${described(options)}`),
    );
  }
  const {
    format = "auto",
    encodings,
    threshold = 1024,
    filter = (_context: Context, type: ContentType | null): boolean =>
      isCompressible(type),
    gzip = {},
    deflate = {},
    brotli = {},
    zstd = {},
    ...rest
  } = options as ICompressionOptions;
  return {
    format,
    encodings,
    threshold,
    filter,
    gzip,
    deflate,
    brotli,
    zstd,
    rest,
  };
}

/**
 * Compresses the responses (`br`, `gzip`, `deflate` and `zstd`). The decision
 * is taken once for each response, before its preconditions are evaluated or
 * when its headers are committed: see the README.
 */
export class Compression extends Middleware {
  readonly #settings: ISettings;

  /**
   * Validates the options: a `TypeError` (or `RangeError`) for an invalid one,
   * also for the options of a compressor (one is created to check them), or
   * for `zstd` when `node:zlib` does not have it. What reading them throws
   * (e.g. a revoked proxy, or a getter that throws) is formatted (see
   * `formatting()`).
   */
  public constructor(options: ICompressionOptions = {}) {
    const read = formatting(() => readOptions(options));
    super(read.rest);
    this.#settings = formatting(() => Compression.#settingsOf(read));
  }

  /** The settings of the options (see `IReadOptions`), validated */
  static #settingsOf({
    format,
    encodings,
    threshold,
    filter,
    gzip,
    deflate,
    brotli,
    zstd,
  }: IReadOptions): ISettings {
    if (!formats.includes(format)) {
      throw formatStack(
        new TypeError(
          "`format` is not one of auto, br, deflate, gzip and zstd",
        ),
      );
    } else if (typeof encodings !== "undefined" && format !== "auto") {
      throw formatStack(
        new TypeError("`encodings` applies to the `auto` format only"),
      );
    } else if (typeof threshold !== "number") {
      throw formatStack(new TypeError("`threshold` is not a number"));
    } else if (!Number.isSafeInteger(threshold) || threshold < 0) {
      throw formatStack(
        new RangeError("`threshold` is not a non-negative integer"),
      );
    } else if (typeof filter !== "function") {
      throw formatStack(new TypeError("`filter` is not a function"));
    }
    checkObject("gzip", gzip);
    checkObject("deflate", deflate);
    checkObject("brotli", brotli);
    checkObject("zstd", zstd);

    const offered =
      typeof encodings === "undefined"
        ? defaultEncodings
        : checkEncodings(encodings);
    const used = format === "auto" ? offered : [format];
    if (used.includes("zstd") && !hasZstd()) {
      throw formatStack(
        new TypeError("zstd is not supported by this version of Node.js"),
      );
    }

    // Each read once: `params` of `brotli` is copied with its own defaults,
    // and the one of `zstd` as it is (`node:zlib` reads it for every
    // compressor, which must not read the object of the application)
    const { params, ...others } = brotli;
    const { params: zstdParams, ...zstdOthers } = zstd;
    const compressors: ICompressorOptions = Object.freeze({
      br: {
        ...others,
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
          ...params,
        },
      },
      deflate: { ...deflate },
      gzip: { ...gzip },
      zstd: { ...zstdOthers, params: { ...zstdParams } },
    });
    // Invalid options of a compressor throw now, rather than with a request
    for (const coding of used) {
      createCompressor(coding, compressors).close();
    }

    return Object.freeze({
      format,
      encodings: offered,
      threshold,
      filter,
      compressors,
    });
  }

  /** The `format` of the compression */
  public get format(): ICompressFormats {
    return this.#settings.format;
  }

  /**
   * Installs the compression on the response, unless its headers have been
   * sent (it is then left as it is), a compression is installed on it
   * already, or the work that runs it may no longer mutate the response
   * (e.g. once its deadline has passed): the decision is taken when its
   * representation is chosen (by `sendFile()`, the dynamic `ETag` of binden
   * and a `send()` that does not read its stream), or else when its headers
   * are committed
   */
  public run(context: Context): void {
    // What reading the context throws is formatted (see `formatStack()`)
    try {
      CompressedResponse.install(context, this.#settings);
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }
}

/**
 * Leaves one response uncompressed (e.g. a stream that must not wait in a
 * compressor): call it before its reply starts (`send()`, `sendFile()`, or a
 * first write), which may choose its representation at once. Ignored once the
 * work that calls it may no longer mutate the response.
 */
export function skipCompression(response: BindenResponse): void {
  // What reading it throws (e.g. a revoked proxy) is formatted (see
  // `formatting()`)
  formatting(() => {
    if (!(response instanceof BindenResponse)) {
      throw formatStack(
        new TypeError("The response is not a `BindenResponse`"),
      );
    }
    skip(response);
  });
}

/** A compression with the default options */
export default new Compression();
