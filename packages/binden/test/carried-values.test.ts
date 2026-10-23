import { Binden, type Context } from "../index.js";
import {
  type IStreamLikeMethods,
  readStreamLike,
  streamLikeOf,
  uncarried,
} from "../src/stream-like.js";
import { capture, ioTurn, listen, send, within } from "./helpers.js";
import { suite, test } from "node:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { deepStrictEqual } from "node:assert/strict";

/** An error whose `stack` getter throws: Node.js cannot read it safely */
function unstackable(message: string): Error {
  return Object.defineProperty(new Error(message), "stack", {
    get(): never {
      throw new Error("Its stack cannot be read");
    },
  });
}

/**
 * A stream-like source of its own whose `resume()` (the first read of its
 * readable) throws a value, and that records what it is destroyed with
 */
class Source extends EventEmitter {
  public readonly destroys: unknown[] = [];
  readonly #thrown: Error | null;

  public constructor(thrown: Error | null = null) {
    super();
    this.#thrown = thrown;
  }

  public pause(): this {
    return this;
  }

  public resume(): this {
    if (this.#thrown !== null) {
      throw this.#thrown;
    }
    return this;
  }

  public destroy(error?: Error): this {
    this.destroys.push(error);
    return this;
  }
}

/** The readable of a stream-like source (see `readStreamLike()`) */
function readableOf(source: Source): Readable {
  return readStreamLike(
    source,
    streamLikeOf(source) as IStreamLikeMethods,
    () => new Error("Cancelled"),
    () => null,
  );
}

/** The error that a readable is destroyed with */
function failureOf(readable: Readable): Promise<unknown> {
  return within(
    new Promise((resolve) => {
      readable.once("error", resolve);
    }),
  );
}

suite(
  "A carrier is taken for its value only by the readable that has destroyed itself with it (R24-C1)",
  () => {
    test("uncarried(): the value for the readable of the carrier, the carrier itself for another readable of a stream-like source (also one with carriers of its own) and for a Node.js Readable", async () => {
      const value = unstackable("First");
      const first = readableOf(new Source(value));
      const other = readableOf(new Source(unstackable("Other")));
      const carriers = [failureOf(first), failureOf(other)];
      first.resume();
      other.resume();
      const [carrier, own] = (await Promise.all(carriers)) as [Error, Error];
      await ioTurn();
      const native = new Readable({ read: (): null => null });
      deepStrictEqual(
        [
          carrier.cause === value,
          uncarried(carrier, first) === value,
          uncarried(carrier, other) === carrier,
          uncarried(own, other) === own.cause,
          uncarried(carrier, native) === carrier,
          uncarried(value, first) === value,
          uncarried(null, first),
        ],
        [true, true, true, true, true, true, null],
      );
      native.destroy();
    });

    test("kept from the destroy() of a source, and emitted by the source of another send (a Node.js Readable, or a stream-like source): that send rejects with the carrier, not with the value of the first source", async () => {
      for (const kind of ["native", "stream-like"] as const) {
        const value = unstackable("First source failure");
        const outcome = Promise.withResolvers<unknown[]>();
        const app = new Binden({ logger: capture().logger }).use(
          async (context: Context) => {
            const first = new Source(value);
            const firstError = await context.send(first).then(
              () => "resolved",
              (error: unknown) => error,
            );
            const [carrier] = first.destroys as [Error];
            const second =
              kind === "native"
                ? new Readable({ read: (): null => null })
                : new Source();
            const sent = context.send(second);
            second.emit("error", carrier);
            const secondError = await sent.then(
              () => "resolved",
              (error: unknown) => error,
            );
            outcome.resolve([
              firstError === value,
              carrier.cause === value,
              secondError === carrier,
            ]);
            context.response.status(500).end("failed");
          },
        );
        const listening = await listen(app);
        try {
          const { status, body } = await send(listening.port);
          deepStrictEqual(
            [...(await within(outcome.promise)), status, body],
            [true, true, true, 500, "failed"],
            kind,
          );
        } finally {
          await listening.close();
        }
      }
    });
  },
);
