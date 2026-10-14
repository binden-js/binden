import type { Transform } from "node:stream";
import zlib from "node:zlib";

/** A content coding that the compression produces */
export type ICompressEncodings = "br" | "deflate" | "gzip" | "zstd";

/** Every content coding that the compression produces */
export const codings: readonly ICompressEncodings[] = [
  "br",
  "deflate",
  "gzip",
  "zstd",
];

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

/** A compressor of a coding */
export function createCompressor(coding: ICompressEncodings): ICompressor {
  if (coding === "br") {
    return zlib.createBrotliCompress();
  } else if (coding === "deflate") {
    return zlib.createDeflate();
  } else if (coding === "gzip") {
    return zlib.createGzip();
  }
  return zlib.createZstdCompress();
}
