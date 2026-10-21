import { Binden, type Context } from "../index.js";
import { capture, ioTurn, listen, send, within } from "./helpers.js";
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { suite, test } from "node:test";
import { Readable } from "node:stream";
import { createReadStream } from "node:fs";
import { readsSafely } from "../src/exchange.js";

/** An error that its stack getter would fail to give (see `throwing()`) */
const unreadable = "Its stack cannot be read";

/** Makes the `stack` of an error a getter of the application that throws */
function throwing(error: Error): void {
  Object.defineProperty(error, "stack", {
    configurable: true,
    get(): never {
      throw new Error(unreadable);
    },
  });
}

/**
 * An error whose `name` getter, which V8 reads once it formats its stack,
 * runs `redefine` first (e.g. a getter of its `stack` that throws)
 */
function named(redefine: (error: Error) => void): Error {
  const error = new Error("Named");
  let redefined = false;
  Object.defineProperty(error, "name", {
    configurable: true,
    get(): string {
      if (!redefined) {
        redefined = true;
        redefine(error);
      }
      return "Error";
    },
  });
  return error;
}

/**
 * What a send of a source fails with, as the middleware sees it: the value
 * that it rejects with, and the records of the logger of the application
 */
async function sent(
  source: Readable,
): Promise<{ rejected: unknown; messages: unknown[] }> {
  const captured = capture();
  const outcome = Promise.withResolvers<unknown>();
  const app = new Binden({ logger: captured.logger }).use(
    async (context: Context) => {
      await context.send(source).then(
        () => {
          outcome.resolve("resolved");
        },
        (error: unknown) => {
          outcome.resolve(error);
        },
      );
      await context.response.status(500).send("failed");
    },
  );
  const listening = await listen(app);
  try {
    const { status } = await send(listening.port);
    strictEqual(status, 500);
    const rejected = await within(outcome.promise);
    await ioTurn();
    return { rejected, messages: captured.records.map(({ msg }) => msg) };
  } finally {
    await listening.close();
  }
}

/**
 * A `Readable` whose own `resume()` (which its `on("data")` calls) throws a
 * value once: the send fails with it before anything is sent
 */
function resuming<T extends Readable>(readable: T, value: unknown): T {
  let thrown = false;
  readable.resume = function resume(): T {
    if (!thrown) {
      thrown = true;
      throw value;
    }
    return Readable.prototype.resume.call(this) as T;
  };
  return readable;
}

suite(
  "A value whose formatting redefines its stack (H24-1): binden checks it again once formatted",
  () => {
    test("whose `name` getter defines a getter of its stack, or puts a proxy or another error before the getter of the engine: Node.js cannot read it safely", () => {
      const behindProxy = named((error) => {
        Reflect.deleteProperty(error, "stack");
        Object.setPrototypeOf(error, new Proxy(Error.prototype, {}));
      });
      // The getter of the engine, but of another error
      const behindError = named((error) => {
        Reflect.deleteProperty(error, "stack");
        Object.setPrototypeOf(error, new Error("Other"));
      });
      deepStrictEqual(
        [
          readsSafely(named(throwing)),
          readsSafely(behindProxy),
          readsSafely(behindError),
        ],
        [false, false, false],
      );
    });

    test("whose stack a `prepareStackTrace` of the application redefines as it formats it: Node.js cannot read it safely", () => {
      const previous: unknown = Reflect.get(Error, "prepareStackTrace");
      const formatted = new Error("Formatted");
      Reflect.set(
        Error,
        "prepareStackTrace",
        (error: Error, frames: readonly unknown[]): string => {
          if (error === formatted) {
            throwing(error);
          }
          return [error.message, ...frames.map(String)].join("\n");
        },
      );
      try {
        deepStrictEqual(
          [readsSafely(formatted), readsSafely(new Error("Other"))],
          [false, true],
        );
      } finally {
        Reflect.set(Error, "prepareStackTrace", previous);
      }
    });

    test("whose `name` getter replaces its stack with a value, or removes it: Node.js reads it safely", () => {
      const replaced = named((error) => {
        Object.defineProperty(error, "stack", {
          configurable: true,
          value: "Error: Replaced",
        });
      });
      const removed = named((error) => {
        Reflect.deleteProperty(error, "stack");
      });
      deepStrictEqual(
        [
          readsSafely(replaced),
          Reflect.get(replaced, "stack"),
          readsSafely(removed),
          typeof Reflect.get(removed, "stack"),
          readsSafely(new Error("Plain")),
        ],
        [true, "Error: Replaced", true, "undefined", true],
      );
    });

    test("thrown by the resume() of a Node.js file stream: the send rejects with it, and the stream is destroyed with its carrier, its file closed", async () => {
      const value = named(throwing);
      const stream = resuming(createReadStream(import.meta.filename), value);
      // Not by `once()`, which rejects with its `error`
      const closed = new Promise((resolve) => {
        stream.once("close", () => {
          resolve(null);
        });
      });
      const { rejected, messages } = await sent(stream);
      await within(closed);
      const { errored } = stream as { errored: unknown };
      deepStrictEqual(
        [
          rejected === value,
          stream.destroyed,
          (errored as Error).message,
          (errored as Error).cause === value,
          stream.closed,
          // Closed by its `_destroy()`
          Reflect.get(stream, "fd"),
          messages.includes("The release of a stream has failed"),
        ],
        [true, true, "A stream has failed", true, true, null, false],
      );
    });

    test("thrown by the resume() of a Node.js Readable whose own destroy() calls the one of Node.js: it is destroyed once, with the carrier", async () => {
      const value = named(throwing);
      const stream = resuming(
        new Readable({
          read(): void {
            // Never reads anything
          },
        }),
        value,
      );
      const destroys: unknown[] = [];
      stream.destroy = function destroy(error?: Error): Readable {
        destroys.push(error);
        return Readable.prototype.destroy.call(this, error);
      };
      const { rejected, messages } = await sent(stream);
      deepStrictEqual(
        [
          rejected === value,
          destroys.length,
          (destroys[0] as Error | undefined)?.cause === value,
          stream.errored === destroys[0],
          stream.destroyed,
          messages.includes("The release of a stream has failed"),
        ],
        [true, 1, true, true, true, false],
      );
    });
  },
);

suite(
  "The destroy of a Node.js Readable that fails while it is not destroyed (H24-1, R2-1)",
  () => {
    test("by the destroy() of Node.js (e.g. before it sets `destroyed`): it is destroyed by it once more, with the carrier of the value of the send", async () => {
      const value = new Error("Failed");
      const stream = new Readable({
        read(): void {
          // Never reads anything
        },
      });
      // Read by the destroy() of Node.js only: it throws once armed, as it
      // would read a stack that cannot be read
      let armed = false;
      Object.defineProperty(stream, "_writableState", {
        configurable: true,
        get(): null {
          if (armed) {
            armed = false;
            throw new Error(unreadable);
          }
          // As without a writable side
          return null;
        },
      });
      resuming(stream, value);
      const resume = stream.resume.bind(stream);
      stream.resume = (): Readable => {
        armed = true;
        return resume();
      };
      const { rejected, messages } = await sent(stream);
      deepStrictEqual(
        [
          rejected === value,
          armed,
          stream.destroyed,
          stream.errored?.message,
          stream.errored?.cause === value,
          messages.includes("The release of a stream has failed"),
        ],
        [true, false, true, "A stream has failed", true, false],
      );
    });

    test("by a destroy() of its own, which throws before it destroys it: it is called once, the failure logged, and the send rejects with the value", async () => {
      const value = new Error("Failed");
      const stream = resuming(
        new Readable({
          read(): void {
            // Never reads anything
          },
        }),
        value,
      );
      const destroys: unknown[] = [];
      stream.destroy = (error?: Error): never => {
        destroys.push(error);
        throw new Error("Its destroy has failed");
      };
      const { rejected, messages } = await sent(stream);
      deepStrictEqual(
        [
          rejected === value,
          destroys.length,
          destroys[0] === value,
          stream.destroyed,
          messages.includes("The release of a stream has failed"),
        ],
        [true, 1, true, false, true],
      );
      Readable.prototype.destroy.call(stream);
    });
  },
);
