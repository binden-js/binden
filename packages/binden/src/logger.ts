import Pino from "pino";
import { Logger } from "@binden/logger";
import { BindenError } from "./error.js";
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

export const serializers = {
  error: Pino.stdSerializers.wrapErrorSerializer((error) => {
    if (error.raw instanceof BindenError) {
      const { status, expose, json } = error.raw;
      return { status, expose, json, ...error };
    }
    return error;
  }),
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
