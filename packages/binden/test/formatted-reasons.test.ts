import { Binden, type Context } from "../index.js";
import {
  type IStreamLikeMethods,
  readStreamLike,
  streamLikeOf,
} from "../src/stream-like.js";
import { capture, listen, send } from "./helpers.js";
import { suite, test } from "node:test";
import { EventEmitter } from "node:events";
import { deepStrictEqual } from "node:assert/strict";

/**
 * Runs `run` while `Error.prepareStackTrace` records each error whose stack
 * V8 formats (once it is first read): an error of binden that is not
 * formatted when the application or a source has it keeps the objects of its
 * frames (e.g. the response)
 */
async function recording<T>(
  run: (formatted: WeakSet<object>) => Promise<T> | T,
): Promise<T> {
  const previous: unknown = Reflect.get(Error, "prepareStackTrace");
  const formatted = new WeakSet<object>();
  Reflect.set(
    Error,
    "prepareStackTrace",
    (error: Error, frames: readonly unknown[]): unknown => {
      formatted.add(error);
      return typeof previous === "function"
        ? Reflect.apply(previous, Error, [error, frames])
        : [`${error.name}: ${error.message}`, ...frames.map(String)].join(
            "\n    at ",
          );
    },
  );
  try {
    return await run(formatted);
  } finally {
    Reflect.set(Error, "prepareStackTrace", previous);
  }
}

/** A stream-like source of its own, which tells whether each error that it is destroyed with is formatted then */
class Source extends EventEmitter {
  public readonly destroys: boolean[] = [];

  readonly #formatted: WeakSet<object>;

  public constructor(formatted: WeakSet<object>) {
    super();
    this.#formatted = formatted;
  }

  public pause(): this {
    return this;
  }

  public resume(): this {
    return this;
  }

  public destroy(error?: Error): this {
    if (typeof error !== "undefined") {
      this.destroys.push(this.#formatted.has(error));
    }
    return this;
  }
}

/** The methods of a stream-like source (see `streamLikeOf()`) */
function methodsOf(source: object): IStreamLikeMethods {
  return streamLikeOf(source) as IStreamLikeMethods;
}

suite(
  "The errors of binden that a stream-like source is destroyed with, or that its send rejects with, are formatted before they are handed over",
  () => {
    test("the reason of a cancellation, before the source has it", async () => {
      const destroys = await recording((formatted) => {
        const source = new Source(formatted);
        readStreamLike(
          source,
          methodsOf(source),
          () => new Error("Cancelled"),
          () => null,
        ).destroy();
        return source.destroys;
      });
      deepStrictEqual(destroys, [true]);
    });

    test("the `TypeError` of a chunk that is not bytes, before the source has it (by the destroy of Node.js)", async () => {
      const destroys = await recording((formatted) => {
        const source = new Source(formatted);
        readStreamLike(
          source,
          methodsOf(source),
          () => new Error("Cancelled"),
          () => null,
        ).on("error", () => null);
        source.emit("data", 42);
        return source.destroys;
      });
      deepStrictEqual(destroys, [true]);
    });

    test("the premature close of a source that closes before its end, which the send rejects with (by the destroy of Node.js)", async () => {
      const [code, isFormatted] = await recording((formatted) => {
        const source = new Source(formatted);
        const readable = readStreamLike(
          source,
          methodsOf(source),
          () => new Error("Cancelled"),
          () => null,
        ).on("error", () => null);
        source.emit("close");
        const { errored } = readable;
        return [
          (errored as { code?: unknown } | null)?.code,
          errored !== null && formatted.has(errored),
        ];
      });
      deepStrictEqual(
        [code, isFormatted],
        ["ERR_STREAM_PREMATURE_CLOSE", true],
      );
    });
  },
);

suite(
  "The errors of the framework that it cancels the sends of a request with are formatted before they are handed over",
  () => {
    test("the `503` of the deadline, which the error handler is given", async () => {
      const seen = await recording(async (formatted) => {
        const outcomes: unknown[] = [];
        const app = new Binden({
          logger: capture().logger,
          timeout: 20,
          error_handler: async (
            context: Context,
            error: unknown,
          ): Promise<void> => {
            outcomes.push(
              (error as { status?: unknown }).status,
              formatted.has(error as object),
            );
            await context.response.status(503).send("deadline");
          },
        }).use(
          (context: Context) =>
            new Promise<void>((resolve) => {
              context.signal.addEventListener("abort", () => {
                resolve();
              });
            }),
        );
        const listening = await listen(app);
        try {
          const { status } = await send(listening.port);
          return [status, ...outcomes];
        } finally {
          await listening.close();
        }
      });
      deepStrictEqual(seen, [503, 503, true]);
    });

    test("the `500` of an error handler that has not settled in time, which its send that has not committed the headers rejects with", async () => {
      const seen = await recording(async (formatted) => {
        const outcomes: unknown[] = [];
        const app = new Binden({
          logger: capture().logger,
          error_handler_timeout: 20,
          error_handler: async (context: Context): Promise<void> => {
            // A source that never emits anything
            const source = Object.assign(new EventEmitter(), {
              pause(): void {
                // Never full
              },
              resume(): void {
                // Emits nothing
              },
            });
            await context.send(source).catch((error: unknown) => {
              outcomes.push(
                (error as { status?: unknown }).status,
                formatted.has(error as object),
              );
            });
          },
        }).use(() => {
          throw new Error("Failed");
        });
        const listening = await listen(app);
        try {
          const { status } = await send(listening.port);
          return [status, ...outcomes];
        } finally {
          await listening.close();
        }
      });
      deepStrictEqual(seen, [500, 500, true]);
    });
  },
);
