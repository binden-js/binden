import {
  Binden,
  type BindenAbortError,
  BindenResponse,
  type Context,
  type IBindenOptions,
  type IStreamLike,
} from "../index.js";
import { EventEmitter, once } from "node:events";
import { type IListening, capture, listen, sleep, within } from "./helpers.js";
import {
  type IStreamLikeMethods,
  emitterMethods,
  guard,
  readStreamLike,
  streamLikeOf,
} from "../src/stream-like.js";
import { IncomingMessage, request as httpRequest } from "node:http";
import { Socket, connect } from "node:net";
import { deepStrictEqual, ok, rejects } from "node:assert/strict";
import { suite, test } from "node:test";
import { Readable } from "node:stream";
import { createRequire } from "node:module";
import { join } from "node:path";
import { kSeal } from "../src/seal.js";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);

/** The source of a library: a transform whose readable side `send()` reads */
interface ISource extends EventEmitter {
  readonly destroyed?: boolean;
  write(chunk: Buffer | string): boolean;
  end(chunk?: Buffer | string): void;
  pause(): this;
  resume(): this;
  isPaused(): boolean;
  destroy(error?: Error): void;
}

/** A transform of `readable-stream` */
type IPassThrough = new () => ISource;

/** `through2` 2 (a transform of `readable-stream` 2) */
const through2 = require("through2-v2") as (
  transform: (
    chunk: Buffer,
    encoding: string,
    callback: (error: null, chunk: Buffer) => void,
  ) => void,
) => ISource;

/** The sources of every library, none of them a Node.js `Readable` */
const libraries: readonly (readonly [string, () => ISource])[] = [
  ...(["2", "3", "4"] as const).map(
    (version) =>
      [
        `readable-stream ${version}`,
        (): ISource => {
          const { PassThrough } = require(`readable-stream-v${version}`) as {
            PassThrough: IPassThrough;
          };
          return new PassThrough();
        },
      ] as const,
  ),
  [
    "through2 2",
    (): ISource =>
      through2((chunk, _encoding, callback) => {
        callback(null, chunk);
      }),
  ],
];

/** The listeners that `send()` adds to a source, how often it is paused, and what it is destroyed with */
interface ISpy {
  readonly added: [string, unknown][];
  readonly pauses: number;
  readonly destroys: unknown[];
  /** The listeners added that the source still has */
  left(): [string, unknown][];
}

/** Records the listeners added to a source (by its own `on()`) and its pauses */
function spy(source: ISource): ISpy {
  const added: [string, unknown][] = [];
  const destroys: unknown[] = [];
  let pauses = 0;
  const original = {
    on: source.on.bind(source),
    pause: source.pause.bind(source),
    destroy: source.destroy.bind(source),
  };
  Object.assign(source, {
    on(event: string, listener: () => void): ISource {
      added.push([event, listener]);
      original.on(event, listener);
      return source;
    },
    pause(): ISource {
      pauses += 1;
      return original.pause();
    },
    destroy(error?: Error): void {
      destroys.push(error);
      original.destroy(error);
    },
  });
  return {
    added,
    destroys,
    get pauses(): number {
      return pauses;
    },
    left: (): [string, unknown][] =>
      added.filter(([event, listener]) =>
        source.rawListeners(event).includes(listener as () => void),
      ),
  };
}

/** Whether a source has been destroyed (`through2` 2 sets only `_destroyed`) */
function destroyed(source: ISource): boolean {
  return (
    source.destroyed === true || Reflect.get(source, "_destroyed") === true
  );
}

/** A response as the client receives it, with the bytes of its body */
interface IBytes {
  readonly status: number;
  readonly headers: Record<string, unknown>;
  readonly body: Buffer;
}

/** Sends a request on a new connection, and reads the bytes of its response */
function fetchBytes(
  port: number,
  { method = "GET", path = "/" }: { method?: string; path?: string } = {},
): Promise<IBytes> {
  return new Promise<IBytes>((resolve, reject) => {
    httpRequest(
      { agent: false, method, path, port, signal: AbortSignal.timeout(5000) },
      (response) => {
        const chunks: Buffer[] = [];
        response
          .on("data", (chunk: Buffer) => chunks.push(chunk))
          .once("end", () => {
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks),
            });
          })
          .once("error", reject);
      },
    )
      .once("error", reject)
      .end();
  });
}

/** Sends a `GET` on a new connection, and reads what it receives until the connection closes */
function fetchRaw(port: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(port, "localhost");
    let data = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Not closed within 5000 ms: ${data}`));
    }, 5000);
    socket
      .setEncoding("latin1")
      .on("data", (chunk: string) => {
        data += chunk;
      })
      // E.g. a reset once the response is cut
      .on("error", () => null)
      .once("close", () => {
        clearTimeout(timer);
        resolve(data);
      })
      .write("GET / HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n");
  });
}

/** Runs an application with a middleware until the client is done */
async function withApp(
  options: IBindenOptions,
  middleware: (context: Context) => Promise<void>,
  client: (listening: IListening) => Promise<void>,
): Promise<void> {
  const listening = await listen(new Binden(options).use(middleware));
  try {
    await client(listening);
  } finally {
    await listening.close();
  }
}

/** `undefined`, which the linter does not let the tests write */
const none = ({} as { value?: undefined }).value;

/**
 * Runs a fixture (`test/fixtures`) in a process of its own, with these flags
 * of Node.js: a crash (e.g. an unhandled `error` event) is its exit code and
 * output, not a failure of the test runner
 */
function fixture(name: string, ...flags: string[]): Record<string, unknown> {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [
      ...flags,
      "--no-warnings",
      "--import",
      "tsx",
      join(import.meta.dirname, "fixtures", name),
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  return { status, stdout, stderr };
}

/** Waits until a condition holds: it fails (and stops polling) once `ms` have passed */
async function until(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > deadline) {
      throw new Error(`Not true within ${ms} ms`);
    }
    await sleep(5);
  }
}

/** The next turn: once the deferred `error` listener of a source is removed */
function nextTurn(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/** The error that a source has been destroyed with, by an `error` listener of the application */
function errorOf(source: ISource): () => unknown {
  let error: unknown = null;
  source.on("error", (failure: unknown) => {
    error = failure;
  });
  return () => error;
}

/** The bytes of the body: every value of a byte, multi-byte characters, and more than a chunk */
const parts = [
  Buffer.from(Array.from({ length: 256 }, (_value, index) => index)),
  "hé€😀",
  Buffer.alloc(100_000, 0x61),
];
const whole = Buffer.concat(
  parts.map((part) => (typeof part === "string" ? Buffer.from(part) : part)),
);

for (const [library, create] of libraries) {
  suite(`send() of a stream of ${library}`, () => {
    for (const declared of [false, true]) {
      test(`sends the bytes of the source${declared ? " of its declared length" : ""}, and removes its listeners`, async () => {
        const source = create();
        const recorded = spy(source);
        const outcomes: unknown[] = [];
        await withApp(
          {},
          async (context: Context) => {
            if (declared) {
              context.response.setHeader("Content-Length", whole.length);
            }
            setTimeout(() => {
              for (const part of parts) {
                source.write(part);
              }
              source.end();
            }, 10);
            await context.send(source);
            await nextTurn();
            outcomes.push(recorded.added.map(([event]) => event).sort());
            // By `send()` (`readable-stream` 4 destroys itself once ended)
            outcomes.push(
              recorded.left(),
              recorded.destroys.filter((error) => error !== none),
            );
          },
          async ({ port }) => {
            const received = await fetchBytes(port);
            deepStrictEqual(received.status, 200);
            ok(received.body.equals(whole), String(received.body.length));
            deepStrictEqual(
              received.headers["content-length"],
              declared ? String(whole.length) : none,
            );
            await until(() => outcomes.length === 3);
          },
        );
        // Never destroyed once it has ended
        deepStrictEqual(outcomes, [["close", "data", "end", "error"], [], []]);
      });
    }

    test("destroys the source with the error of a body longer than its declared length", async () => {
      const source = create();
      const recorded = spy(source);
      source.on("error", () => null);
      await withApp(
        {},
        async (context: Context) => {
          context.response.setHeader("Content-Length", 3);
          source.write("abcd");
          await context.send(source);
        },
        async ({ port }) => {
          // Before any byte: the error is replied
          deepStrictEqual((await fetchBytes(port)).status, 500);
          await until(() => recorded.destroys.length > 0);
          deepStrictEqual(
            recorded.destroys.map(
              (error) => (error as { code?: unknown }).code,
            ),
            ["ERR_HTTP_CONTENT_LENGTH_MISMATCH"],
          );
        },
      );
    });

    test("pauses the source while the response is full, and resumes it once it drains", async () => {
      const source = create();
      const recorded = spy(source);
      const chunk = Buffer.alloc(65_536, 0x62);
      const producer = { written: 0, blocked: false };
      await withApp(
        {},
        async (context: Context) => {
          // As much as the source takes: once paused, it takes no more
          const produce = (): void => {
            while (producer.written < 256 * chunk.length) {
              producer.written += chunk.length;
              if (!source.write(chunk)) {
                producer.blocked = true;
                source.once("drain", () => {
                  producer.blocked = false;
                  produce();
                });
                return;
              }
            }
            source.end();
          };
          produce();
          await context.send(source);
        },
        async ({ port }) => {
          const socket = connect(port, "localhost");
          try {
            await once(socket, "connect");
            let received = 0;
            socket.on("data", (data: Buffer) => {
              received += data.length;
            });
            socket.write(
              "GET / HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n",
            );
            socket.pause();
            // The client reads nothing: the response fills up, then the
            // source
            await until(
              () =>
                producer.blocked && recorded.pauses > 0 && source.isPaused(),
              5000,
            );
            const pending = producer.written;
            await sleep(50);
            // Paused: it takes nothing more
            deepStrictEqual(
              [producer.written, producer.blocked, source.isPaused()],
              [pending, true, true],
            );
            socket.resume();
            await within(once(socket, "close"), 10_000);
            // Everything, once the client reads
            ok(received > producer.written, String(received));
            deepStrictEqual(producer.written, 256 * chunk.length);
          } finally {
            // Also when it fails: a paused socket would never see its end
            socket.destroy();
          }
        },
      );
    });

    test("destroys the source with the reason of the deadline, and removes its listeners (its guard once it has closed)", async () => {
      const source = create();
      const reason = errorOf(source);
      const recorded = spy(source);
      await withApp(
        { timeout: 50 },
        async (context: Context) => {
          await context.send(source);
        },
        async ({ port }) => {
          const received = await fetchBytes(port);
          deepStrictEqual(received.status, 503);
          await until(() => destroyed(source) && reason() !== null);
          await until(() => recorded.left().length === 0);
          deepStrictEqual((reason() as BindenAbortError).reason, "deadline");
          // Of the send, and of its guard
          deepStrictEqual(recorded.added.map(([event]) => event).sort(), [
            "close",
            "close",
            "data",
            "end",
            "error",
            "error",
          ]);
        },
      );
    });

    test("destroys the source once the client goes away, and removes its listeners", async () => {
      const source = create();
      const reason = errorOf(source);
      const recorded = spy(source);
      const sent = Promise.withResolvers<unknown>();
      await withApp(
        {},
        async (context: Context) => {
          source.write("part");
          sent.resolve(
            await context.send(source).then(
              () => null,
              (error: unknown) => error,
            ),
          );
        },
        async ({ port }) => {
          const socket = connect(port, "localhost");
          try {
            await once(socket, "connect");
            let data = "";
            socket.setEncoding("latin1").on("data", (chunk: string) => {
              data += chunk;
            });
            socket.write("GET / HTTP/1.1\r\nHost: a\r\n\r\n");
            await until(() => data.includes("part"));
          } finally {
            socket.destroy();
          }
          const error = await within(sent.promise);
          ok(error instanceof Error);
          await until(() => destroyed(source) && reason() !== null);
          await nextTurn();
          deepStrictEqual(
            (reason() as BindenAbortError).reason,
            "client_closed",
          );
          deepStrictEqual(recorded.left(), []);
        },
      );
    });

    test("sends an empty body for a source that has ended, without listening to it", async () => {
      const source = create();
      source.end();
      source.resume();
      await until(
        () =>
          Reflect.get(
            Reflect.get(source, "_readableState") as object,
            "endEmitted",
          ) === true,
      );
      const recorded = spy(source);
      await withApp(
        {},
        async (context: Context) => {
          await context.send(source);
        },
        async ({ port }) => {
          const received = await fetchBytes(port);
          deepStrictEqual(
            [received.status, received.body.toString()],
            [200, ""],
          );
          await nextTurn();
          deepStrictEqual([recorded.added, recorded.destroys], [[], []]);
        },
      );
    });

    test("rejects at once for a source that has been destroyed, without reading it: only its guard listens (until the turn after its close, once its state tells it)", async () => {
      const source = create();
      source.destroy();
      await nextTurn();
      const recorded = spy(source);
      const captured = capture();
      await withApp(
        { logger: captured.logger },
        async (context: Context) => {
          await context.send(source);
        },
        async ({ port }) => {
          deepStrictEqual((await fetchBytes(port)).status, 500);
          const { failure } = await captured.waitFor("The request has failed");
          deepStrictEqual(
            (failure as { code?: unknown }).code,
            "ERR_STREAM_PREMATURE_CLOSE",
          );
          await nextTurn();
          deepStrictEqual(
            [recorded.added.map(([event]) => event), recorded.destroys],
            [["error", "close"], []],
          );
          // Of `readable-stream` 4: `closeEmitted`
          deepStrictEqual(
            recorded.left().length,
            library === "readable-stream 4" ? 0 : 2,
          );
        },
      );
    });

    for (const [how, fail] of [
      [
        "closes before its end",
        (source: ISource): void => {
          source.destroy();
        },
      ],
      [
        "fails",
        (source: ISource): void => {
          source.emit(
            "error",
            Object.assign(new Error("Failed"), { code: "E_FAILED" }),
          );
        },
      ],
    ] as const) {
      // Also a `PassThrough` of `readable-stream` 2, which emits its `end`
      // once destroyed: not its end
      test(`rejects when the source ${how}, and removes its listeners`, async () => {
        const source = create();
        // The error of the application, which `readable-stream` 2 emits
        // once closed
        source.on("error", () => null);
        const recorded = spy(source);
        let rejected: unknown = null;
        await withApp(
          {},
          async (context: Context) => {
            setTimeout(() => {
              fail(source);
            }, 10);
            await context.send(source).catch((error: unknown) => {
              rejected = error;
              throw error;
            });
          },
          async ({ port }) => {
            // Before any byte: the error is replied
            const received = await fetchBytes(port);
            deepStrictEqual(
              [received.status, received.body.toString()],
              [500, ""],
            );
            deepStrictEqual(
              (rejected as { code?: unknown } | null)?.code,
              how === "fails" ? "E_FAILED" : "ERR_STREAM_PREMATURE_CLOSE",
            );
            await nextTurn();
            deepStrictEqual(recorded.left(), []);
          },
        );
      });
    }

    // `readable-stream` 2 emits its `end` and its `close` once destroyed,
    // then the error of its destroy: neither is its end
    for (const [when, first] of [
      ["before its first chunk", false],
      ["once its first chunk is sent", true],
    ] as const) {
      for (const failure of first ? [true, false] : [true]) {
        test(`rejects when the source is destroyed ${failure ? "with an error" : "without an error"} ${when}: ${first ? "the connection is closed" : "the error is replied"}, never a complete body`, async () => {
          const source = create();
          const recorded = spy(source);
          const error = Object.assign(new Error("Destroyed"), {
            code: "E_DESTROYED",
          });
          let rejected: unknown = null;
          await withApp(
            {},
            async (context: Context) => {
              if (first) {
                source.write("first;");
              }
              setTimeout(() => {
                source.destroy(failure ? error : none);
              }, 20);
              await context.send(source).catch((reason: unknown) => {
                rejected = reason;
                throw reason;
              });
            },
            async ({ port }) => {
              const received = await fetchRaw(port);
              if (first) {
                // Cut after its chunk: without the last chunk
                ok(received.startsWith("HTTP/1.1 200 OK\r\n"), received);
                ok(received.endsWith("\r\n\r\n6\r\nfirst;\r\n"), received);
              } else {
                ok(
                  received.startsWith("HTTP/1.1 500 Internal Server Error\r\n"),
                  received,
                );
              }
              await until(() => rejected !== null);
              deepStrictEqual(
                (rejected as { code?: unknown }).code,
                failure ? "E_DESTROYED" : "ERR_STREAM_PREMATURE_CLOSE",
              );
              await nextTurn();
              deepStrictEqual(recorded.left(), []);
            },
          );
        });
      }
    }

    for (const [method, status] of [
      ["HEAD", 200],
      ["GET", 204],
      ["GET", 304],
    ] as const) {
      test(`sends no body to ${method} with ${status}: the source is destroyed without being read, guarded until it has closed`, async () => {
        const source = create();
        source.write("unread");
        const recorded = spy(source);
        await withApp(
          {},
          async (context: Context) => {
            await context.status(status).send(source);
          },
          async ({ port }) => {
            const received = await fetchBytes(port, { method });
            deepStrictEqual(
              [received.status, received.body.toString()],
              [status, ""],
            );
            await until(() => destroyed(source));
            await until(() => recorded.left().length === 0);
            // Only by its guard
            deepStrictEqual(recorded.added.map(([event]) => event).sort(), [
              "close",
              "error",
            ]);
          },
        );
      });
    }
  });
}

/** A stream-like source of its own: an emitter with `on()`, `pause()`, `resume()` and `off()` */
class Emitting extends EventEmitter {
  public readonly calls: string[] = [];

  public pause(): this {
    this.calls.push("pause");
    return this;
  }

  public resume(): this {
    this.calls.push("resume");
    return this;
  }
}

/** A stream-like source whose `destroy()` emits nothing (it is not required to) */
class Silent extends Emitting {
  public destroy(): this {
    this.calls.push("destroy");
    return this;
  }
}

/** The listeners that a source has of its `data`, `end`, `error` and `close` */
function counts(source: EventEmitter): number[] {
  return ["data", "end", "error", "close"].map((event) =>
    source.listenerCount(event),
  );
}

/** The message of a late error of a released source (see `ISourceReport`) */
const released = "A stream-like source has failed once released";

/** The messages of the late errors of released sources that a logger has logged */
function reported(captured: ReturnType<typeof capture>): unknown[] {
  return captured.records
    .filter(({ msg }) => msg === released)
    .map(({ failure }) => (failure as { message?: unknown }).message);
}

suite("send() of a stream-like source", () => {
  test("without destroy(): paused once cancelled or released, guarded before (an error of its pause is reported), and the listeners of the send are removed", async () => {
    const captured = capture();
    /** The events whose listeners have been removed, by source */
    const removed = new Map<Emitting, string[]>();
    /** A source without `destroy()`, with only `off()`, whose pause fails */
    const create = (): Emitting => {
      const source: Emitting = Object.assign(new Emitting(), {
        removeListener: null,
        off(event: string, listener: () => void): Emitting {
          removed.get(source)?.push(event);
          EventEmitter.prototype.removeListener.call(source, event, listener);
          return source;
        },
        pause(): Emitting {
          source.calls.push("pause");
          source.emit("error", new Error("Failed to pause"));
          return source;
        },
      });
      removed.set(source, []);
      return source;
    };
    const [cancelled, bodiless] = [create(), create()];
    await withApp(
      { logger: captured.logger, log_error_details: true, timeout: 50 },
      async (context: Context) => {
        await context.send(
          context.request.method === "HEAD" ? bodiless : cancelled,
        );
      },
      async ({ port }) => {
        deepStrictEqual(
          [
            (await fetchBytes(port)).status,
            (await fetchBytes(port, { method: "HEAD" })).status,
          ],
          [503, 200],
        );
        await until(() => reported(captured).length === 2);
        deepStrictEqual(reported(captured), [
          "Failed to pause",
          "Failed to pause",
        ]);
        await nextTurn();
        // Its guard stays (it never closes)
        deepStrictEqual(
          [counts(cancelled), counts(bodiless)],
          [
            [0, 0, 1, 1],
            [0, 0, 1, 1],
          ],
        );
        deepStrictEqual(
          [cancelled.calls, bodiless.calls],
          [["resume", "pause"], ["pause"]],
        );
        deepStrictEqual(
          [removed.get(cancelled)?.sort(), removed.get(bodiless)],
          [["close", "data", "end", "error"], []],
        );
      },
    );
  });

  test("whose destroy() emits nothing: once cancelled, the listeners of the send are removed at once, and only its guard stays, which reports a late error", async () => {
    const source = new Silent();
    const captured = capture();
    const sent = Promise.withResolvers<unknown>();
    await withApp(
      { logger: captured.logger, log_error_details: true, timeout: 50 },
      async (context: Context) => {
        sent.resolve(
          await context.send(source).then(
            () => null,
            (error: unknown) => error,
          ),
        );
      },
      async ({ port }) => {
        deepStrictEqual((await fetchBytes(port)).status, 503);
        const reason = await within(sent.promise);
        deepStrictEqual((reason as BindenAbortError).reason, "deadline");
        deepStrictEqual(source.calls, ["resume", "destroy"]);
        // Its guard: of `error` and `close`
        deepStrictEqual(counts(source), [0, 0, 1, 1]);
        source.emit("error", new Error("Late"));
        await captured.waitFor(released);
        deepStrictEqual(reported(captured), ["Late"]);
        // Until the turn after its close
        source.emit("close");
        deepStrictEqual(counts(source), [0, 0, 1, 1]);
        await nextTurn();
        deepStrictEqual(source.eventNames(), []);
      },
    );
  });

  test("shared by sends that release it or are cancelled: one guard", async () => {
    const source = new Silent();
    await withApp(
      { timeout: 20 },
      async (context: Context) => {
        // Released by `HEAD`, cancelled by the deadline otherwise
        await context.send(source);
      },
      async ({ port }) => {
        for (let round = 0; round < 5; round += 1) {
          const [head, get] = [
            await fetchBytes(port, { method: "HEAD" }),
            await fetchBytes(port),
          ];
          deepStrictEqual([head.status, get.status], [200, 503]);
        }
        deepStrictEqual(counts(source), [0, 0, 1, 1]);
        deepStrictEqual(
          source.calls.filter((call) => call === "destroy").length,
          10,
        );
      },
    );
  });

  test("to HEAD: its guard reports an error emitted after its close within the turn, and is removed once (a removal that throws is reported)", async () => {
    const captured = capture();
    const removed: string[] = [];
    // Closed twice, then an error
    const closing = Object.assign(new Emitting(), {
      destroy(): void {
        closing.emit("close");
        closing.emit("close");
        process.nextTick(() => {
          closing.emit("error", new Error("After close"));
        });
      },
      removeListener(event: string, listener: () => void): Emitting {
        removed.push(event);
        return EventEmitter.prototype.removeListener.call(
          closing,
          event,
          listener,
        ) as Emitting;
      },
    });
    const stuck = Object.assign(new Emitting(), {
      destroy(): void {
        stuck.emit("close");
      },
      removeListener(): never {
        throw new Error("Cannot remove");
      },
    });
    await withApp(
      { logger: captured.logger, log_error_details: true },
      async (context: Context) => {
        await context.send(context.url.pathname === "/stuck" ? stuck : closing);
      },
      async ({ port }) => {
        for (const path of ["/", "/stuck"]) {
          const received = await fetchBytes(port, { method: "HEAD", path });
          deepStrictEqual(received.status, 200);
        }
        await nextTurn();
        deepStrictEqual(reported(captured), ["After close", "Cannot remove"]);
        deepStrictEqual(
          [closing.eventNames(), removed],
          [[], ["error", "close"]],
        );
      },
    );
  });

  test("sends its data, read with its own methods", async () => {
    // As the types of `send()` take it
    const source: Emitting & IStreamLike = new Emitting();
    await withApp(
      {},
      async (context: Context) => {
        setTimeout(() => {
          source.emit("data", Buffer.from("a"));
          source.emit("data", "b");
          source.emit("end");
        }, 10);
        await context.send(source);
      },
      async ({ port }) => {
        const received = await fetchBytes(port);
        deepStrictEqual(
          [received.status, received.body.toString()],
          [200, "ab"],
        );
        // Resumed once read
        ok(source.calls.includes("resume"));
      },
    );
  });

  test("that has ended (`readableEnded`) is an empty body", async () => {
    const source = Object.assign(new Emitting(), { readableEnded: true });
    await withApp(
      {},
      async (context: Context) => {
        await context.send(source);
      },
      async ({ port }) => {
        const received = await fetchBytes(port);
        deepStrictEqual([received.status, received.body.toString()], [200, ""]);
        deepStrictEqual([source.eventNames(), source.calls], [[], []]);
      },
    );
  });

  test("an end or a close once destroyed is not its end: the error emitted within the turn rejects (not reported), and a later one is reported once (by the send until its listener is removed, then by its guard until the turn after its close)", async () => {
    for (const [flag, event] of [
      ["destroyed", "end"],
      ["_destroyed", "close"],
    ] as const) {
      const source = new Emitting();
      const captured = capture();
      let rejected: unknown = null;
      await withApp(
        { logger: captured.logger, log_error_details: true },
        async (context: Context) => {
          setTimeout(() => {
            Object.assign(source, { [flag]: true });
            source.emit(event);
            process.nextTick(() => {
              const error = new Error("Destroyed");
              source.emit("error", Object.assign(error, { code: "E_GONE" }));
            });
          }, 10);
          await context.send(source).catch((error: unknown) => {
            rejected = error;
            // Before the listener of the send is removed
            source.emit("error", new Error("Decided"));
            throw error;
          });
        },
        async ({ port }) => {
          deepStrictEqual((await fetchBytes(port)).status, 500);
          deepStrictEqual((rejected as { code?: unknown }).code, "E_GONE");
          await nextTurn();
          if (event === "end") {
            // Its guard, which has not seen its close
            deepStrictEqual(counts(source), [0, 0, 1, 1]);
            source.emit("error", new Error("Later"));
            source.emit("close");
            await nextTurn();
          }
          // The error of the send is not reported
          deepStrictEqual(
            [reported(captured), source.eventNames()],
            [event === "end" ? ["Decided", "Later"] : ["Decided"], []],
            flag,
          );
        },
      );
    }
  });

  test("destroyed, then cancelled within the turn: it is not destroyed again, only guarded", async () => {
    const source = new Silent();
    const readable = readStreamLike(
      source,
      streamLikeOf(source) as IStreamLikeMethods,
      () => new Error("Cancelled"),
      () => null,
    );
    const failure = once(readable, "error");
    readable.resume();
    Object.assign(source, { destroyed: true });
    source.emit("end");
    readable.destroy(new Error("Cancelled"));
    deepStrictEqual(((await failure)[0] as Error).message, "Cancelled");
    await nextTurn();
    // Neither destroyed nor paused
    deepStrictEqual(source.calls, []);
    // Its guard, until it closes
    deepStrictEqual(counts(source), [0, 0, 1, 1]);
  });

  test("removes each of its listeners once", async () => {
    const source = new Emitting();
    const removed: string[] = [];
    Object.assign(source, {
      removeListener(event: string, listener: () => void): Emitting {
        removed.push(event);
        EventEmitter.prototype.removeListener.call(source, event, listener);
        return source;
      },
    });
    const readable = readStreamLike(
      source,
      streamLikeOf(source) as IStreamLikeMethods,
      () => new Error("Cancelled"),
      () => null,
    );
    readable.on("error", () => null).resume();
    // Its `error` listener is removed on the next turn, and at once by an
    // error before
    source.emit("end");
    source.emit("error", new Error("Failed"));
    await nextTurn();
    deepStrictEqual(removed.sort(), ["close", "data", "end", "error"]);
    deepStrictEqual(source.eventNames(), []);
  });

  test("of chunks that are not bytes rejects", async () => {
    const source = new Emitting();
    const captured = capture();
    await withApp(
      { logger: captured.logger },
      async (context: Context) => {
        setTimeout(() => {
          source.emit("data", { not: "bytes" });
        }, 10);
        await context.send(source);
      },
      async ({ port }) => {
        deepStrictEqual((await fetchBytes(port)).status, 500);
        const { failure } = await captured.waitFor("The request has failed");
        deepStrictEqual(
          (failure as { code?: unknown }).code,
          "ERR_INVALID_ARG_TYPE",
        );
        deepStrictEqual(source.listenerCount("data"), 0);
      },
    );
  });
});

/**
 * A `Proxy` (of `target`, an empty object by default) whose every inspection
 * is recorded and throws (e.g. a getter of `on` that throws): `send()` must
 * not read it
 */
function untouchable(traps: string[], target: object = {}): object {
  const handler: ProxyHandler<object> = {};
  for (const trap of [
    "get",
    "has",
    "getPrototypeOf",
    "getOwnPropertyDescriptor",
    "ownKeys",
  ] as const) {
    handler[trap] = (): never => {
      traps.push(trap);
      throw new Error(`The source has been read (${trap})`);
    };
  }
  return new Proxy(target, handler);
}

suite("send() of a stream-like source that will not be sent", () => {
  test("with an informational status: destroys it (or pauses one without destroy()) without reading it, guarded until it has closed", async () => {
    const [, create] = libraries[2] as readonly [string, () => ISource];
    const source = create();
    const recorded = spy(source);
    const emitting = new Emitting();
    for (const sent of [source, emitting]) {
      const response = new BindenResponse(new IncomingMessage(new Socket()));
      await rejects(response.status(103).send(sent), TypeError);
    }
    ok(destroyed(source));
    await until(() => recorded.left().length === 0);
    deepStrictEqual(recorded.added.map(([event]) => event).sort(), [
      "close",
      "error",
    ]);
    deepStrictEqual(emitting.calls, ["pause"]);
    // Its guard, until it closes
    deepStrictEqual(counts(emitting), [0, 0, 1, 1]);
    // Without the framework: its error is not reported, nor thrown
    const failing = Object.assign(new Emitting(), {
      destroy(): void {
        failing.emit("error", new Error("Failed to close"));
      },
    });
    const response = new BindenResponse(new IncomingMessage(new Socket()));
    await rejects(response.status(103).send(failing), TypeError);
    // Its guard, until it closes
    deepStrictEqual(counts(failing), [0, 0, 1, 1]);
  });

  test("once the response has ended, or by a work that may no longer mutate it: resolves without touching it", async () => {
    const [, create] = libraries[2] as readonly [string, () => ISource];
    const traps: string[] = [];
    const ended = (): BindenResponse => {
      const response = new BindenResponse(new IncomingMessage(new Socket()));
      response.end();
      return response;
    };
    const revoked = (): BindenResponse => {
      const response = new BindenResponse(new IncomingMessage(new Socket()));
      response[kSeal](() => false);
      return response;
    };
    for (const respond of [ended, revoked]) {
      const source = create();
      const recorded = spy(source);
      const emitting = new Emitting();
      for (const sent of [source, emitting, untouchable(traps)]) {
        // @ts-expect-error -- an object that `send()` must not read
        await respond().send(sent);
      }
      ok(!destroyed(source));
      deepStrictEqual(
        [recorded.added, recorded.pauses, emitting.calls],
        [[], 0, []],
      );
    }
    deepStrictEqual(traps, []);
  });

  test("once the deadline has passed: a late send resolves without touching it", async () => {
    const traps: string[] = [];
    const late = Promise.withResolvers<unknown>();
    await withApp(
      { timeout: 20 },
      async (context: Context) => {
        await once(context.signal, "abort");
        await sleep(10);
        late.resolve(
          await context.response
            .send(
              // @ts-expect-error -- an object that `send()` must not read
              untouchable(traps),
            )
            .then(
              () => "resolved",
              (error: unknown) => error,
            ),
        );
      },
      async ({ port }) => {
        deepStrictEqual((await fetchBytes(port)).status, 503);
        deepStrictEqual(await within(late.promise), "resolved");
        deepStrictEqual(traps, []);
      },
    );
  });

  test("once the response has ended, or by a work that may no longer mutate it: a Node.js `Readable` is released by the methods of Node.js", async () => {
    const responses = [
      (): BindenResponse => {
        const response = new BindenResponse(new IncomingMessage(new Socket()));
        response.end();
        return response;
      },
      (): BindenResponse => {
        const response = new BindenResponse(new IncomingMessage(new Socket()));
        response[kSeal](() => false);
        return response;
      },
    ];
    const read: string[] = [];
    const traps: string[] = [];
    for (const respond of responses) {
      // Its own methods, which never run (nor their getters)
      const source = new Readable({
        read(): void {
          // Nothing to read
        },
      });
      for (const name of [
        "on",
        "off",
        "removeListener",
        "pause",
        "resume",
        "destroy",
      ]) {
        Object.defineProperty(source, name, {
          get(): never {
            read.push(name);
            throw new Error(`The source has been read (${name})`);
          },
        });
      }
      // A `Proxy` anywhere in its chain of prototypes: not touched
      const wrapped = new Readable();
      const proxied = new Readable();
      Object.setPrototypeOf(proxied, untouchable(traps, Readable.prototype));
      const behind: unknown = Object.create(
        untouchable(traps, Readable.prototype),
      );
      for (const sent of [
        source,
        untouchable(traps, wrapped),
        proxied,
        behind,
      ]) {
        const outcome = await respond()
          // @ts-expect-error -- not always data that `send()` takes
          .send(sent)
          .then(
            () => null,
            (error: unknown) => error,
          );
        deepStrictEqual(outcome, null);
      }
      // By `Readable.prototype.destroy()`, without being read
      deepStrictEqual([source.destroyed, source.readableFlowing], [true, null]);
      ok(!wrapped.destroyed);
      ok(!(Reflect.get(proxied, "_readableState") as Readable).destroyed);
    }
    deepStrictEqual([read, traps], [[], []]);
  });

  test("once the response has ended: a Node.js `Readable` whose release fails is logged, and its send resolves", async () => {
    const captured = capture();
    const outcomes = Promise.withResolvers<unknown[]>();
    const app = new Binden({ logger: captured.logger }).use(
      async (context: Context) => {
        context.response.end("ended");
        const sends: unknown[] = [];
        for (const sent of [
          // Its `_destroy()` throws: Node.js emits the error, which its guard
          // logs
          new Readable({
            read(): void {
              // Nothing to read
            },
            destroy(): void {
              throw new Error("Its destroy has failed");
            },
          }),
          // Not constructed as a `Readable`: its release throws at once
          Object.create(Readable.prototype) as Readable,
        ]) {
          sends.push(
            await context.response.send(sent).then(
              () => "resolved",
              (error: unknown) => error,
            ),
          );
        }
        outcomes.resolve(sends);
      },
    );
    const listening = await listen(app);
    try {
      const { status, body } = await fetchBytes(listening.port);
      deepStrictEqual([status, body.toString()], [200, "ended"]);
      deepStrictEqual(await within(outcomes.promise), ["resolved", "resolved"]);
      await captured.waitFor("A stream-like source has failed once released");
      await captured.waitFor("The release of an ignored stream has failed");
    } finally {
      await listening.close();
    }
  });

  test("its errors once it has closed or been cancelled do not crash the process", () => {
    // A `PassThrough` of `readable-stream` 2 destroyed with an error (its
    // `end` and its `close`, then the error, which is replied), a source that
    // emits `close` then an error, and the reason of the deadline (also
    // emitted once a destroy completes later)
    deepStrictEqual(fixture("stream-like-errors.ts"), {
      status: 0,
      stdout: "500 500 503 503\n0 0 0 0\n",
      stderr: "",
    });
  });

  test("the late errors of its destroy, without a listener of the application, are logged and do not crash the process", () => {
    // Released to `HEAD`, with 204, 304 and 103, its destroy failing at once;
    // ignored once the response has ended (not destroyed); an error after
    // its close; and destroys that fail 2 s later (released to `HEAD`, and
    // cancelled at the deadline)
    deepStrictEqual(fixture("stream-like-release.ts"), {
      status: 0,
      stdout:
        "200 204 304 500 200 200 200 503\n" +
        `${[
          ...Array.from({ length: 4 }, () => "Failed to close after 0 ms"),
          "Failed once closed",
          "Failed to close after 2000 ms",
          "Failed to close after 2000 ms",
        ].join(", ")}\n` +
        "0 0 0 0 0 0 0 0\n",
      stderr: "",
    });
  });

  test("the late errors of a source without destroy(), or destroyed by the application, without a listener of the application, are logged and do not crash the process", () => {
    // Its pause fails on the next tick (cancelled at the deadline, and
    // released with 204); destroyed before the send (`readable-stream` 2 and
    // 4 failing 20 ms later, a `PassThrough` of 2 on the next tick), or once
    // sent by an `end` (failing 20 ms later): the guards of those that never
    // close stay
    deepStrictEqual(fixture("stream-like-destroyed.ts"), {
      status: 0,
      stdout:
        "503 204 500 500 500 500\n" +
        `deadline resolved ${Array.from({ length: 4 }, () => "ERR_STREAM_PREMATURE_CLOSE").join(" ")}\n` +
        "Failed after its end, Failed after its pause, Failed after its pause, " +
        "Failed before the send (/v2), Failed before the send (/v4), Failed in the same turn\n" +
        "1 1 0 1 0 1\n",
      stderr: "",
    });
  });

  test("cancelled, whose destroy() emits nothing, does not keep its response: only its guard stays", () => {
    // 400 sources: no listener of their sends (`data`, `end`), and a guard
    // each (`error`, `close`)
    deepStrictEqual(fixture("stream-like-retention.ts", "--expose-gc"), {
      status: 0,
      stdout: "collected 0 0 400 400\n",
      stderr: "",
    });
  });
});

suite("guard() of a source", () => {
  test("by the methods of Node.js (emitterMethods): the own methods of a Readable are never read, the error of its destroy is reported, and it is removed on the turn after its close", async () => {
    const reports: unknown[] = [];
    const source = new Readable({
      read(): void {
        // Nothing to read
      },
      destroy(_error, callback): void {
        callback(new Error("Failed to close"));
      },
    });
    const read: string[] = [];
    for (const name of ["on", "removeListener", "off", "destroy"]) {
      Object.defineProperty(source, name, {
        get(): never {
          read.push(name);
          throw new Error(`${name} has been read`);
        },
      });
    }
    guard(source, emitterMethods, (error) => reports.push(error));
    guard(source, emitterMethods, (error) => reports.push(error));
    Readable.prototype.destroy.call(source);
    await nextTurn();
    await nextTurn();
    deepStrictEqual(
      [
        reports.map((error) => (error as Error).message),
        read,
        source.listenerCount("error"),
        source.listenerCount("close"),
      ],
      [["Failed to close"], [], 0, 0],
    );
  });
});

suite("send() of another object", () => {
  /** Objects that are neither bytes, a `Readable` nor a stream-like source, whose methods record their calls */
  const objects = (calls: string[]): Record<string, object> => {
    const method =
      (name: string): (() => void) =>
      (): void => {
        calls.push(name);
      };
    return {
      "a plain object": {},
      "an object with only on() and pipe()": {
        on: method("on"),
        pipe: method("pipe"),
      },
      "an object without removeListener() nor off()": {
        on: method("on"),
        pause: method("pause"),
        resume: method("resume"),
      },
      "an object without on()": {
        pause: method("pause"),
        resume: method("resume"),
        removeListener: method("removeListener"),
      },
      "an object without pause()": {
        on: method("on"),
        resume: method("resume"),
        removeListener: method("removeListener"),
      },
      "an object without resume()": {
        on: method("on"),
        pause: method("pause"),
        off: method("off"),
      },
      "a function": Object.assign(method("call"), {
        on: method("on"),
      }),
      "a DataView": new DataView(new ArrayBuffer(2)),
      URLSearchParams: new URLSearchParams("a=b"),
    };
  };

  test("rejects with a TypeError before anything is changed, without calling it", async () => {
    const calls: string[] = [];
    for (const [name, value] of [
      ...Object.entries(objects(calls)),
      ["null", null],
    ] as const) {
      const response = new BindenResponse(new IncomingMessage(new Socket()));
      response.setHeader("Content-Length", 3);
      // @ts-expect-error -- not data that `send()` takes
      const sent = response.send(value);
      await rejects(
        sent,
        (error: unknown) =>
          error instanceof TypeError &&
          error.message.startsWith("The data is not a string"),
        name,
      );
      deepStrictEqual(
        [
          response.started,
          response.headersSent,
          response.getHeader("Content-Length"),
        ],
        [false, false, 3],
        name,
      );
    }
    deepStrictEqual(calls, []);
  });

  test("is a 500 through the error handler", async () => {
    await withApp(
      {},
      async (context: Context) => {
        // @ts-expect-error -- not data that `send()` takes
        await context.send({ toString: () => "text" });
      },
      async ({ port }) => {
        const received = await fetchBytes(port);
        deepStrictEqual([received.status, received.body.toString()], [500, ""]);
      },
    );
  });

  test("a Uint8Array is sent as its bytes", async () => {
    const bytes = new Uint8Array([0x61, 0x62, 0x63, 0x64]).subarray(1, 3);
    await withApp(
      {},
      async (context: Context) => {
        await context.send(bytes);
      },
      async ({ port }) => {
        const received = await fetchBytes(port);
        deepStrictEqual(
          [
            received.status,
            received.body.toString(),
            received.headers["content-length"],
          ],
          [200, "bc", "2"],
        );
      },
    );
  });

  test("is ignored once the response is sealed, as any send", async () => {
    const response = new BindenResponse(new IncomingMessage(new Socket()));
    response.end();
    // Resolves, without a `TypeError`
    // @ts-expect-error -- not data that `send()` takes
    await response.send({});
  });
});
