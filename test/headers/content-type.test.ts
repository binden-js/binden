import { deepEqual, ok, throws } from "node:assert/strict";
import { describe, it } from "node:test";

import { ContentType } from "../../index.js";

describe("ContentType", () => {
  it("constructor", () => {
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

  it("constructor(with charset)", () => {
    const type = "plain/text";
    const charset = "UTF-8";
    const boundary = "__boundary";
    const ct = new ContentType({ type, charset, boundary });
    deepEqual(ct.type, type);
    deepEqual(ct.charset, charset);
    deepEqual(ct.boundary, null);
    deepEqual(ct.toString(), `${type}; charset=${charset}`);
  });

  it("constructor(with boundary)", () => {
    const type = "multipart/form-data";
    const charset = "UTF-8";
    const boundary = "__boundary";
    const ct = new ContentType({ type, charset, boundary });
    deepEqual(ct.type, type);
    deepEqual(ct.charset, null);
    deepEqual(ct.boundary, boundary);
    deepEqual(ct.toString(), `${type}; boundary=${boundary}`);
  });

  it("ContentType.fromString()", () => {
    const input = ` text/html `;
    const parsed = ContentType.fromString(input);
    ok(parsed);
    deepEqual(parsed.type, "text/html");
    deepEqual(parsed.charset, null);
    deepEqual(parsed.boundary, null);
    deepEqual(parsed.toString(), "text/html");
  });

  it("ContentType.fromString() (charset)", () => {
    const input = ` text/html ;   charset  =  utf-8  `;
    const parsed = ContentType.fromString(input);
    ok(parsed);
    deepEqual(parsed.type, "text/html");
    deepEqual(parsed.charset, "utf-8");
    deepEqual(parsed.boundary, null);
    deepEqual(parsed.toString(), "text/html; charset=utf-8");
  });

  it("ContentType.fromString() (with quoted charset)", () => {
    const input = ` text/html ;   charset  =  "UtF-8"  `;
    const parsed = ContentType.fromString(input);
    ok(parsed);
    deepEqual(parsed.type, "text/html");
    deepEqual(parsed.charset, "utf-8");
    deepEqual(parsed.boundary, null);
    deepEqual(parsed.toString(), "text/html; charset=utf-8");
  });

  it("ContentType.fromString() (with boudary)", () => {
    const input = `  multipart/form-data  ; boundary  =  something  `;
    const parsed = ContentType.fromString(input);
    ok(parsed);
    deepEqual(parsed.type, "multipart/form-data");
    deepEqual(parsed.charset, null);
    deepEqual(parsed.boundary, "something");
    deepEqual(parsed.toString(), "multipart/form-data; boundary=something");
  });

  it("ContentType.fromString() (with empty charset)", () => {
    const input = `plain/text; charset=""`;
    const parsed = ContentType.fromString(input);
    ok(parsed);
    deepEqual(parsed.type, "plain/text");
    deepEqual(parsed.boundary, null);
    deepEqual(parsed.charset, null);
    deepEqual(parsed.toString(), "plain/text");
  });

  it("ContentType.fromString() (invalid input)", () => {
    deepEqual(ContentType.fromString(), null);
    deepEqual(ContentType.fromString(""), null);
    deepEqual(ContentType.fromString(";"), null);
    deepEqual(ContentType.fromString(`  multipart/form-data   `), null);
  });
});
