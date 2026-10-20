import { Binden, type Context } from "../index.js";
import {
  type ICaptured,
  capture,
  ioTurn,
  listen,
  send,
  within,
} from "./helpers.js";
import { suite, test } from "node:test";
import { Readable } from "node:stream";
import { createReadStream } from "node:fs";
import { deepStrictEqual } from "node:assert/strict";

/** The message of the failure of a release of a source */
const releaseFailure = "The release of a stream has failed";

/** The message of the error that carries a value that Node.js cannot read safely */
const carried = "A stream has failed";

/**
 * Replies one request with the middleware, which sends the source: resolves
 * with the status that the client gets, the outcome of the send (`resolved`,
 * or the value that it has rejected with), and its logger, once the
 * middleware has settled
 */
async function replied(
  source: Readable,
  details = true,
): Promise<[number, unknown, ICaptured]> {
  const captured = capture();
  const outcome = Promise.withResolvers<unknown>();
  const app = new Binden({
    logger: captured.logger,
    log_error_details: details,
  }).use(async (context: Context) => {
    await context.send(source).then(
      () => {
        outcome.resolve("resolved");
      },
      (error: unknown) => {
        outcome.resolve(error);
        throw error;
      },
    );
  });
  const listening = await listen(app);
  try {
    const { status } = await send(listening.port);
    return [status, await within(outcome.promise), captured];
  } finally {
    await listening.close();
  }
}

/** The messages of the failures of a release that are logged */
function releases(captured: ICaptured): unknown[] {
  return captured.records
    .filter(({ msg }) => msg === releaseFailure)
    .map(({ failure }) => (failure as { message?: unknown }).message);
}

/**
 * Runs `run` while `Error.prepareStackTrace` throws for the errors that
 * `fails` tells (as a hook of the application may), and formats the others
 */
async function failing<T>(
  fails: (error: Error) => boolean,
  run: () => Promise<T>,
): Promise<T> {
  const previous: unknown = Reflect.get(Error, "prepareStackTrace");
  Reflect.set(
    Error,
    "prepareStackTrace",
    (error: Error, frames: readonly unknown[]): string => {
      if (fails(error)) {
        throw new Error("The hook has failed");
      }
      return [
        `${error.name}: ${error.message}`,
        ...frames.map((frame) => `    at ${String(frame)}`),
      ].join("\n");
    },
  );
  try {
    return await run();
  } finally {
    Reflect.set(Error, "prepareStackTrace", previous);
  }
}

/** A value that the source throws, and how many times its `stack` is read */
interface IThrown {
  readonly value: unknown;
  reads(): number;
}

/** A value that the source throws, whose `stack` is not read */
function plain(value: unknown): IThrown {
  return { value, reads: () => 0 };
}

/**
 * An error whose `stack` is a getter of the application, which counts its
 * reads: it returns a string first, and throws then (e.g. on the second read,
 * by Node.js once binden would have read it)
 */
function twoFaced(): IThrown {
  let reads = 0;
  const value = Object.defineProperty(new Error("Two-faced"), "stack", {
    configurable: true,
    get(): string {
      reads += 1;
      if (reads > 1) {
        throw new Error("Its stack cannot be read again");
      }
      return "Error: Two-faced";
    },
  });
  return { value, reads: () => reads };
}

/** An object whose `stack` is a getter of its prototype, of the application */
function inherited(): IThrown {
  let reads = 0;
  const prototype = Object.defineProperty({}, "stack", {
    get(): never {
      reads += 1;
      throw new Error("Its stack cannot be read");
    },
  });
  const value: unknown = Object.create(prototype);
  return { value, reads: () => reads };
}

/** A proxy (whose traps are code of the application), which counts its reads of `stack` */
function proxied(target: object): IThrown {
  let reads = 0;
  const value = new Proxy(target, {
    get(object, key, receiver): unknown {
      if (key === "stack") {
        reads += 1;
      }
      return Reflect.get(object, key, receiver) as unknown;
    },
  });
  return { value, reads: () => reads };
}

/**
 * Sends a file whose own `resume()` throws `thrown`: the outcome of the send,
 * whether the file is destroyed and closed, its `errored`, the values that
 * its `destroy()` is called with, and how many times binden had read the
 * `stack` of the value when it called it
 */
async function destroyedBy(
  thrown: IThrown,
  details = true,
): Promise<{
  status: number;
  outcome: unknown;
  destroys: unknown[];
  reads: number[];
  destroyed: boolean;
  closed: boolean;
  errored: unknown;
  captured: ICaptured;
}> {
  const source: Readable = createReadStream(import.meta.filename);
  const destroys: unknown[] = [];
  const reads: number[] = [];
  source.destroy = function destroy(this: Readable, error?: Error): Readable {
    destroys.push(error);
    reads.push(thrown.reads());
    return Readable.prototype.destroy.call(this, error);
  };
  source.resume = (): never => {
    throw thrown.value;
  };
  // Not `once()`, which rejects at its `error`
  const closed = new Promise<void>((resolve) => {
    source.on("close", () => {
      resolve();
    });
  });
  const [status, outcome, captured] = await replied(source, details);
  await within(closed);
  await ioTurn();
  return {
    status,
    outcome,
    destroys,
    reads,
    destroyed: source.destroyed,
    closed: source.closed,
    errored: (source as { errored: unknown }).errored,
    captured,
  };
}

suite(
  "A Readable that binden destroys with what its code has thrown is destroyed by one call of its `destroy()`",
  () => {
    for (const [what, make] of [
      [
        "a native error, whose stack is not formatted yet (the getter of the engine, which binden reads first)",
        (): IThrown => plain(new Error("Native")),
      ],
      [
        "an instance of a subclass of `Error` (the getter of the engine)",
        (): IThrown =>
          plain(new (class Subclassed extends Error {})("Subclassed")),
      ],
      [
        "a `DOMException` (the getter of the engine)",
        (): IThrown => plain(new DOMException("Aborted", "AbortError")),
      ],
      [
        "an error whose `stack` is a value of its own",
        (): IThrown =>
          plain(
            Object.defineProperty(new Error("Own"), "stack", {
              value: "Error: Own",
            }),
          ),
      ],
      [
        "an object without a `stack`",
        (): IThrown => plain({ message: "Plain" }),
      ],
      ["a string", (): IThrown => plain("A string")],
    ] as const) {
      test(`with the value itself, when Node.js reads its \`stack\` without running code of the application: ${what}`, async () => {
        const thrown = make();
        const {
          status,
          outcome,
          destroys,
          destroyed,
          closed,
          errored,
          captured,
        } = await destroyedBy(thrown);
        deepStrictEqual(
          [
            status,
            outcome === thrown.value,
            destroys.length,
            destroys[0] === thrown.value,
            destroyed,
            closed,
            errored === thrown.value,
          ],
          [500, true, 1, true, true, true, true],
        );
        deepStrictEqual(releases(captured), []);
      });
    }

    test("without an error for a value that Node.js does not read (`null`)", async () => {
      const thrown = plain(null);
      const { status, outcome, destroys, destroyed, closed, errored } =
        await destroyedBy(thrown);
      deepStrictEqual(
        [status, outcome, destroys, destroyed, closed, errored],
        [500, null, [null], true, true, null],
      );
    });

    for (const [what, make] of [
      [
        "a getter of its own that returns a string on its first read and throws on the second, which binden never calls",
        twoFaced,
      ],
      [
        "a getter of a prototype of the application, which binden never calls",
        inherited,
      ],
      [
        "a proxy of an error, whose traps binden never runs",
        (): IThrown => proxied(new Error("Proxied")),
      ],
      [
        "an object whose prototype is a proxy",
        (): IThrown => plain(Object.create(new Proxy({}, {})) as object),
      ],
    ] as const) {
      test(`with an \`Error\` that carries the value as its \`cause\` otherwise (its send still rejects with the value, nothing is logged): ${what}`, async () => {
        const thrown = make();
        const {
          status,
          outcome,
          destroys,
          reads,
          destroyed,
          closed,
          errored,
          captured,
        } = await destroyedBy(thrown);
        const error = errored as Error | null;
        deepStrictEqual(
          [
            status,
            outcome === thrown.value,
            destroys.length,
            destroys[0] === errored,
            reads,
            destroyed,
            closed,
          ],
          [500, true, 1, true, [0], true, true],
        );
        deepStrictEqual(
          [error?.constructor, error?.message, error?.cause === thrown.value],
          [Error, carried, true],
        );
        deepStrictEqual(releases(captured), []);
      });
    }

    test("with an `Error` that carries a native error whose stack a `prepareStackTrace` of the application fails to format", async () => {
      const thrown = plain(new Error("Unformattable"));
      const { outcome, destroys, destroyed, closed, errored } = await failing(
        (error) => error === thrown.value,
        // Without details: the logger would read its stack
        () => destroyedBy(thrown, false),
      );
      const error = errored as Error | null;
      deepStrictEqual(
        [
          outcome === thrown.value,
          destroys.length,
          destroyed,
          closed,
          error?.message,
          error?.cause === thrown.value,
        ],
        [true, 1, true, true, carried, true],
      );
    });

    test("whose stack is its header when that hook fails to format it as well", async () => {
      const thrown = plain(new Error("Unformattable"));
      const { outcome, destroys, destroyed, closed, errored } = await failing(
        (error) => error === thrown.value || error.cause === thrown.value,
        // Without details: the logger would read its stack
        () => destroyedBy(thrown, false),
      );
      const error = errored as Error | null;
      deepStrictEqual(
        [
          outcome === thrown.value,
          destroys.length,
          destroyed,
          closed,
          error?.cause === thrown.value,
          error?.stack,
        ],
        [true, 1, true, true, true, `Error: ${carried}`],
      );
    });
  },
);

suite(
  "A Readable whose own `destroy()` throws an ordinary error when binden destroys it",
  () => {
    test("is not destroyed again: what it throws is logged (`debug`), and its send rejects with what its code has thrown", async () => {
      const failure = new Error("Its own destroy() refuses");
      let destroys = 0;
      const source = new (class extends Readable {
        public override destroy(error?: Error): this {
          destroys += 1;
          if (typeof error !== "undefined" && !(error instanceof Error)) {
            throw failure;
          }
          return super.destroy(error);
        }
      })({
        read(): void {
          // Never read
        },
      });
      const thrown = { message: "A plain object" };
      source.resume = (): never => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- a plain object, as code of a source may throw
        throw thrown;
      };
      const [status, outcome, captured] = await replied(source);
      await captured.waitFor(releaseFailure);
      deepStrictEqual(
        [status, outcome === thrown, destroys, source.destroyed],
        [500, true, 1, false],
      );
      deepStrictEqual(releases(captured), [failure.message]);
    });

    for (const mode of ["once", "always"] as const) {
      test(`with an error of binden (a body longer than its \`Content-Length\`) is not destroyed again (it throws ${mode}): what it throws is logged`, async () => {
        const failure = new Error("Its own destroy() has failed");
        const destroys: unknown[] = [];
        const source = new Readable({
          read(): void {
            // Pushed below
          },
        });
        source.destroy = function destroy(
          this: Readable,
          error?: Error,
        ): Readable {
          destroys.push(error);
          if (mode === "always" || destroys.length === 1) {
            throw failure;
          }
          return Readable.prototype.destroy.call(this, error);
        };
        source.on("error", () => {
          // Not destroyed
        });
        const captured = capture();
        const outcome = Promise.withResolvers<unknown>();
        const app = new Binden({
          logger: captured.logger,
          log_error_details: true,
        }).use(async (context: Context) => {
          context.response.setHeader("Content-Length", 1);
          setImmediate(() => {
            source.push("abc");
          });
          await context.send(source).catch((error: unknown) => {
            outcome.resolve(error);
          });
        });
        const listening = await listen(app);
        try {
          await send(listening.port);
          const error = (await within(outcome.promise)) as { code?: unknown };
          await captured.waitFor(releaseFailure);
          deepStrictEqual(
            [
              error.code,
              destroys.length,
              destroys[0] === error,
              source.destroyed,
            ],
            ["ERR_HTTP_CONTENT_LENGTH_MISMATCH", 1, true, false],
          );
          deepStrictEqual(releases(captured), [failure.message]);
        } finally {
          await listening.close();
        }
      });
    }
  },
);
