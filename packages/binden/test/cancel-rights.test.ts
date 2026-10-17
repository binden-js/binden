import { Binden, type Context } from "../index.js";
import { capture, listen, send, within } from "./helpers.js";
import { suite, test } from "node:test";
import { Readable } from "node:stream";
import { deepStrictEqual } from "node:assert/strict";

/**
 * A source that never produces anything, whose removal of a listener (by its
 * own `removeListener()`, or by a listener of its `removeListener` event)
 * runs `hijack`
 */
function hijacking(how: "event" | "override", hijack: () => void): Readable {
  const read = (): void => {
    // Never read
  };
  if (how === "event") {
    const source = new Readable({ read });
    source.on("removeListener", hijack);
    return source;
  }
  return new (class extends Readable {
    public override removeListener(
      ...args: Parameters<Readable["removeListener"]>
    ): this {
      hijack();
      return super.removeListener(...args);
    }
  })({ read });
}

suite("A pending send that the framework cancels", () => {
  for (const how of ["override", "event"] as const) {
    for (const [by, replied] of [
      ["the deadline", 503],
      ["the failure of the error handler", 500],
    ] as const) {
      test(`(${by}) removes the listeners of its source without the rights of the framework: the removal (${how === "event" ? "a `removeListener` listener" : "its own `removeListener()`"}) cannot replace the reply`, async () => {
        const failure = new Error("The error handler has failed");
        /** Whether each attempt to replace the reply has ended the response */
        const attempts: unknown[] = [];
        const outcome = Promise.withResolvers<unknown>();
        /** Sends a source whose removal of a listener replaces the reply */
        const sending = (context: Context): Promise<unknown> => {
          const { response } = context;
          const source = hijacking(how, () => {
            if (attempts.length === 0) {
              response.statusCode = 299;
              response.end("Hijacked");
              attempts.push(response.writableEnded);
            }
          });
          return context.send(source).then(
            () => "resolved",
            (error: unknown) => error,
          );
        };
        const app =
          by === "the deadline"
            ? new Binden({ logger: capture().logger, timeout: 50 }).use(
                async (context: Context) => {
                  outcome.resolve(await sending(context));
                },
              )
            : new Binden({
                logger: capture().logger,
                error_handler: (context: Context): never => {
                  outcome.resolve(sending(context));
                  throw failure;
                },
              }).use(() => {
                throw new Error("A failure");
              });
        const listening = await listen(app);
        try {
          const { status, body } = await send(listening.port, { ms: 10_000 });
          const reason = await within(outcome.promise);
          // Its attempt has changed nothing
          deepStrictEqual(
            [
              status,
              body,
              by === "the deadline"
                ? (reason as { reason?: unknown }).reason
                : reason === failure,
              attempts,
            ],
            [replied, "", by === "the deadline" ? "deadline" : true, [false]],
          );
        } finally {
          await listening.close();
        }
      });
    }
  }
});
