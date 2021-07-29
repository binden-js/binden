import { deepStrictEqual, ok } from "assert";

import { Authorization } from "../../index.js";

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
    deepStrictEqual(typeof authorization.credentials, "undefined");
    deepStrictEqual(authorization.toString(), type);
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
});
