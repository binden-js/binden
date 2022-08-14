import { deepStrictEqual, ok, throws } from "node:assert";

import { ContentType } from "../../index.js";

suite("ContentType", () => {
  test("constructor", () => {
    const type = "video/mp4";
    const ct = new ContentType({ type });
    deepStrictEqual(ct.type, type);
    deepStrictEqual(ct.charset, null);
    deepStrictEqual(ct.boundary, null);
    deepStrictEqual(ct.toString(), type);

    throws(
      () => new ContentType({ type: "multipart/form-data" }),
      new TypeError("`boundary` is missing")
    );
  });

  test("constructor(with charset)", () => {
    const type = "plain/text";
    const charset = "UTF-8";
    const boundary = "__boundary";
    const ct = new ContentType({ type, charset, boundary });
    deepStrictEqual(ct.type, type);
    deepStrictEqual(ct.charset, charset);
    deepStrictEqual(ct.boundary, null);
    deepStrictEqual(ct.toString(), `${type}; charset=${charset}`);
  });

  test("constructor(with boundary)", () => {
    const type = "multipart/form-data";
    const charset = "UTF-8";
    const boundary = "__boundary";
    const ct = new ContentType({ type, charset, boundary });
    deepStrictEqual(ct.type, type);
    deepStrictEqual(ct.charset, null);
    deepStrictEqual(ct.boundary, boundary);
    deepStrictEqual(ct.toString(), `${type}; boundary=${boundary}`);
  });

  test("ContentType.fromString()", () => {
    const input = ` text/html `;
    const parsed = ContentType.fromString(input);
    ok(parsed);
    deepStrictEqual(parsed.type, "text/html");
    deepStrictEqual(parsed.charset, null);
    deepStrictEqual(parsed.boundary, null);
    deepStrictEqual(parsed.toString(), "text/html");
  });

  test("ContentType.fromString() (charset)", () => {
    const input = ` text/html ;   charset  =  utf-8  `;
    const parsed = ContentType.fromString(input);
    ok(parsed);
    deepStrictEqual(parsed.type, "text/html");
    deepStrictEqual(parsed.charset, "utf-8");
    deepStrictEqual(parsed.boundary, null);
    deepStrictEqual(parsed.toString(), "text/html; charset=utf-8");
  });

  test("ContentType.fromString() (with quoted charset)", () => {
    const input = ` text/html ;   charset  =  "UtF-8"  `;
    const parsed = ContentType.fromString(input);
    ok(parsed);
    deepStrictEqual(parsed.type, "text/html");
    deepStrictEqual(parsed.charset, "utf-8");
    deepStrictEqual(parsed.boundary, null);
    deepStrictEqual(parsed.toString(), "text/html; charset=utf-8");
  });

  test("ContentType.fromString() (with boudary)", () => {
    const input = `  multipart/form-data  ; boundary  =  something  `;
    const parsed = ContentType.fromString(input);
    ok(parsed);
    deepStrictEqual(parsed.type, "multipart/form-data");
    deepStrictEqual(parsed.charset, null);
    deepStrictEqual(parsed.boundary, "something");
    deepStrictEqual(
      parsed.toString(),
      "multipart/form-data; boundary=something"
    );
  });

  test("ContentType.fromString() (with empty charset)", () => {
    const input = `plain/text; charset=""`;
    const parsed = ContentType.fromString(input);
    ok(parsed);
    deepStrictEqual(parsed.type, "plain/text");
    deepStrictEqual(parsed.boundary, null);
    deepStrictEqual(parsed.charset, null);
    deepStrictEqual(parsed.toString(), "plain/text");
  });

  test("ContentType.fromString() (invalid input)", () => {
    deepStrictEqual(ContentType.fromString(), null);
    deepStrictEqual(ContentType.fromString(""), null);
    deepStrictEqual(ContentType.fromString(";"), null);
    deepStrictEqual(ContentType.fromString(`  multipart/form-data   `), null);
  });
});
