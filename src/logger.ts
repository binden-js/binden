import Pino from "pino";
import { Logger } from "@binden/logger";
import { BindenError } from "./error.js";
import { Context } from "./context.js";
/* c8 ignore start */
export const serializers = {
  error: Pino.stdSerializers.wrapErrorSerializer((error) => {
    if (error.raw instanceof BindenError) {
      const { status, expose, json } = error.raw;
      return { status, expose, json, ...error };
    }
    return error;
  }),
  request: Pino.stdSerializers.wrapRequestSerializer(
    /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
    ({ id: _id, ...rest }) => rest
  ),
  response: Pino.stdSerializers.res,
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
/* c8 ignore stop */

export default new Logger({ serializers });
