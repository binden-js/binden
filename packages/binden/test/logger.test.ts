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
  "secret-api-key",
  "secret-header",
  "secret-session",
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
    "user-agent": "test",
    "content-type": "text/plain",
    "content-length": "4",
    authorization: "Bearer secret-token",
    "proxy-authorization": "Basic secret-token",
    cookie: "session=secret-cookie",
    "x-api-key": "secret-api-key",
  };
  const response = new BindenResponse(request);
  response.setHeader("Set-Cookie", "session=secret-set-cookie");
  response.setHeader("X-Header", "secret-header");
  response.setHeader("Content-Type", "text/plain");
  // A field that the application has set on the context
  return Object.assign(new Context({ request, response }), {
    privateSession: "secret-session",
  });
}

function assertNoSecrets(output: string): void {
  for (const secret of secrets) {
    ok(!output.includes(secret), `${secret} leaked: ${output}`);
  }
}

suite("serializers", () => {
  test("request: an allowlist of details", () => {
    const { request } = createContext();

    deepStrictEqual(serializers.request(request), {
      method: "GET",
      url: "/path",
      headers: {
        host: "localhost",
        "user-agent": "test",
        "content-type": "text/plain",
        "content-length": "4",
      },
    });

    // No URL at all (`url` is optional)
    const bare = new BindenRequest(new Socket());
    Reflect.deleteProperty(bare, "url");
    deepStrictEqual(serializers.request(bare), {
      method: null,
      url: "",
      headers: {},
    });
    deepStrictEqual(serializers.request("not a request"), "not a request");
  });

  test("response: an allowlist of details", () => {
    const { response } = createContext();

    deepStrictEqual(serializers.response(response), {
      statusCode: 200,
      headers: { "content-type": "text/plain" },
    });
    deepStrictEqual(serializers.response("not a response"), "not a response");
  });

  test("context: not its own fields", () => {
    const context = createContext();

    deepStrictEqual(serializers.context(context), {
      id: context.id,
      request: serializers.request(context.request),
      response: serializers.response(context.response),
    });
    assertNoSecrets(JSON.stringify(serializers.context(context)));
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

    // Only known codes: any other `code` may come from the input
    for (const code of [
      "secret-code",
      "SECRET-CODE",
      "ESECRET",
      "ERR_SECRET_ABC123",
    ]) {
      deepStrictEqual(serializers.error(Object.assign(new Error(), { code })), {
        type: "Error",
      });
    }

    deepStrictEqual(
      serializers.error({ status: 400, expose: true, message: "secret" }),
      { type: "object", status: 400, expose: true },
    );
    deepStrictEqual(serializers.error({ status: 999 }), { type: "object" });
    deepStrictEqual(serializers.error({ status: "400" }), { type: "object" });
    deepStrictEqual(serializers.error({ status: 499 }), {
      type: "object",
      status: 499,
    });
    deepStrictEqual(serializers.error("secret-message"), { type: "string" });
    deepStrictEqual(serializers.error(null), { type: "null" });
  });

  test("error: the type of a known error class only", () => {
    // Names the application (or the input) chooses are not logged
    class SECRET_CLASS extends RangeError {}
    deepStrictEqual(serializers.error(new SECRET_CLASS()), {
      type: "RangeError",
    });

    const tagged = Object.assign(new Error(), {
      [Symbol.toStringTag]: "SECRET_TAG",
      name: "SECRET_NAME",
    });
    deepStrictEqual(serializers.error(tagged), { type: "Error" });

    const errors = [
      new AggregateError([]),
      new EvalError(),
      new ReferenceError(),
      new SyntaxError(),
      new URIError(),
    ];
    deepStrictEqual(
      errors.map((error) => serializers.error(error).type),
      [
        "AggregateError",
        "EvalError",
        "ReferenceError",
        "SyntaxError",
        "URIError",
      ],
    );
  });

  test("error: never throws", () => {
    const anonymous = Object.assign(new Error("secret-message"), {
      constructor: null,
    });
    deepStrictEqual(serializers.error(anonymous), { type: "Error" });

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
      type: "object",
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

    deepStrictEqual(serializers.error(thrower), { type: "function" });
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
