import { deepStrictEqual, ok } from "assert";

import { ContentType } from "../../index.js";

suite("ContentType", () => {
  test("constructor", () => {
    const type = "video/mp4";
    const ct = new ContentType({ type });
    deepStrictEqual(ct.type, type);
    deepStrictEqual(typeof ct.charset, "undefined");
    deepStrictEqual(typeof ct.boundary, "undefined");
    deepStrictEqual(ct.toString(), type);
  });

  test("constructor(with charset)", () => {
    const type = "plain/text";
    const charset = "UTF-8";
    const boundary = "__boundary";
    const ct = new ContentType({ type, charset, boundary });
    deepStrictEqual(ct.type, type);
    deepStrictEqual(ct.charset, charset);
    deepStrictEqual(typeof ct.boundary, "undefined");
    deepStrictEqual(ct.toString(), `${type}; charset=${charset}`);
  });

  test("constructor(with boundary)", () => {
    const type = "multipart/form-data";
    const charset = "UTF-8";
    const boundary = "__boundary";
    const ct = new ContentType({ type, charset, boundary });
    deepStrictEqual(ct.type, type);
    deepStrictEqual(typeof ct.charset, "undefined");
    deepStrictEqual(ct.boundary, boundary);
    deepStrictEqual(ct.toString(), `${type}; boundary=${boundary}`);
  });

  test("ContentType.fromString()", () => {
    const input = ` text/html ;   charset  =  "UtF-8"  `;
    const parsed = ContentType.fromString(input);
    ok(parsed);
    deepStrictEqual(parsed.type, "text/html");
    deepStrictEqual(parsed.charset, "utf-8");
    deepStrictEqual(typeof parsed.boundary, "undefined");
    deepStrictEqual(parsed.toString(), "text/html; charset=utf-8");
  });

  test("ContentType.fromString() (with boudary)", () => {
    const input = `  multipart/form-data  ; boundary  =  something  `;
    const parsed = ContentType.fromString(input);
    ok(parsed);
    deepStrictEqual(parsed.type, "multipart/form-data");
    deepStrictEqual(typeof parsed.charset, "undefined");
    deepStrictEqual(parsed.boundary, "something");
    deepStrictEqual(
      parsed.toString(),
      "multipart/form-data; boundary=something"
    );
  });

  test("ContentType.fromString() (invalid input)", () => {
    deepStrictEqual(ContentType.fromString(`  multipart/form-data   `), null);
  });
});
