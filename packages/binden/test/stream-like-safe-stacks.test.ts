import { Binden, type Context } from "../index.js";
import { EventEmitter, once } from "node:events";
import { HOST, capture, ioTurn, listen, within } from "./helpers.js";
import {
  type IStreamLikeMethods,
  readStreamLike,
  streamLikeOf,
  uncarried,
} from "../src/stream-like.js";
import { suite, test } from "node:test";
import { connect } from "node:net";
import { createRequire } from "node:module";
import { deepStrictEqual } from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);

/** An error whose `stack` getter returns a string on its first read, and throws on the next ones */
interface IOnce {
  readonly error: Error;
  /** How many times its `stack` has been read */
  reads(): number;
}

/** An error whose `stack` getter throws from its second read (see `IOnce`) */
function readOnce(): IOnce {
  const error = new Error("Read once");
  let reads = 0;
  Object.defineProperty(error, "stack", {
    get(): string {
      reads += 1;
      if (reads > 1) {
        throw new Error("Its stack cannot be read again");
      }
      return "Error: Read once";
    },
  });
  return { error, reads: () => reads };
}

/** A stream-like source of its own, which records the values that it is destroyed with */
class Source extends EventEmitter {
  public readonly destroys: unknown[] = [];

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

/** A chunk that the response does not take at once (its `write()` returns `false`) */
const big = Buffer.alloc(1 << 20, 0x61);

suite(
  "A stream-like source that fails with a value whose stack Node.js cannot read safely (R23-1)",
  () => {
    test("emitted, or thrown by its pause() or by its on(), with a stack getter that throws once read again: the readable is destroyed once, with a carrier, and the source with that carrier", async () => {
      for (const how of ["emit", "pause", "on"] as const) {
        const value = readOnce();
        const source = Object.assign(new Source(), {
          on(event: string, listener: () => void): Source {
            if (how === "on" && event === "end") {
              throw value.error;
            }
            EventEmitter.prototype.on.call(source, event, listener);
            return source;
          },
          pause(): Source {
            if (how === "pause") {
              throw value.error;
            }
            return source;
          },
        });
        const readable = readStreamLike(
          source,
          streamLikeOf(source) as IStreamLikeMethods,
          () => new Error("Cancelled"),
          () => null,
        );
        const failure = failureOf(readable);
        if (how === "emit") {
          source.emit("error", value.error);
        } else if (how === "pause") {
          // More than the readable takes: it pauses the source
          source.emit("data", big);
        }
        const carrier = (await failure) as Error;
        await ioTurn();
        deepStrictEqual(
          [
            carrier.message,
            carrier.stack?.startsWith("Error: A stream has failed"),
            carrier.cause === value.error,
            uncarried(carrier, readable) === value.error,
            readable.errored === carrier,
            readable.closed,
            // Once it has emitted it, it is destroyed without it
            source.destroys.map((error) => {
              const kind = error === carrier ? "carrier" : typeof error;
              return kind;
            }),
            value.reads(),
          ],
          [
            "A stream has failed",
            true,
            true,
            true,
            true,
            true,
            how === "emit" ? ["undefined"] : ["carrier"],
            0,
          ],
          how,
        );
      }
    });

    test("thrown by its pause(), and again by its code while its guard is installed (a listener of its newListener): not logged, since the send rejects with it", async () => {
      const value = readOnce();
      const released: unknown[] = [];
      const source = Object.assign(new Source(), {
        pause(): never {
          source.on("newListener", () => {
            throw value.error;
          });
          throw value.error;
        },
      });
      const readable = readStreamLike(
        source,
        streamLikeOf(source) as IStreamLikeMethods,
        () => new Error("Cancelled"),
        () => null,
        () => null,
        {
          released: (error): void => {
            released.push(error);
          },
          removed: (error): void => {
            released.push(error);
          },
        },
      );
      const failure = failureOf(readable);
      source.emit("data", big);
      const carrier = (await failure) as Error;
      await ioTurn();
      deepStrictEqual(
        [uncarried(carrier, readable) === value.error, released, value.reads()],
        [true, [], 0],
      );
    });

    test("an error of binden whose stack a prepareStackTrace of the application fails to format (a chunk that is not bytes): a carrier whose stack is its header, for the readable and the source", async () => {
      const source = new Source();
      const readable = readStreamLike(
        source,
        streamLikeOf(source) as IStreamLikeMethods,
        () => new Error("Cancelled"),
        () => null,
      );
      const failure = failureOf(readable);
      const previous: unknown = Reflect.get(Error, "prepareStackTrace");
      Reflect.set(Error, "prepareStackTrace", (): never => {
        throw new Error("The stack cannot be formatted");
      });
      try {
        source.emit("data", null);
      } finally {
        Reflect.set(Error, "prepareStackTrace", previous);
      }
      const carrier = (await failure) as Error;
      const carried = uncarried(carrier, readable) as Error & {
        code?: unknown;
      };
      deepStrictEqual(
        [
          carrier.stack,
          carrier.cause === carried,
          carried.code,
          source.destroys.length,
          source.destroys[0] === carrier,
        ],
        ["Error: A stream has failed", true, "ERR_INVALID_ARG_TYPE", 1, true],
      );
    });

    test("sent, emitted or thrown by its pause(), with or without a deadline: the send rejects with the value itself at once, and the request pipelined after one that has sent nothing is answered", async () => {
      for (const how of ["emit", "pause"] as const) {
        for (const timeout of [0, 20_000]) {
          const value = readOnce();
          const outcome = Promise.withResolvers<unknown>();
          const app = new Binden({ logger: capture().logger, timeout }).use(
            async (context: Context) => {
              if (context.url.pathname === "/second") {
                await context.send("second");
                return;
              }
              const source = Object.assign(new Source(), {
                pause(): Source {
                  if (how === "pause") {
                    throw value.error;
                  }
                  return source;
                },
              });
              setImmediate(() => {
                if (how === "emit") {
                  source.emit("error", value.error);
                } else {
                  // Written at once, then kept by the readable, which pauses
                  // the source
                  source.emit("data", big);
                  source.emit("data", big);
                }
              });
              await context.send(source).then(
                () => {
                  outcome.resolve("resolved");
                },
                (error: unknown) => {
                  outcome.resolve(error);
                },
              );
              throw new Error("Failed");
            },
          );
          const listening = await listen(app);
          try {
            const socket = connect(listening.port, HOST);
            let received = "";
            socket.setEncoding("latin1").on("data", (chunk: string) => {
              received += chunk;
            });
            socket.on("error", () => null);
            await once(socket, "connect");
            socket.write(
              "GET / HTTP/1.1\r\nHost: a\r\n\r\nGET /second HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n",
            );
            // At once, long before the deadline
            const rejected = await within(outcome.promise);
            await within(once(socket, "close"));
            deepStrictEqual(
              [
                rejected === value.error,
                received.match(/^HTTP\/1\.1 \d{3}/gmu),
                value.reads(),
              ],
              [
                true,
                // Once its headers are sent, the response is closed
                how === "emit"
                  ? ["HTTP/1.1 500", "HTTP/1.1 200"]
                  : ["HTTP/1.1 200"],
                0,
              ],
              `${how} ${timeout}`,
            );
          } finally {
            await listening.close();
          }
        }
      }
    });

    test("of `readable-stream` 4 whose pause() throws it: the send rejects with it, and the source is destroyed by one call of its destroy()", async () => {
      const value = readOnce();
      const { PassThrough } = require("readable-stream-v4") as {
        PassThrough: new () => EventEmitter & {
          readonly destroyed: boolean;
          pause(): unknown;
          resume(): unknown;
          destroy(error?: Error): unknown;
          write(chunk: Buffer): boolean;
        };
      };
      const source = new PassThrough();
      const destroys: unknown[] = [];
      const destroy = source.destroy.bind(source);
      Object.assign(source, {
        pause(): never {
          throw value.error;
        },
        destroy(error?: Error): unknown {
          destroys.push(error);
          return destroy(error);
        },
      });
      const outcome = Promise.withResolvers<unknown>();
      const app = new Binden({ logger: capture().logger }).use(
        async (context: Context) => {
          setImmediate(() => {
            for (let chunk = 0; chunk < 8 && !source.destroyed; chunk += 1) {
              source.write(big);
            }
          });
          await context.send(source).then(
            () => {
              outcome.resolve("resolved");
            },
            (error: unknown) => {
              outcome.resolve(error);
            },
          );
        },
      );
      const listening = await listen(app);
      try {
        const socket = connect(listening.port, HOST);
        socket.resume().on("error", () => null);
        await once(socket, "connect");
        socket.write("GET / HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n");
        const rejected = await within(outcome.promise);
        await within(once(socket, "close"));
        deepStrictEqual(
          [
            rejected === value.error,
            source.destroyed,
            destroys.length,
            (destroys[0] as Error).cause === value.error,
            value.reads(),
          ],
          [true, true, 1, true, 0],
        );
      } finally {
        await listening.close();
      }
    });

    test("sent, without a handler of the process, also while a prepareStackTrace of the application throws: the send rejects with the value, and nothing is thrown into the events of the source", () => {
      deepStrictEqual(
        fixture(
          "unstackable-sources.ts",
          "/emit-once",
          "/pause-once",
          "/pst-emit",
          "/pst-chunk",
        ),
        {
          status: 0,
          stdout:
            "/emit-once 500 rejected:original threw= late=Later\n" +
            "/pause-once 200 rejected:original threw= late=Later\n" +
            "/pst-emit 500 rejected:original threw= late=Later\n" +
            "/pst-chunk 500 rejected:The chunk of a stream-like source must be a string or bytes (received null) threw= late=Later\n",
          stderr: "",
        },
      );
    });
  },
);
