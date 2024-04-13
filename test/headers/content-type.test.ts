import { deepEqual, ok, throws } from "node:assert/strict";

import { ContentType } from "../../index.js";

suite("ContentType", () => {
  test("constructor", () => {
    const type = "video/mp4";
    const ct = new ContentType({ type });
    deepEqual(ct.type, type);
    deepEqual(ct.charset, null);
    deepEqual(ct.boundary, null);
    deepEqual(ct.toString(), type);

    throws(
      () => new ContentType({ type: "multipart/form-data" }),
      new TypeError("`boundary` is missing"),
    );
  });

  test("constructor(with charset)", () => {
    const type = "plain/text";
    const charset = "UTF-8";
    const boundary = "__boundary";
    const ct = new ContentType({ type, charset, boundary });
    deepEqual(ct.type, type);
    deepEqual(ct.charset, charset);
    deepEqual(ct.boundary, null);
    deepEqual(ct.toString(), `${type}; charset=${charset}`);
  });

  test("constructor(with boundary)", () => {
    const type = "multipart/form-data";
    const charset = "UTF-8";
    const boundary = "__boundary";
    const ct = new ContentType({ type, charset, boundary });
    deepEqual(ct.type, type);
    deepEqual(ct.charset, null);
    deepEqual(ct.boundary, boundary);
    deepEqual(ct.toString(), `${type}; boundary=${boundary}`);
  });

  test("ContentType.fromString()", () => {
    const input = ` text/html `;
    const parsed = ContentType.fromString(input);
    ok(parsed);
    deepEqual(parsed.type, "text/html");
    deepEqual(parsed.charset, null);
    deepEqual(parsed.boundary, null);
    deepEqual(parsed.toString(), "text/html");
  });

  test("ContentType.fromString() (charset)", () => {
    const input = ` text/html ;   charset  =  utf-8  `;
    const parsed = ContentType.fromString(input);
    ok(parsed);
    deepEqual(parsed.type, "text/html");
    deepEqual(parsed.charset, "utf-8");
    deepEqual(parsed.boundary, null);
    deepEqual(parsed.toString(), "text/html; charset=utf-8");
  });

  test("ContentType.fromString() (with quoted charset)", () => {
    const input = ` text/html ;   charset  =  "UtF-8"  `;
    const parsed = ContentType.fromString(input);
    ok(parsed);
    deepEqual(parsed.type, "text/html");
    deepEqual(parsed.charset, "utf-8");
    deepEqual(parsed.boundary, null);
    deepEqual(parsed.toString(), "text/html; charset=utf-8");
  });

  test("ContentType.fromString() (with boudary)", () => {
    const input = `  multipart/form-data  ; boundary  =  something  `;
    const parsed = ContentType.fromString(input);
    ok(parsed);
    deepEqual(parsed.type, "multipart/form-data");
    deepEqual(parsed.charset, null);
    deepEqual(parsed.boundary, "something");
    deepEqual(parsed.toString(), "multipart/form-data; boundary=something");
  });

  test("ContentType.fromString() (with empty charset)", () => {
    const input = `plain/text; charset=""`;
    const parsed = ContentType.fromString(input);
    ok(parsed);
    deepEqual(parsed.type, "plain/text");
    deepEqual(parsed.boundary, null);
    deepEqual(parsed.charset, null);
    deepEqual(parsed.toString(), "plain/text");
  });

  test("ContentType.fromString() (invalid input)", () => {
    deepEqual(ContentType.fromString(), null);
    deepEqual(ContentType.fromString(""), null);
    deepEqual(ContentType.fromString(";"), null);
    deepEqual(ContentType.fromString(`  multipart/form-data   `), null);
  });
});
