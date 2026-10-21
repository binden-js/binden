import { Binden, type Context, releasedFailure } from "../index.js";
import {
  type IStreamLikeMethods,
  readStreamLike,
  streamLikeOf,
  uncarried,
} from "../src/stream-like.js";
import { capture, ioTurn, listen, send, within } from "./helpers.js";
import { suite, test } from "node:test";
import { EventEmitter } from "node:events";
import { deepStrictEqual } from "node:assert/strict";

/**
 * A stream-like source of its own whose getter of `destroyed` throws its
 * value once it is armed (on every read, or on the first one only), and that
 * emits another error from a listener of its `newListener` when the next
 * listener of its `error` is added (its guard, once it is armed)
 */
class Source extends EventEmitter {
  public readonly value = new Error("State failed");
  public readonly later = new Error("Emitted while its guard is installed");
  /** What its events have thrown into the code that emits them */
  public readonly threw: unknown[] = [];
  readonly #once: boolean;
  #armed = false;
  #thrown = false;

  public constructor(once: boolean) {
    super();
    this.#once = once;
    this.on("newListener", (event: string) => {
      if (this.#armed && event === "error" && !this.#thrown) {
        this.#thrown = true;
        this.emit("error", this.later);
      }
    });
  }

  public get destroyed(): boolean {
    if (this.#armed && !(this.#once && this.#thrown)) {
      throw this.value;
    }
    return false;
  }

  public pause(): this {
    return this;
  }

  public resume(): this {
    return this;
  }

  public destroy(): this {
    return this;
  }

  /** Arms its getter, and emits its `end` or its `close`, recording what it throws */
  public stop(event: string): void {
    this.#armed = true;
    try {
      this.emit(event);
    } catch (error: unknown) {
      this.threw.push(error);
    }
  }
}

suite(
  "A stream-like source whose getter of destroyed throws once it ends or closes, and that emits another error while its guard is installed (R24-C2)",
  () => {
    test("read as a readable: destroyed with what the getter has thrown, and the other error reported once, as a late one", async () => {
      for (const event of ["end", "close"]) {
        for (const once of [false, true]) {
          const source = new Source(once);
          const reports: unknown[] = [];
          const released: unknown[] = [];
          const log = (error: unknown): void => {
            released.push(error);
          };
          const readable = readStreamLike(
            source,
            streamLikeOf(source) as IStreamLikeMethods,
            () => new Error("Cancelled"),
            (error: unknown) => {
              reports.push(error);
            },
            () => null,
            { released: log, removed: log },
          );
          const failure = within(
            new Promise((resolve) => {
              readable.once("error", resolve);
            }),
          );
          source.stop(event);
          const error = await failure;
          await ioTurn();
          deepStrictEqual(
            [
              uncarried(error, readable) === source.value,
              reports.length,
              reports[0] === source.later,
              released,
              source.threw,
              readable.closed,
            ],
            [true, 1, true, [], [], true],
            `${event} ${String(once)}`,
          );
        }
      }
    });

    test("sent: the send rejects with what the getter has thrown, and the other error is logged once as a released failure", async () => {
      for (const event of ["end", "close"]) {
        const source = new Source(false);
        const outcome = Promise.withResolvers<unknown>();
        const captured = capture();
        const app = new Binden({
          logger: captured.logger,
          log_error_details: true,
        }).use(async (context: Context) => {
          const sent = context.send(source).then(
            () => "resolved",
            (error: unknown) => error,
          );
          source.stop(event);
          outcome.resolve(await sent);
          context.response.status(500).end("failed");
        });
        const listening = await listen(app);
        try {
          const { status, body } = await send(listening.port);
          const rejected = await within(outcome.promise);
          await ioTurn();
          const late = captured.records
            .filter(({ msg }) => msg === releasedFailure)
            .map(({ failure }) => (failure as { message?: unknown }).message);
          deepStrictEqual(
            [rejected === source.value, late, source.threw, status, body],
            [true, [source.later.message], [], 500, "failed"],
            event,
          );
        } finally {
          await listening.close();
        }
      }
    });
  },
);
