import os from "node:os";
import Pino from "pino";
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
        request: Pino.stdSerializers.wrapRequestSerializer(
          /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
          ({ id: _id, ...rest }) => rest
        )(input.request),
        response: Pino.stdSerializers.res(input.response),
      };
    }
    return input;
  },
};
/* c8 ignore stop */

export const base = { pid: process.pid, hostname: os.hostname() };
