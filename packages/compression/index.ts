import {
  BindenResponse,
  type ContentType,
  type Context,
  type IMiddlewareParams,
  Middleware,
} from "binden";
import { CompressedResponse, type ISettings, skip } from "./src/response.js";
import { type ICompressEncodings, codings, hasZstd } from "./src/codings.js";
import { type ICompressionFilter, isCompressible } from "./src/filter.js";

export { type ICompressionFilter, isCompressible } from "./src/filter.js";
export type { ICompressEncodings } from "./src/codings.js";

/** The preferred content coding: the first of the default `encodings` */
export const DefaultCompression = "br";

/** The `format` of a compression: `auto` negotiates it, the others are fixed */
export type ICompressFormats = ICompressEncodings | "auto";

/** The options of a `Compression` */
export interface ICompressionOptions extends IMiddlewareParams {
  /**
   * The content coding: `auto` (the default) negotiates it with
   * `Accept-Encoding` among `encodings`; a fixed one compresses every response
   * that may be compressed, whatever the request accepts
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
   * valid one), called synchronously when its headers are committed: it must
   * return a boolean, anything else (e.g. a promise) is a configuration error
   * that replaces the response with `500`. `isCompressible()` by default.
   */
  filter?: ICompressionFilter | undefined;
}

const formats: readonly unknown[] = ["auto", ...codings];

const defaultEncodings: readonly ICompressEncodings[] = [
  "br",
  "gzip",
  "deflate",
];

/** The codings of `encodings`: a non-empty list of distinct codings */
function checkEncodings(encodings: unknown): readonly ICompressEncodings[] {
  if (
    !Array.isArray(encodings) ||
    encodings.length === 0 ||
    !encodings.every((coding) =>
      codings.includes(coding as ICompressEncodings),
    ) ||
    new Set(encodings).size !== encodings.length
  ) {
    throw new TypeError(
      "`encodings` is not a non-empty list of distinct codings (br, deflate, gzip, zstd)",
    );
  }
  return Object.freeze([...(encodings as ICompressEncodings[])]);
}

/**
 * Compresses the responses (`br`, `gzip`, `deflate` and `zstd`). The decision
 * is taken for each response when its headers are committed: see the README.
 */
export class Compression extends Middleware {
  readonly #settings: ISettings;

  /**
   * Validates the options: a `TypeError` (or `RangeError`) for an invalid one,
   * also for `zstd` when `node:zlib` does not have it
   */
  public constructor(options: ICompressionOptions = {}) {
    const {
      format = "auto",
      encodings,
      threshold = 1024,
      filter = (_context: Context, type: ContentType | null): boolean =>
        isCompressible(type),
      ...rest
    } = options;
    super(rest);
    if (!formats.includes(format)) {
      throw new TypeError(
        "`format` is not one of auto, br, deflate, gzip and zstd",
      );
    } else if (typeof encodings !== "undefined" && format !== "auto") {
      throw new TypeError("`encodings` applies to the `auto` format only");
    } else if (typeof threshold !== "number") {
      throw new TypeError("`threshold` is not a number");
    } else if (!Number.isSafeInteger(threshold) || threshold < 0) {
      throw new RangeError("`threshold` is not a non-negative integer");
    } else if (typeof filter !== "function") {
      throw new TypeError("`filter` is not a function");
    }
    const offered =
      typeof encodings === "undefined"
        ? defaultEncodings
        : checkEncodings(encodings);
    const used = format === "auto" ? offered : [format];
    if (used.includes("zstd") && !hasZstd()) {
      throw new TypeError("zstd is not supported by this version of Node.js");
    }

    this.#settings = Object.freeze({
      format,
      encodings: offered,
      threshold,
      filter,
    });
  }

  /** The `format` of the compression */
  public get format(): ICompressFormats {
    return this.#settings.format;
  }

  /**
   * Installs the compression on the response, unless its headers have been
   * sent (it is then left as it is) or a compression is installed on it
   * already: the decision is taken when its headers are committed
   */
  public run(context: Context): void {
    CompressedResponse.install(context, this.#settings);
  }
}

/**
 * Leaves one response uncompressed (e.g. a stream that must not wait in a
 * compressor): call it before its headers are committed
 */
export function skipCompression(response: BindenResponse): void {
  if (!(response instanceof BindenResponse)) {
    throw new TypeError("The response is not a `BindenResponse`");
  }
  skip(response);
}

/** A compression with the default options */
export default new Compression();
