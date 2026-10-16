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
  readStreamLike,
  streamLikeOf,
} from "../src/stream-like.js";
import { IncomingMessage, request as httpRequest } from "node:http";
import { Socket, connect } from "node:net";
import { deepStrictEqual, ok, rejects } from "node:assert/strict";
import { suite, test } from "node:test";
import { createRequire } from "node:module";
import { join } from "node:path";
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

    test("destroys the source with the reason of the deadline, and removes its listeners", async () => {
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
          await nextTurn();
          deepStrictEqual((reason() as BindenAbortError).reason, "deadline");
          deepStrictEqual(recorded.left(), []);
          deepStrictEqual(recorded.added.length, 4);
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

    test("rejects at once for a source that has been destroyed, without listening to it", async () => {
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
          deepStrictEqual([recorded.added, recorded.destroys], [[], []]);
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
      // A `PassThrough` of `readable-stream` 2 emits its `end` once
      // destroyed: an empty body, as through a pipe
      const ends =
        how === "closes before its end" && library === "readable-stream 2";
      test(`${ends ? "ends" : "rejects"} when the source ${how}, and removes its listeners`, async () => {
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
              [ends ? 200 : 500, ""],
            );
            deepStrictEqual(
              (rejected as { code?: unknown } | null)?.code,
              ends
                ? none
                : how === "fails"
                  ? "E_FAILED"
                  : "ERR_STREAM_PREMATURE_CLOSE",
            );
            await nextTurn();
            deepStrictEqual(recorded.left(), []);
          },
        );
      });
    }

    for (const [method, status] of [
      ["HEAD", 200],
      ["GET", 204],
      ["GET", 304],
    ] as const) {
      test(`sends no body to ${method} with ${status}: the source is destroyed without being read`, async () => {
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
            deepStrictEqual(recorded.added, []);
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

suite("send() of a stream-like source", () => {
  test("without destroy(): pauses it once cancelled, and removes every listener", async () => {
    const source = new Emitting();
    const removed: string[] = [];
    // Only `off()`: its listeners are removed by it
    Object.assign(source, {
      removeListener: null,
      off(event: string, listener: () => void): Emitting {
        removed.push(event);
        EventEmitter.prototype.removeListener.call(source, event, listener);
        return source;
      },
    });
    await withApp(
      { timeout: 50 },
      async (context: Context) => {
        await context.send(source);
      },
      async ({ port }) => {
        deepStrictEqual((await fetchBytes(port)).status, 503);
        await until(() => source.calls.at(-1) === "pause");
        await nextTurn();
        deepStrictEqual(
          ["data", "end", "error", "close"].map((event) =>
            source.listenerCount(event),
          ),
          [0, 0, 0, 0],
        );
        deepStrictEqual(removed.sort(), ["close", "data", "end", "error"]);
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

suite("send() of a stream-like source that will not be sent", () => {
  /** Responses that do not send it */
  const responses: Record<string, () => BindenResponse> = {
    "once the response has ended": () => {
      const response = new BindenResponse(new IncomingMessage(new Socket()));
      response.end();
      return response;
    },
    "with an informational status": () =>
      new BindenResponse(new IncomingMessage(new Socket())).status(103),
  };

  for (const [name, respond] of Object.entries(responses)) {
    test(`${name}: destroys it (or pauses one without destroy()) without listening to it`, async () => {
      const [, create] = libraries[2] as readonly [string, () => ISource];
      const source = create();
      const recorded = spy(source);
      const emitting = new Emitting();
      for (const sent of [source, emitting]) {
        await respond()
          .send(sent)
          .catch(() => null);
      }
      ok(destroyed(source));
      deepStrictEqual(recorded.added, []);
      deepStrictEqual(emitting.calls, ["pause"]);
      deepStrictEqual(emitting.eventNames(), []);
    });
  }

  test("its errors once it has closed or been cancelled do not crash the process", () => {
    // A `PassThrough` of `readable-stream` 2 destroyed with an error (its
    // `end`, then the error), a source that emits `close` then an error, and
    // the reason of the deadline (also emitted once a destroy completes later)
    const { status, stdout, stderr } = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(import.meta.dirname, "fixtures", "stream-like-errors.ts"),
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    deepStrictEqual(
      { status, stdout, stderr },
      { status: 0, stdout: "200 500 503 503\n0 0 0 0\n", stderr: "" },
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
