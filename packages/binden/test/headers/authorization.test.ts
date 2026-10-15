import { Authorization, type IAuthenticationType } from "../../index.js";
import { deepStrictEqual, ok, throws } from "node:assert";
import { suite, test } from "node:test";

suite("Authorization", () => {
  test("constructor", () => {
    const type = "Bearer";
    const credentials = "credentials";
    const authorization = new Authorization({ type, credentials });
    deepStrictEqual(authorization.type, type);
    deepStrictEqual(authorization.credentials, credentials);
    deepStrictEqual(authorization.toString(), `${type} ${credentials}`);
  });

  test("constructor (no `credentials`)", () => {
    const type = "AWS4-HMAC-SHA256";
    const authorization = new Authorization({ type });
    deepStrictEqual(authorization.type, type);
    deepStrictEqual(authorization.credentials, null);
    deepStrictEqual(authorization.toString(), type);
  });

  test("constructor (invalid input)", () => {
    // Like the parser: a supported scheme in its usual casing
    for (const type of ["bearer", "Unknown", "Bearer abc", ""]) {
      throws(
        () => new Authorization({ type: type as IAuthenticationType }),
        new TypeError(`Unsupported authentication scheme: ${type}`),
      );
    }
    // Credentials that a field value can carry, without surrounding whitespace
    for (const credentials of [
      "",
      " abc",
      "abc ",
      "a\r\nb",
      "a\u0000b",
      "\u20AC",
    ]) {
      throws(
        () => new Authorization({ type: "Bearer", credentials }),
        new TypeError("Invalid credentials"),
        JSON.stringify(credentials),
      );
    }
    deepStrictEqual(
      new Authorization({ type: "Digest", credentials: `a="b c",\td=\xE9` })
        .credentials,
      `a="b c",\td=\xE9`,
    );
  });

  test("Authorization.fromString()", () => {
    deepStrictEqual(Authorization.fromString(), null);
    deepStrictEqual(Authorization.fromString(""), null);
    deepStrictEqual(Authorization.fromString("invalittype"), null);
    const input = "Bearer credentials";
    const parsed = Authorization.fromString(input);
    ok(parsed);
    deepStrictEqual(parsed.type, "Bearer");
    deepStrictEqual(parsed.credentials, "credentials");
    deepStrictEqual(parsed.toString(), input);
  });

  test("Authorization.fromString() (RFC 9110, section 11.4)", () => {
    const parse = (input: string): [string, string | null] | null => {
      const parsed = Authorization.fromString(input);
      return parsed ? [parsed.type, parsed.credentials] : null;
    };

    // The scheme is case-insensitive
    deepStrictEqual(parse("bearer abc"), ["Bearer", "abc"]);
    deepStrictEqual(parse("BASIC x"), ["Basic", "x"]);
    // The credentials are the rest of the field
    deepStrictEqual(parse("Bearer  abc"), ["Bearer", "abc"]);
    deepStrictEqual(parse(`Digest username="Mufasa", realm="x"`), [
      "Digest",
      `username="Mufasa", realm="x"`,
    ]);
    deepStrictEqual(parse("Bearer"), ["Bearer", null]);
    deepStrictEqual(Authorization.fromString("Bearer")?.toString(), "Bearer");
    // Not a scheme
    deepStrictEqual(parse("Bearer\tabc"), null);
    deepStrictEqual(parse("Bear er abc"), null);
    // Credentials that the constructor refuses
    deepStrictEqual(parse("Bearer a\u0001b"), null);
  });

  test("Authorization.isValidType()", () => {
    // A type guard for the usual casing of the schemes
    ok(Authorization.isValidType("Bearer"));
    ok(Authorization.isValidType("AWS4-HMAC-SHA256"));
    ok(!Authorization.isValidType("bearer"));
    ok(!Authorization.isValidType("unknown"));
    ok(!Authorization.isValidType());
  });
});
