import { deepStrictEqual, ok, throws } from "node:assert";
import { suite, test } from "node:test";

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
      new TypeError("`boundary` is missing"),
    );
  });

  test("constructor (`multipart/form-data` in any case)", () => {
    // A media type is case-insensitive (RFC 9110, section 8.3.1)
    for (const type of ["Multipart/Form-Data", "MULTIPART/FORM-DATA"]) {
      throws(
        () => new ContentType({ type }),
        new TypeError("`boundary` is missing"),
        type,
      );
      const ct = new ContentType({ type, boundary: "b", charset: "utf-8" });
      deepStrictEqual(ct.boundary, "b");
      deepStrictEqual(ct.charset, null);
      deepStrictEqual(ct.toString(), `${type}; boundary=b`);
      // Parsed back
      deepStrictEqual(ContentType.fromString(ct.toString())?.parameters, {
        boundary: "b",
      });
    }
  });

  test("constructor(with charset)", () => {
    const type = "text/plain";
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
      "multipart/form-data; boundary=something",
    );
  });

  test("ContentType.fromString() (with empty charset)", () => {
    const input = `text/plain; charset=""`;
    const parsed = ContentType.fromString(input);
    ok(parsed);
    deepStrictEqual(parsed.type, "text/plain");
    deepStrictEqual(parsed.boundary, null);
    deepStrictEqual(parsed.charset, null);
    deepStrictEqual(parsed.toString(), "text/plain");
  });

  test("ContentType.fromString() (invalid input)", () => {
    deepStrictEqual(ContentType.fromString(), null);
    deepStrictEqual(ContentType.fromString(""), null);
    deepStrictEqual(ContentType.fromString(";"), null);
    deepStrictEqual(ContentType.fromString(`  multipart/form-data   `), null);
  });

  test(".fromString() (parameters, RFC 9110, section 5.6.6)", () => {
    const parse = (
      input: string,
    ): [string, string | null, string | null] | null => {
      const parsed = ContentType.fromString(input);
      return parsed ? [parsed.type, parsed.charset, parsed.boundary] : null;
    };
    const form = "multipart/form-data";

    // In any position, with case-insensitive names
    deepStrictEqual(parse(`${form}; charset=utf-8; boundary=xyz`), [
      form,
      null,
      "xyz",
    ]);
    deepStrictEqual(parse(`${form}; BOUNDARY=xyz`), [form, null, "xyz"]);
    deepStrictEqual(parse("text/plain; format=flowed; charset=UTF-8"), [
      "text/plain",
      "utf-8",
      null,
    ]);
    // Quoted strings (RFC 9110, section 5.6.4)
    deepStrictEqual(parse(`${form}; boundary="----=_Part_0"`), [
      form,
      null,
      "----=_Part_0",
    ]);
    deepStrictEqual(parse(`${form}; boundary="a;b"; charset=x`), [
      form,
      null,
      "a;b",
    ]);
    deepStrictEqual(parse(`${form}; boundary="a\\"b"`), [form, null, `a"b`]);
    // The first of a repeated parameter
    deepStrictEqual(parse(`${form}; boundary=one; boundary=two`), [
      form,
      null,
      "one",
    ]);
    // No value
    deepStrictEqual(parse(`${form}; boundary=; charset=utf-8`), null);
    deepStrictEqual(parse(`${form}; boundary`), null);
  });

  test(".toString() (quotes a boundary that is not a token)", () => {
    const type = "multipart/form-data";
    deepStrictEqual(
      new ContentType({ type, boundary: "----=_Part_0" }).toString(),
      `${type}; boundary="----=_Part_0"`,
    );
    deepStrictEqual(
      new ContentType({ type, boundary: `a"b` }).toString(),
      `${type}; boundary="a\\"b"`,
    );
    deepStrictEqual(
      new ContentType({ type, boundary: "token" }).toString(),
      `${type}; boundary=token`,
    );
  });

  test("constructor (invalid input)", () => {
    for (const type of ["text", "text/plain; x=y", "te xt/plain", ""]) {
      throws(
        () => new ContentType({ type }),
        new TypeError(`Invalid media type: ${type}`),
      );
    }
    throws(
      () => new ContentType({ type: "text/plain", parameters: { "a b": "c" } }),
      new TypeError("Invalid parameter name: a b"),
    );
    throws(
      () => new ContentType({ type: "text/plain", charset: "utf-8\r\nX: y" }),
      new TypeError("Invalid value of the parameter charset"),
    );
  });

  test("parameters (quoted when they are not tokens)", () => {
    // The value of `charset` cannot add a parameter
    const injected = new ContentType({
      type: "text/plain",
      charset: "utf-8; boundary=attacker",
    });
    deepStrictEqual(
      injected.toString(),
      `text/plain; charset="utf-8; boundary=attacker"`,
    );
    deepStrictEqual(ContentType.fromString(injected.toString())?.parameters, {
      charset: "utf-8; boundary=attacker",
    });

    // Every parameter is kept, by its name in lowercase
    const parsed = ContentType.fromString(
      "text/plain; Format=flowed; charset=UTF-8; delsp=yes; a b=c",
    );
    deepStrictEqual(parsed?.parameters, {
      format: "flowed",
      charset: "utf-8",
      delsp: "yes",
    });
    deepStrictEqual(
      parsed.toString(),
      "text/plain; format=flowed; charset=utf-8; delsp=yes",
    );
    deepStrictEqual(
      new ContentType({
        type: "text/plain",
        parameters: { Format: "flowed", format: "fixed" },
      }).toString(),
      "text/plain; format=flowed",
    );
    // Not a media type
    deepStrictEqual(ContentType.fromString("text"), null);
  });
});
