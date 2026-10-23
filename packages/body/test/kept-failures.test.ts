import { Binden, BindenError, type Context, ct_json } from "binden";
import { deepStrictEqual, ok } from "node:assert/strict";
import { echo, listen, send } from "./helpers.js";
import { suite, test } from "node:test";
import { BodyParser } from "../index.js";

/**
 * Sends a JSON body through a parser of these options, in an application
 * whose `error_handler` replies with the status of what it gets: that
 * error, and the status of the reply
 */
async function handled(
  options: ConstructorParameters<typeof BodyParser>[0],
): Promise<{ readonly error: unknown; readonly status: number }> {
  const errors: unknown[] = [];
  const server = await listen(
    new Binden({
      error_handler: async (
        context: Context,
        error: unknown,
      ): Promise<void> => {
        errors.push(error);
        context.status(error instanceof BindenError ? error.status : 599);
        await context.send();
      },
    }).use(new BodyParser(options), echo),
  );
  try {
    const { status } = await send(server.url, "[1]", {
      "Content-Type": ct_json,
    });
    deepStrictEqual(errors.length, 1);
    return { error: errors[0], status };
  } finally {
    await server.close();
  }
}

suite("BodyParser (failures of the options that it calls)", () => {
  test(
    "a failure of `verify`, `parse` or `type` that is not a BindenError is a BindenError (500) of it for the `error_handler`, never the failure itself",
    { timeout: 30_000 },
    async () => {
      const failure = new TypeError("A failure");
      const fail = (): never => {
        throw failure;
      };
      for (const options of [
        { verify: fail },
        { verify: (): Promise<never> => Promise.reject(failure) },
        { parse: fail },
        { parse: (): Promise<never> => Promise.reject(failure) },
        { type: fail },
      ]) {
        const { error, status } = await handled(options);
        ok(error instanceof BindenError, Object.keys(options).join());
        deepStrictEqual(
          { status, error: error.status, cause: error.cause === failure },
          { status: 500, error: 500, cause: true },
          Object.keys(options).join(),
        );
      }
    },
  );
});
