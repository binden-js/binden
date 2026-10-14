import { IncomingMessage, ServerResponse, STATUS_CODES } from "node:http";
import { constants } from "node:os";
import { Logger } from "@binden/logger";
import { Context } from "./context.js";
import { BindenError } from "./error.js";
import { property as get } from "./property.js";

/** The request headers that the default logger keeps (others may carry credentials) */
const requestHeaders = ["host", "user-agent", "content-type", "content-length"];

/** The response headers that the default logger keeps */
const responseHeaders = ["content-type", "content-length"];

/** The error classes the default logger names (a subclass gets the name of its parent) */
const errorTypes: ReadonlyMap<object, string> = new Map<object, string>([
  [BindenError.prototype, "BindenError"],
  [AggregateError.prototype, "AggregateError"],
  [EvalError.prototype, "EvalError"],
  [RangeError.prototype, "RangeError"],
  [ReferenceError.prototype, "ReferenceError"],
  [SyntaxError.prototype, "SyntaxError"],
  [TypeError.prototype, "TypeError"],
  [URIError.prototype, "URIError"],
  [Error.prototype, "Error"],
]);

/** The error codes the default logger keeps: system errors and some stream/HTTP ones */
const errorCodes: ReadonlySet<string> = new Set([
  ...Object.keys(constants.errno),
  "ERR_HTTP_CONTENT_LENGTH_MISMATCH",
  "ERR_HTTP_HEADERS_SENT",
  "ERR_HTTP_INVALID_HEADER_VALUE",
  "ERR_INVALID_ARG_TYPE",
  "ERR_INVALID_CHAR",
  "ERR_STREAM_ALREADY_FINISHED",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_PREMATURE_CLOSE",
  "ERR_STREAM_WRITE_AFTER_END",
]);

/** The name of the nearest known error class of a value (never one it defines itself) */
function typeOf(value: object): string {
  try {
    let prototype = Object.getPrototypeOf(value) as object | null;
    while (prototype !== null) {
      const type = errorTypes.get(prototype);
      if (typeof type === "string") {
        return type;
      }
      prototype = Object.getPrototypeOf(prototype) as object | null;
    }
  } catch {
    // A proxy that refuses to tell its prototype
  }
  return typeof value;
}

/** The given headers, when they are set */
function pick(
  names: readonly string[],
  header: (name: string) => unknown,
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const name of names) {
    const value = header(name);
    if (typeof value !== "undefined") {
      picked[name] = value;
    }
  }
  return picked;
}

/**
 * The serializers of the default logger. They log an allowlist of details only,
 * which keeps credentials, query strings, request bodies, error details
 * (messages, stacks, causes and `json`, which may quote the input) and the own
 * fields of a context out of the logs.
 */
export const serializers = {
  // The kind of an error: its type, `status`, `expose` and a known `code`. Never
  // throws, whatever is thrown.
  error: (error: unknown): Record<string, unknown> => {
    if (error === null) {
      return { type: "null" };
    } else if (typeof error !== "object" && typeof error !== "function") {
      return { type: typeof error };
    }
    const status = get(error, "status");
    const expose = get(error, "expose");
    const code = get(error, "code");
    return {
      type: typeOf(error),
      ...(typeof status === "number" && typeof STATUS_CODES[status] === "string"
        ? { status }
        : {}),
      ...(typeof expose === "boolean" ? { expose } : {}),
      ...(typeof code === "string" && errorCodes.has(code) ? { code } : {}),
    };
  },
  body: (): string => "[Redacted]",
  // The method, the path (without the query string) and some headers
  request: (request: unknown): unknown => {
    if (!(request instanceof IncomingMessage)) {
      return request;
    }
    return {
      method: request.method,
      url: (request.url ?? "").split("?", 1)[0],
      headers: pick(requestHeaders, (name) => request.headers[name]),
    };
  },
  response: (response: unknown): unknown => {
    if (!(response instanceof ServerResponse)) {
      return response;
    }
    return {
      statusCode: response.statusCode,
      headers: pick(responseHeaders, (name) => response.getHeader(name)),
    };
  },
  // Not the own fields of the context, which the application may have set
  context: (input: unknown): unknown => {
    if (!(input instanceof Context)) {
      return input;
    }
    return {
      id: input.id,
      request: serializers.request(input.request),
      response: serializers.response(input.response),
    };
  },
};

export default new Logger({ serializers });
