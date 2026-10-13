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

/**
 * The serializers of the default logger, which keep credentials, query strings,
 * request bodies and error details (messages, stacks, causes and `json`, which
 * may quote the input, e.g. the one of `JSON.parse()`) out of the logs
 */
export const serializers = {
  // Only the kind of an error: its type, `status`, `expose` and `code`
  error: (error: unknown): Record<string, unknown> => {
    if (!(error instanceof Error)) {
      return { type: typeof error };
    }
    const { status, expose, code } = error as {
      status?: unknown;
      expose?: unknown;
      code?: unknown;
    };
    return {
      type: error.constructor.name,
      ...(typeof status === "number" ? { status } : {}),
      ...(typeof expose === "boolean" ? { expose } : {}),
      ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
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
