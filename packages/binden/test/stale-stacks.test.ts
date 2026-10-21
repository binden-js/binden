import {
  type IStreamLikeMethods,
  readStreamLike,
  streamLikeOf,
  uncarried,
} from "../src/stream-like.js";
import { ioTurn, within } from "./helpers.js";
import { suite, test } from "node:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { deepStrictEqual } from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** Redefines the `stack` of an error as a getter that throws */
function unstack(error: Error): void {
  Object.defineProperty(error, "stack", {
    configurable: true,
    get(): never {
      throw new Error("Its stack has been redefined");
    },
  });
}

/**
 * Runs `call` while the next read of the state of a writable on a `Readable`
 * (Node.js reads it as it destroys one, before it reads the stack of the
 * error) redefines the `stack` of `error`, once: the verdict that binden has
 * reached on it just before is stale then, whatever it has checked
 */
function staleDuring(error: Error, call: () => void): void {
  Object.defineProperty(Readable.prototype, "_writableState", {
    configurable: true,
    get(): void {
      Reflect.deleteProperty(Readable.prototype, "_writableState");
      unstack(error);
    },
  });
  try {
    call();
  } finally {
    Reflect.deleteProperty(Readable.prototype, "_writableState");
  }
}

/**
 * A stream-like source of its own whose `resume()` (the first read of its
 * readable) throws its value, and that records what it is destroyed with: its
 * `destroy()` redefines the stack of the error that it is given (`redefine`),
 * or throws (`throws`), before it would set `destroyed`
 */
class Source extends EventEmitter {
  public readonly value = new Error("V");
  public readonly destroys: unknown[] = [];
  readonly #destroying: "redefine" | "throws" | null;

  public constructor(destroying: "redefine" | "throws" | null = null) {
    super();
    this.#destroying = destroying;
  }

  public pause(): this {
    return this;
  }

  public resume(): never {
    throw this.value;
  }

  public destroy(error?: Error): this {
    this.destroys.push(error);
    if (this.#destroying === "throws") {
      throw new Error("Its destroy has failed");
    } else if (this.#destroying === "redefine" && error instanceof Error) {
      unstack(error);
    }
    return this;
  }
}

/** The readable of a source, and the failures of its release that it logs */
function readableOf(source: Source): {
  readonly readable: Readable;
  readonly released: unknown[];
} {
  const released: unknown[] = [];
  const log = (error: unknown): void => {
    released.push(error);
  };
  const readable = readStreamLike(
    source,
    streamLikeOf(source) as IStreamLikeMethods,
    () => new Error("Cancelled"),
    () => null,
    () => null,
    { released: log, removed: log },
  );
  return { readable, released };
}

/** The error that a readable emits, and whether it has closed after it */
async function failureOf(readable: Readable): Promise<[unknown, boolean]> {
  const error = await within(
    new Promise((resolve) => {
      readable.once("error", resolve);
    }),
  );
  await ioTurn();
  return [error, readable.closed];
}

/**
 * Runs a fixture (`test/fixtures`) in a process of its own, with arguments,
 * without a handler of the process: a crash (e.g. a throw into an event of a
 * source) is its exit code and output, not a failure of the test runner
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
  "A stream-like source whose value reads safely when binden checks it, but no longer once Node.js reads it (H24-1)",
  () => {
    test("redefined as Node.js destroys the readable, before it reads the stack: the readable is destroyed once more, with a carrier, and the source once, with that carrier", async () => {
      const source = new Source();
      const { readable, released } = readableOf(source);
      const failure = failureOf(readable);
      staleDuring(source.value, () => {
        // Its first read, at once
        readable.read();
      });
      const [carrier, closed] = (await failure) as [Error, boolean];
      deepStrictEqual(
        [
          carrier.message,
          carrier.cause === source.value,
          uncarried(carrier, readable) === source.value,
          readable.errored === carrier,
          closed,
          source.destroys.length,
          source.destroys[0] === carrier,
          released,
        ],
        ["A stream has failed", true, true, true, true, 1, true, []],
      );
    });

    test("redefined by the destroy() of the source, given it: the readable emits its error and its close all the same, with a carrier for that value", async () => {
      const source = new Source("redefine");
      const { readable, released } = readableOf(source);
      const failure = failureOf(readable);
      readable.resume();
      const [carrier, closed] = (await failure) as [Error, boolean];
      deepStrictEqual(
        [
          carrier.message,
          carrier.cause === source.value,
          uncarried(carrier, readable) === source.value,
          // As Node.js has read it first
          readable.errored === source.value,
          closed,
          source.destroys.length,
          source.destroys[0] === source.value,
          released,
        ],
        ["A stream has failed", true, true, true, true, 1, true, []],
      );
    });

    test("whose destroy() throws before it would set destroyed, also once the readable is destroyed once more: it is called once, what it throws is logged, and the readable emits the value", async () => {
      for (const stale of [false, true]) {
        const source = new Source("throws");
        const { readable, released } = readableOf(source);
        const failure = failureOf(readable);
        if (stale) {
          staleDuring(source.value, () => {
            readable.read();
          });
        } else {
          readable.resume();
        }
        const [error, closed] = await failure;
        deepStrictEqual(
          [
            uncarried(error, readable) === source.value,
            closed,
            source.destroys.length,
            uncarried(source.destroys[0], readable) === source.value,
            released.map((logged) => (logged as Error).message),
          ],
          [true, true, 1, true, ["Its destroy has failed"]],
          String(stale),
        );
      }
    });

    test("sent, without a handler of the process: the send rejects with the value at once, the source is destroyed once, and nothing is thrown into its events", () => {
      const ways = ["emit", "pause", "resume"];
      for (const kind of ["name", "pst", "proto", "redefine"]) {
        // Emitted, the value has reached the source already: it is
        // destroyed without it
        const destroyed =
          kind === "redefine"
            ? ["none", "V", "V"]
            : ["none", "carrier", "carrier"];
        deepStrictEqual(
          fixture("stale-stacks.ts", kind, ...ways),
          {
            status: 0,
            stdout: ways
              .map(
                (way, index) =>
                  `${kind}:${way} ${way === "pause" ? 200 : 500} rejected:V destroys=${destroyed[index]} threw= late=Later\n`,
              )
              .join(""),
            stderr: "",
          },
          kind,
        );
      }
    });
  },
);
