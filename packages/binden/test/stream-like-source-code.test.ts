import {
  type IStreamLikeMethods,
  readStreamLike,
  streamLikeOf,
} from "../src/stream-like.js";
import { ioTurn, within } from "./helpers.js";
import { suite, test } from "node:test";
import { EventEmitter } from "node:events";
import { deepStrictEqual } from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * A stream-like source of its own whose `destroyed` getter throws once armed,
 * which records the values that it is destroyed with
 */
class Source extends EventEmitter {
  public readonly destroys: unknown[] = [];
  public readonly thrown = new Error("Its state cannot be read");
  public armed = false;

  public pause(): this {
    return this;
  }

  public resume(): this {
    return this;
  }

  public destroy(error?: Error): this {
    this.destroys.push(error);
    return this;
  }

  public get destroyed(): boolean {
    if (this.armed) {
      throw this.thrown;
    }
    return false;
  }
}

/** The error that a readable is destroyed with */
function failureOf(readable: NodeJS.ReadableStream): Promise<unknown> {
  return within(
    new Promise((resolve) => {
      readable.once("error", resolve);
    }),
  );
}

/**
 * Runs a fixture (`test/fixtures`) in a process of its own, with arguments,
 * without a handler of the process: a crash (e.g. an error thrown out of
 * `read()` of Node.js) is its exit code and output, not a failure of the test
 * runner
 */
function fixture(name: string, ...args: string[]): Record<string, unknown> {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--import",
      "tsx",
      join(import.meta.dirname, "fixtures", name),
      ...args,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  return { status, stdout, stderr };
}

suite(
  "Code of a stream-like source that the readable runs (R3.23-1, H23-2)",
  () => {
    test("its resume() (the first one, the first one with a stack getter that throws once read again, and the one once the readable has room again) or a getter of its destroyed once it ends or closes, throwing a value whose stack getter throws: the send rejects with it, without a handler of the process, and nothing is thrown into its events", () => {
      deepStrictEqual(
        fixture(
          "unstackable-sources.ts",
          "/resume",
          "/resume-once",
          "/drain",
          "/end",
          "/close",
        ),
        {
          status: 0,
          stdout:
            "/resume 500 rejected:original threw= late=Later\n" +
            "/resume-once 500 rejected:original threw= late=Later\n" +
            // Once its headers are sent, the response is closed
            "/drain 200 rejected:original threw= late=Later\n" +
            "/end 500 rejected:original threw= late=Later\n" +
            "/close 500 rejected:original threw= late=Later\n",
          stderr: "",
        },
      );
    });

    test("a getter of its destroyed that throws once it ends or closes: the readable is destroyed with what it has thrown, the source is released with it, and the guard of one whose state tells that it has closed leaves", async () => {
      for (const event of ["end", "close"] as const) {
        // As the state of a Node.js `Readable` tells it (see `hasClosed()`)
        const state = { closeEmitted: false };
        const source = Object.assign(new Source(), { _readableState: state });
        const readable = readStreamLike(
          source,
          streamLikeOf(source) as IStreamLikeMethods,
          () => new Error("Cancelled"),
          () => null,
        );
        const failure = failureOf(readable);
        source.armed = true;
        state.closeEmitted = event === "close";
        source.emit(event);
        const error = await failure;
        await ioTurn();
        deepStrictEqual(
          [
            error === source.thrown,
            readable.readableEnded,
            source.destroys.length,
            source.destroys[0] === source.thrown,
            // Its guard stays on one that has not closed
            ["data", "end", "error", "close"].map((name) =>
              source.listenerCount(name),
            ),
          ],
          [
            true,
            false,
            1,
            true,
            event === "close" ? [0, 0, 0, 0] : [0, 0, 1, 1],
          ],
          event,
        );
      }
    });
  },
);
