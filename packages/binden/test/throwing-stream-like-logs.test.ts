import {
  type IStreamLikeLogs,
  type IStreamLikeMethods,
  readStreamLike,
  streamLikeOf,
} from "../src/stream-like.js";
import { suite, test } from "node:test";
import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import { deepStrictEqual } from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** A stream-like source of its own, which records the arguments of each destroy */
class Source extends EventEmitter {
  public readonly destroys: unknown[][] = [];

  public pause(): this {
    return this;
  }

  public resume(): this {
    return this;
  }

  public destroy(...args: unknown[]): this {
    this.destroys.push(args);
    return this;
  }
}

/** What a logger of the application that throws throws */
const failure = new Error("The logger has failed");

/** A log that throws, as a logger of the application whose own `debug()` throws */
function thrown(): never {
  throw failure;
}

/** Logs (see `IStreamLikeLogs`) that throw */
const throwing: IStreamLikeLogs = { released: thrown, removed: thrown };

/** The methods of a stream-like source (see `streamLikeOf()`) */
function methodsOf(source: object): IStreamLikeMethods {
  return streamLikeOf(source) as IStreamLikeMethods;
}

/** The errors that a readable emits (it emits them on the next tick) */
function errorsOf(readable: Readable): unknown[] {
  const errors: unknown[] = [];
  readable.on("error", (error: unknown) => {
    errors.push(error);
  });
  return errors;
}

suite(
  "A readable of a stream-like source whose logs throw (e.g. a logger of the application whose own `debug()` throws)",
  () => {
    test("cancelled, whose removal of a listener throws: its other listeners are removed, and it is destroyed with the reason, the readable without an error (R2)", async () => {
      const source = new Source();
      Object.assign(source, {
        removeListener(event: string, listener: () => void): Source {
          EventEmitter.prototype.removeListener.call(source, event, listener);
          if (event === "data") {
            throw new Error("No removal");
          }
          return source;
        },
      });
      const reason = new Error("Cancelled");
      const readable = readStreamLike(
        source,
        methodsOf(source),
        () => reason,
        () => null,
        () => null,
        throwing,
      );
      const errors = errorsOf(readable);
      readable.destroy();
      await new Promise(setImmediate);
      deepStrictEqual(
        [
          // Its guard listens (to its `error` and its `close`)
          ["data", "end", "close", "error"].map((event) =>
            source.listenerCount(event),
          ),
          source.destroys,
          readable.errored,
          errors,
        ],
        [[0, 0, 1, 1], [[reason]], null, []],
      );
    });

    test("cancelled, whose `destroy()` throws: the readable is destroyed without an error (R2)", async () => {
      const source = new Source();
      Object.assign(source, {
        destroy(): never {
          throw new Error("No destroy");
        },
      });
      const readable = readStreamLike(
        source,
        methodsOf(source),
        () => new Error("Cancelled"),
        () => null,
        () => null,
        throwing,
      );
      const errors = errorsOf(readable);
      readable.destroy();
      await new Promise(setImmediate);
      deepStrictEqual([readable.errored, errors], [null, []]);
    });

    test("that refuses every listener of its `error`, left untouched, whose notice of it (`unreleased()`) throws: the readable is destroyed with what the source has thrown (R2)", async () => {
      const refused = new Error("No listener of error");
      const source = new Source();
      Object.assign(source, {
        on(event: string, listener: () => void): Source {
          if (event === "error") {
            throw refused;
          }
          EventEmitter.prototype.on.call(source, event, listener);
          return source;
        },
      });
      const readable = readStreamLike(
        source,
        methodsOf(source),
        () => new Error("Cancelled"),
        () => null,
        thrown,
        { released: () => null, removed: () => null },
      );
      const errors = errorsOf(readable);
      await new Promise(setImmediate);
      deepStrictEqual(
        [readable.errored, errors, source.destroys],
        [refused, [refused], []],
      );
    });

    test("ended, whose deferred removal of the listener of `error` throws, and so does its log: does not crash the process (R2)", () => {
      const { status, stdout, stderr } = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          join(import.meta.dirname, "fixtures", "throwing-stream-like-logs.ts"),
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      deepStrictEqual(
        { status, stdout, stderr },
        { status: 0, stdout: "ended true\n", stderr: "" },
      );
    });
  },
);
