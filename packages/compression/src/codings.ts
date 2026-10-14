import zlib, {
  type BrotliOptions,
  type ZlibOptions,
  type ZstdOptions,
} from "node:zlib";
import type { Transform } from "node:stream";

/** A content coding that the compression produces */
export type ICompressEncodings = "br" | "deflate" | "gzip" | "zstd";

/** Every content coding that the compression produces */
export const codings: readonly ICompressEncodings[] = [
  "br",
  "deflate",
  "gzip",
  "zstd",
];

/** The options of the compressor of every coding */
export interface ICompressorOptions {
  readonly br: BrotliOptions;
  readonly deflate: ZlibOptions;
  readonly gzip: ZlibOptions;
  readonly zstd: ZstdOptions;
}

/** A compressor of `node:zlib` */
export type ICompressor = Transform & zlib.Zlib;

/**
 * Whether `node:zlib` has zstd: it is read when called (not when imported),
 * so that the tests can take it away
 */
export function hasZstd(): boolean {
  return (
    typeof (zlib as Partial<typeof zlib>).createZstdCompress === "function"
  );
}

/** A compressor of a coding, with its options */
export function createCompressor(
  coding: ICompressEncodings,
  options: ICompressorOptions,
): ICompressor {
  if (coding === "br") {
    return zlib.createBrotliCompress(options.br);
  } else if (coding === "deflate") {
    return zlib.createDeflate(options.deflate);
  } else if (coding === "gzip") {
    return zlib.createGzip(options.gzip);
  }
  return zlib.createZstdCompress(options.zstd);
}

/**
 * The flush of a coding that ends its compressed data so far, without
 * ending the stream: the client can decompress everything written before
 */
export function flushKind(coding: ICompressEncodings): number {
  const { constants } = zlib;
  if (coding === "br") {
    return constants.BROTLI_OPERATION_FLUSH;
  } else if (coding === "zstd") {
    return constants.ZSTD_e_flush;
  }
  return constants.Z_SYNC_FLUSH;
}
