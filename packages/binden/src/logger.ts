import { STATUS_CODES } from "node:http";
import Pino from "pino";
import { Logger } from "@binden/logger";
import { Context } from "./context.js";

const redacted = "[Redacted]";

/** Headers that carry credentials and must never be logged */
const sensitive: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
]);

function redact(headers: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      sensitive.has(name.toLowerCase()) ? redacted : value,
    ]),
  );
}

/** Node.js error codes: system (`ECONNRESET`) and internal (`ERR_STREAM_DESTROYED`) ones */
const nodeErrorCode = /^(?:E[A-Z0-9]+|ERR_[A-Z0-9_]+)$/u;

/** Reads a property, so that a throwing getter (or proxy) cannot break the logs */
function get(value: object, key: string): unknown {
  try {
    return Reflect.get(value, key) as unknown;
  } catch {
    return null;
  }
}

/** The name of the constructor (as pino), otherwise the `Object.prototype.toString()` tag */
function typeOf(value: object): string {
  const constructor = get(value, "constructor");
  const name =
    typeof constructor === "function" ? get(constructor, "name") : null;
  if (typeof name === "string" && name !== "") {
    return name;
  }
  try {
    return Object.prototype.toString.call(value).slice(8, -1);
  } catch {
    return typeof value;
  }
}

/**
 * The serializers of the default logger, which keep credentials, query strings,
 * request bodies and error details (messages, stacks, causes and `json`, which
 * may quote the input, e.g. the one of `JSON.parse()`) out of the logs
 */
export const serializers = {
  // Only the kind of an error: its type, `status`, `expose` and a Node.js
  // `code`. Never throws, whatever is thrown.
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
      ...(typeof code === "string" && nodeErrorCode.test(code) ? { code } : {}),
    };
  },
  body: (): string => redacted,
  // The query string (and the parsed `query`/`params`) may contain tokens
  request: Pino.stdSerializers.wrapRequestSerializer(
    /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
    ({ id: _id, query: _query, params: _params, url, headers, ...rest }) => ({
      ...rest,
      url: url.split("?", 1)[0],
      headers: redact(headers),
    }),
  ),
  response: Pino.stdSerializers.wrapResponseSerializer(
    ({ headers, ...rest }) => ({ ...rest, headers: redact(headers) }),
  ),
  context: (input: unknown): unknown => {
    if (input instanceof Context) {
      return {
        ...input,
        request: serializers.request(input.request),
        response: serializers.response(input.response),
      };
    }
    return input;
  },
};

export default new Logger({ serializers });
