import { deepEqual, ok } from "node:assert/strict";

import { Authorization } from "../../index.js";

suite("Authorization", () => {
  test("constructor", () => {
    const type = "Bearer";
    const credentials = "credentials";
    const authorization = new Authorization({ type, credentials });
    deepEqual(authorization.type, type);
    deepEqual(authorization.credentials, credentials);
    deepEqual(authorization.toString(), `${type} ${credentials}`);
  });

  test("constructor (no `credentials`)", () => {
    const type = "AWS4-HMAC-SHA256";
    const authorization = new Authorization({ type });
    deepEqual(authorization.type, type);
    deepEqual(authorization.credentials, null);
    deepEqual(authorization.toString(), type);
  });

  test("Authorization.fromString()", () => {
    deepEqual(Authorization.fromString(), null);
    deepEqual(Authorization.fromString(""), null);
    deepEqual(Authorization.fromString("invalittype"), null);
    const input = "Bearer credentials";
    const parsed = Authorization.fromString(input);
    ok(parsed);
    deepEqual(parsed.type, "Bearer");
    deepEqual(parsed.credentials, "credentials");
    deepEqual(parsed.toString(), input);
  });
});
