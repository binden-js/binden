import { Compression, type ICompressionOptions } from "../index.js";
import { deepStrictEqual, throws } from "node:assert";
import { suite, test } from "node:test";
import zlib from "node:zlib";

type IFactory =
  | "createBrotliCompress"
  | "createDeflate"
  | "createGzip"
  | "createZstdCompress";

/** Replaces a factory of `node:zlib` while `fn` runs */
async function replacing(
  name: IFactory,
  value: unknown,
  fn: () => Promise<void> | void,
): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(zlib, name);
  Object.defineProperty(zlib, name, { ...original, value });
  try {
    await fn();
  } finally {
    Object.defineProperty(zlib, name, original as PropertyDescriptor);
  }
}

const invalid = (options: unknown): ICompressionOptions =>
  options as ICompressionOptions;

suite("Options", () => {
  test("invalid options throw", () => {
    const formats = new TypeError(
      "`format` is not one of auto, br, deflate, gzip and zstd",
    );
    for (const format of ["compress", "identity", 1, null]) {
      throws(() => new Compression(invalid({ format })), formats);
    }
    throws(
      () => new Compression({ format: "gzip", encodings: ["gzip"] }),
      new TypeError("`encodings` applies to the `auto` format only"),
    );
    const encodings = new TypeError(
      "`encodings` is not a non-empty list of distinct codings (br, deflate, gzip, zstd)",
    );
    for (const value of [[], ["compress"], ["gzip", "gzip"], "gzip", null]) {
      throws(() => new Compression(invalid({ encodings: value })), encodings);
    }
    throws(
      () => new Compression(invalid({ threshold: "1" })),
      new TypeError("`threshold` is not a number"),
    );
    for (const threshold of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      throws(
        () => new Compression({ threshold }),
        new RangeError("`threshold` is not a non-negative integer"),
      );
    }
    throws(
      () => new Compression(invalid({ filter: true })),
      new TypeError("`filter` is not a function"),
    );
    throws(() => new Compression(invalid({ disabled: 1 })), TypeError);
  });

  test("zstd needs its API in `node:zlib`", async () => {
    await replacing("createZstdCompress", null, () => {
      const error = new TypeError(
        "zstd is not supported by this version of Node.js",
      );
      throws(() => new Compression({ format: "zstd" }), error);
      throws(() => new Compression({ encodings: ["gzip", "zstd"] }), error);
      // Not requested
      deepStrictEqual(new Compression().format, "auto");
      deepStrictEqual(new Compression({ format: "gzip" }).format, "gzip");
    });
  });
});
