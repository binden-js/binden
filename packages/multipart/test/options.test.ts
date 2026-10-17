import { body, part, post, serve } from "./helpers.js";
import { deepEqual, equal, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import multipart, { type IMultipartOptions, Multipart } from "../index.js";
import type { Context } from "binden";

/** A middleware that keeps the fields and the names of the files */
function keep(parsed: unknown[]): (context: Context) => Promise<void> {
  return async (context: Context): Promise<void> => {
    for (const [name, value] of context.request.body as FormData) {
      parsed.push([name, typeof value === "string" ? value : value.name]);
    }
    await context.send();
  };
}

describe("Multipart (options)", () => {
  it("refuses invalid options", () => {
    const invalid: [unknown, Error][] = [
      [null, new TypeError("`options` is not an object")],
      [[], new TypeError("`options` is not an object")],
      [{ limits: {} }, new TypeError("Unknown option: `options.limits`")],
      [{ disabled: 1 }, new TypeError("`disabled` is not a boolean")],
      [
        { throw_limits: "no" },
        new TypeError("`throw_limits` is not a boolean"),
      ],
      [{ limit: "1" }, new TypeError("`limit` is not a number")],
      ...[-1, 0.5, Number.NaN, Number.NEGATIVE_INFINITY].map(
        (limit): [unknown, Error] => [
          { limit },
          new RangeError("`limit` is not a non-negative integer"),
        ],
      ),
      [{ config: null }, new TypeError("`config` is not an object")],
      [
        { config: { limit: 1 } },
        new TypeError("Unknown option: `config.limit`"),
      ],
      [
        { config: { limits: 1 } },
        new TypeError("`config.limits` is not an object"),
      ],
      [
        { config: { limits: { fileSizes: 1 } } },
        new TypeError("Unknown option: `config.limits.fileSizes`"),
      ],
      [
        { config: { limits: { fileSize: "1" } } },
        new TypeError("`config.limits.fileSize` is not a number"),
      ],
      [
        { config: { limits: { parts: -1 } } },
        new RangeError("`config.limits.parts` is not a non-negative integer"),
      ],
      [
        { config: { highWaterMark: Number.POSITIVE_INFINITY } },
        new RangeError("`config.highWaterMark` is not a non-negative integer"),
      ],
      [
        { config: { fileHwm: "1" } },
        new TypeError("`config.fileHwm` is not a number"),
      ],
      [
        { config: { defCharset: "koi8-r" } },
        new RangeError(
          "`config.defCharset` is not a charset that busboy decodes",
        ),
      ],
      [
        { config: { defParamCharset: 8 } },
        new TypeError("`config.defParamCharset` is not a string"),
      ],
      [
        { config: { preservePath: 1 } },
        new TypeError("`config.preservePath` is not a boolean"),
      ],
    ];
    for (const [options, error] of invalid) {
      throws(() => new Multipart(options as IMultipartOptions), error);
    }
  });

  it("accepts valid options", () => {
    const parser = new Multipart({
      disabled: true,
      ignore_errors: true,
      throw_limits: false,
      limit: Number.POSITIVE_INFINITY,
      config: {
        limits: {
          fieldNameSize: 100,
          fieldSize: 0,
          fields: Number.POSITIVE_INFINITY,
          // Unset
          fileSize: new Map<string, number>().get("fileSize"),
          files: 1,
          parts: 2,
          headerPairs: 2000,
        },
        highWaterMark: 0,
        fileHwm: 1024,
        defCharset: "UTF-8",
        defParamCharset: "latin1",
        preservePath: false,
      },
    });
    deepEqual([parser.disabled, parser.ignore_errors], [true, true]);
    equal(multipart().disabled, false);
  });

  it("is created by the default export of the options", async (t) => {
    const parsed: unknown[] = [];
    const { url } = await serve(t, [
      multipart({ throw_limits: false, config: { limits: { fields: 1 } } }),
      keep(parsed),
    ]);

    const reply = await post(
      url,
      body(part('name="a"', "1"), part('name="b"', "2")),
    );

    equal(reply.status, 200);
    deepEqual(parsed, [["a", "1"]]);
  });

  it("ignores the `headers` of `config`", async (t) => {
    const parsed: unknown[] = [];
    const headers = { "content-type": "text/plain" };
    const config = { headers } as IMultipartOptions["config"];
    const { url } = await serve(t, [multipart({ config }), keep(parsed)]);

    const reply = await post(url, body(part('name="a"', "1")));

    equal(reply.status, 200);
    deepEqual(parsed, [["a", "1"]]);
  });

  it("decodes the parameters of the parts as UTF-8 by default", async (t) => {
    const parsed: unknown[] = [];
    const latin1: unknown[] = [];
    const { url } = await serve(t, [multipart(), keep(parsed)]);
    const other = await serve(t, [
      multipart({ config: { defParamCharset: "latin1" } }),
      keep(latin1),
    ]);
    const data = Buffer.from(
      body(
        part('name="поле"', "значение"),
        part('name="файл"; filename="файл.txt"', "…"),
      ),
    );

    deepEqual(
      [(await post(url, data)).status, (await post(other.url, data)).status],
      [200, 200],
    );
    deepEqual(parsed, [
      ["поле", "значение"],
      ["файл", "файл.txt"],
    ]);
    deepEqual(latin1, [
      [Buffer.from("поле").toString("latin1"), "значение"],
      [
        Buffer.from("файл").toString("latin1"),
        // Without the control characters (e.g. `\x84`) of latin1
        Buffer.from("файл.txt")
          .toString("latin1")
          .replaceAll(/\p{Cc}/gu, ""),
      ],
    ]);
  });

  it("passes the charsets and `preservePath` to busboy", async (t) => {
    const parsed: unknown[] = [];
    const { url } = await serve(t, [
      multipart({ config: { defCharset: "latin1", preservePath: true } }),
      keep(parsed),
    ]);

    const reply = await post(
      url,
      Buffer.from(
        body(part('name="a"', "é"), part('name="b"; filename="d/b.txt"', "")),
      ),
    );

    equal(reply.status, 200);
    deepEqual(parsed, [
      ["a", Buffer.from("é").toString("latin1")],
      ["b", "d/b.txt"],
    ]);
  });
});
