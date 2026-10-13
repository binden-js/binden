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

    const numeric = Object.assign(new TypeError("secret-message"), {
      code: 42,
      status: "400",
      expose: "true",
    });
    deepStrictEqual(serializers.error(numeric), {
      type: "TypeError",
      code: 42,
    });

    deepStrictEqual(serializers.error("secret-message"), { type: "string" });
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
