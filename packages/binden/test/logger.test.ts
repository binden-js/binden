import { deepStrictEqual, ok } from "node:assert/strict";
import { Socket } from "node:net";
import { suite, test } from "node:test";
import { Logger } from "@binden/logger";

import {
  BindenError,
  BindenRequest,
  BindenResponse,
  Context,
} from "../index.js";
import { serializers } from "../src/logger.js";

const secrets = [
  "secret-token",
  "secret-cookie",
  "secret-query",
  "secret-set-cookie",
  "secret-body",
  "secret-message",
  "secret-cause",
  "secret-json",
];

function createContext(): Context {
  const request = new BindenRequest(new Socket());
  request.method = "GET";
  request.url = "/path?token=secret-query";
  request.headers = {
    host: "localhost",
    authorization: "Bearer secret-token",
    "proxy-authorization": "Basic secret-token",
    cookie: "session=secret-cookie",
  };
  const response = new BindenResponse(request);
  response.setHeader("Set-Cookie", "session=secret-set-cookie");
  response.setHeader("Content-Type", "text/plain");
  return new Context({ request, response });
}

function assertNoSecrets(output: string): void {
  for (const secret of secrets) {
    ok(!output.includes(secret), `${secret} leaked: ${output}`);
  }
}

suite("serializers", () => {
  test("request: no query and redacted credentials", () => {
    const { request } = createContext();
    const serialized = serializers.request(request) as {
      method: string;
      url: string;
      headers: Record<string, string>;
    };
    const { method, url, headers } = serialized;

    deepStrictEqual({ method, url }, { method: "GET", url: "/path" });
    ok(!("query" in serialized));
    ok(!("params" in serialized));
    deepStrictEqual(headers, {
      host: "localhost",
      authorization: "[Redacted]",
      "proxy-authorization": "[Redacted]",
      cookie: "[Redacted]",
    });
  });

  test("response: redacted cookies", () => {
    const { response } = createContext();
    const { headers } = serializers.response(response) as {
      headers: Record<string, string>;
    };

    deepStrictEqual(headers, {
      "set-cookie": "[Redacted]",
      "content-type": "text/plain",
    });
  });

  test("context", () => {
    const context = createContext();
    const serialized = serializers.context(context);

    assertNoSecrets(JSON.stringify(serialized));
    deepStrictEqual(serializers.context("not a context"), "not a context");
  });

  test("error: no message, stack, cause or json", () => {
    const cause = new SyntaxError("secret-cause");
    const error = new BindenError(400, {
      expose: true,
      message: "secret-message",
      json: { message: "secret-json" },
      cause,
    });
    deepStrictEqual(serializers.error(error), {
      type: "BindenError",
      status: 400,
      expose: true,
    });

    const system = Object.assign(new Error("secret-message", { cause }), {
      code: "ECONNRESET",
    });
    deepStrictEqual(serializers.error(system), {
      type: "Error",
      code: "ECONNRESET",
    });

    const internal = Object.assign(new Error("secret-message"), {
      code: "ERR_STREAM_PREMATURE_CLOSE",
    });
    deepStrictEqual(serializers.error(internal), {
      type: "Error",
      code: "ERR_STREAM_PREMATURE_CLOSE",
    });

    const invalid = Object.assign(new TypeError("secret-message"), {
      code: 42,
      status: "400",
      expose: "true",
    });
    deepStrictEqual(serializers.error(invalid), { type: "TypeError" });

    // Only Node.js error codes: any other `code` may come from the input
    for (const code of [
      "secret-code",
      "SECRET-CODE",
      "Esecret",
      "ERR_secret",
    ]) {
      deepStrictEqual(serializers.error(Object.assign(new Error(), { code })), {
        type: "Error",
      });
    }

    deepStrictEqual(
      serializers.error({ status: 400, expose: true, message: "secret" }),
      { type: "Object", status: 400, expose: true },
    );
    deepStrictEqual(serializers.error({ status: 999 }), { type: "Object" });
    deepStrictEqual(serializers.error("secret-message"), { type: "string" });
    deepStrictEqual(serializers.error(null), { type: "null" });
  });

  test("error: never throws", () => {
    const anonymous = Object.assign(new Error("secret-message"), {
      constructor: null,
    });
    deepStrictEqual(serializers.error(anonymous), { type: "Error" });

    // An anonymous class
    deepStrictEqual(serializers.error(new (class extends Error {})()), {
      type: "Error",
    });

    const getters = new Error("secret-message");
    for (const key of ["constructor", "status", "expose", "code"]) {
      Object.defineProperty(getters, key, {
        get(): never {
          throw new Error("getter");
        },
      });
    }
    deepStrictEqual(serializers.error(getters), { type: "Error" });

    const prototypeless = Object.assign(Object.create(null) as object, {
      status: 404,
    });
    deepStrictEqual(serializers.error(prototypeless), {
      type: "Object",
      status: 404,
    });

    const { proxy, revoke } = Proxy.revocable(new Error("secret-message"), {});
    revoke();
    deepStrictEqual(serializers.error(proxy), { type: "object" });

    const thrower = (): never => {
      throw new Error("trap");
    };
    const traps = new Proxy(new Error("secret-message"), {
      get: thrower,
      getPrototypeOf: thrower,
    });
    deepStrictEqual(serializers.error(traps), { type: "object" });

    deepStrictEqual(serializers.error(thrower), { type: "Function" });
  });

  test("body", () => {
    deepStrictEqual(serializers.body(), "[Redacted]");
  });

  test("framework logs do not leak credentials", () => {
    const lines: string[] = [];
    const destination = {
      write: (line: string): void => {
        lines.push(line);
      },
    };
    const log = new Logger({ serializers, destination, level: "debug" });

    log.debug("Not found", {
      context: createContext(),
      body: { password: "secret-body" },
      error: new BindenError(404, {
        message: "secret-message",
        cause: new Error("secret-cause"),
      }),
    });

    deepStrictEqual(lines.length, 1);
    assertNoSecrets(lines.join(""));
    ok(lines.join("").includes("[Redacted]"));
  });
});
