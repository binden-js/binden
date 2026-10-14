import { Compression, type ICompressionOptions } from "../index.js";
import { type IServed, fetchRaw, serve, text } from "./helpers.js";
import { afterEach, suite, test } from "node:test";
import { deepStrictEqual, throws } from "node:assert";
import type { Context } from "binden";
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

/** The options that a factory of `node:zlib` is given while `fn` runs */
async function optionsOf(
  name: IFactory,
  fn: () => Promise<void>,
): Promise<unknown[]> {
  const create = zlib[name] as (options?: unknown) => unknown;
  const given: unknown[] = [];
  await replacing(
    name,
    (options?: unknown): unknown => {
      given.push(options);
      return create(options);
    },
    fn,
  );
  return given;
}

const invalid = (options: unknown): ICompressionOptions =>
  options as ICompressionOptions;

suite("Options", () => {
  let served: IServed | null = null;

  afterEach(async () => {
    const current = served;
    served = null;
    await current?.close();
  });

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
    for (const name of ["gzip", "deflate", "brotli", "zstd"]) {
      for (const value of [null, 1, []]) {
        throws(
          () => new Compression(invalid({ [name]: value })),
          new TypeError(`\`${name}\` is not an object`),
        );
      }
    }
    throws(() => new Compression(invalid({ disabled: 1 })), TypeError);
  });

  test("the options of the compressors are checked by creating one", () => {
    throws(() => new Compression({ format: "gzip", gzip: { level: 99 } }), {
      name: "RangeError",
      code: "ERR_OUT_OF_RANGE",
    });
    throws(
      () => new Compression({ format: "deflate", deflate: { level: -2 } }),
      { code: "ERR_OUT_OF_RANGE" },
    );
    throws(() => new Compression({ brotli: { params: { 9999: 1 } } }), {
      code: "ERR_BROTLI_INVALID_PARAM",
    });
    throws(
      () =>
        new Compression({
          encodings: ["zstd"],
          zstd: { params: { 9999: 1 } },
        }),
      { code: "ERR_ZSTD_INVALID_PARAM" },
    );
    // The options of a coding that is not used
    deepStrictEqual(
      new Compression({ format: "br", gzip: { level: 99 } }).format,
      "br",
    );
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

  test("the compressors get their options (`br` with the quality 4 by default)", async () => {
    const { BROTLI_PARAM_QUALITY, ZSTD_c_compressionLevel } = zlib.constants;
    const body = text(2048);
    const gzip = { level: 1 };
    served = await serve(
      {},
      new Compression({
        encodings: ["br", "gzip", "deflate", "zstd"],
        gzip,
        deflate: { level: 9 },
        zstd: { params: { [ZSTD_c_compressionLevel]: 10 } },
      }),
      (context: Context) => context.text(body),
    );
    // Copied: a later change does not apply
    gzip.level = 9;

    const request = async (coding: string): Promise<void> => {
      const response = await fetchRaw((served as IServed).url, {
        headers: { "Accept-Encoding": coding },
      });
      deepStrictEqual(response.headers["content-encoding"], coding);
      deepStrictEqual(response.body, body);
    };
    deepStrictEqual(
      await optionsOf("createBrotliCompress", () => request("br")),
      [{ params: { [BROTLI_PARAM_QUALITY]: 4 } }],
    );
    deepStrictEqual(await optionsOf("createGzip", () => request("gzip")), [
      { level: 1 },
    ]);
    deepStrictEqual(
      await optionsOf("createDeflate", () => request("deflate")),
      [{ level: 9 }],
    );
    deepStrictEqual(
      await optionsOf("createZstdCompress", () => request("zstd")),
      [{ params: { [ZSTD_c_compressionLevel]: 10 } }],
    );
  });

  test("the options of `br` keep their parameters, and may set the quality", async () => {
    const { BROTLI_PARAM_QUALITY, BROTLI_PARAM_MODE } = zlib.constants;
    const body = text(2048);
    served = await serve(
      {},
      new Compression({
        format: "br",
        brotli: {
          chunkSize: 32 * 1024,
          params: { [BROTLI_PARAM_MODE]: 1, [BROTLI_PARAM_QUALITY]: 11 },
        },
      }),
      (context: Context) => context.text(body),
    );
    const { url } = served;
    const given = await optionsOf("createBrotliCompress", async () => {
      const response = await fetchRaw(url);
      deepStrictEqual(response.headers["content-encoding"], "br");
      deepStrictEqual(response.body, body);
    });

    deepStrictEqual(given, [
      {
        chunkSize: 32 * 1024,
        params: { [BROTLI_PARAM_MODE]: 1, [BROTLI_PARAM_QUALITY]: 11 },
      },
    ]);
  });
});
