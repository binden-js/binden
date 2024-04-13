import { deepEqual, ok } from "node:assert/strict";
import { describe, it } from "node:test";

import { Authorization } from "../../index.js";

describe("Authorization", () => {
  it("constructor", () => {
    const type = "Bearer";
    const credentials = "credentials";
    const authorization = new Authorization({ type, credentials });
    deepEqual(authorization.type, type);
    deepEqual(authorization.credentials, credentials);
    deepEqual(authorization.toString(), `${type} ${credentials}`);
  });

  it("constructor (no `credentials`)", () => {
    const type = "AWS4-HMAC-SHA256";
    const authorization = new Authorization({ type });
    deepEqual(authorization.type, type);
    deepEqual(authorization.credentials, null);
    deepEqual(authorization.toString(), type);
  });

  it("Authorization.fromString()", () => {
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
