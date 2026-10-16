import {
  Binden,
  BindenError,
  BindenResponse,
  type Context,
  type IBindenOptions,
  shutdown,
} from "../index.js";
import { EventEmitter, once } from "node:events";
import {
  type ICaptured,
  type IListening,
  capture,
  listen,
  never,
  sleep,
  within,
} from "./helpers.js";
import {
  PassThrough,
  Readable,
  Stream,
  Transform,
  finished,
  pipeline,
} from "node:stream";
import { Socket, connect } from "node:net";
import { deepStrictEqual, ok } from "node:assert/strict";
import { kListen, kOwnership, kUnlisten, owners } from "../src/seal.js";
import { suite, test } from "node:test";
import { IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import { pipeline as pipelineAsync } from "node:stream/promises";

/** Runs `fn` with a listening application (with a captured debug logger) */
async function withApp(
  options: IBindenOptions,
  setup: (app: Binden) => void,
  fn: (listening: IListening, captured: ICaptured) => Promise<void>,
): Promise<void> {
  const captured = capture();
  const app = new Binden({ ...options, logger: captured.logger });
  setup(app);
  const listening = await listen(app);
  try {
    await fn(listening, captured);
  } finally {
    await listening.close();
  }
}

/** A response as the client has received it on its connection */
interface IRaw {
  /** Everything received (e.g. a second reply after the first one) */
  readonly raw: string;
  readonly status: number | null;
  readonly head: string;
  /** The body, decoded from its chunks */
  readonly body: string;
  /** Whether the body has been received in full (as framed) */
  readonly complete: boolean;
  /** Whether the server has closed the connection */
  readonly closed: boolean;
}

/** The body framed by its head in `rest`, and whether it is complete */
function bodyOf(head: string, rest: string): [string, boolean] {
  if (/^Transfer-Encoding: chunked$/imu.test(head)) {
    let body = "";
    let at = 0;
    for (;;) {
      const end = rest.indexOf("\r\n", at);
      if (end === -1) {
        return [body, false];
      }
      const size = Number.parseInt(rest.slice(at, end), 16);
      if (size === 0) {
        return [body, rest.startsWith("\r\n", end + 2)];
      } else if (rest.length < end + 2 + size + 2) {
        return [body + rest.slice(end + 2), false];
      }
      body += rest.slice(end + 2, end + 2 + size);
      at = end + 2 + size + 2;
    }
  }
  const length = Number(/^Content-Length: (?<n>\d+)$/imu.exec(head)?.groups?.n);
  return Number.isNaN(length)
    ? [rest, false]
    : [rest.slice(0, length), rest.length >= length];
}

/**
 * Sends a request on a new connection and reads its response: until it is
 * complete (and `linger` more milliseconds, for anything that follows), or
 * the connection is closed, within `ms`
 */
async function exchange(
  port: number,
  { path = "/", linger = 30, ms = 5000 } = {},
): Promise<IRaw> {
  const socket = connect(port, "localhost");
  await once(socket, "connect");
  let raw = "";
  let closed = false;
  socket.setEncoding("latin1").on("data", (chunk: string) => {
    raw += chunk;
  });
  socket.on("close", () => {
    closed = true;
  });
  socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`);
  const parse = (): IRaw => {
    const end = raw.indexOf("\r\n\r\n");
    const head = end === -1 ? raw : raw.slice(0, end);
    const [body, complete] =
      end === -1 ? ["", false] : bodyOf(head, raw.slice(end + 4));
    const status = /^HTTP\/1\.1 (?<code>\d{3})/u.exec(head)?.groups?.code;
    return {
      raw,
      status: typeof status === "undefined" ? null : Number(status),
      head,
      body,
      complete,
      closed,
    };
  };
  const deadline = Date.now() + ms;
  try {
    for (
      let reply = parse();
      !reply.closed && !reply.complete && Date.now() < deadline;
      reply = parse()
    ) {
      await sleep(5);
    }
    await sleep(linger);
    return parse();
  } finally {
    socket.destroy();
  }
}

/** Whether the error is the `503` of a deadline */
function isDeadline(error: unknown): boolean {
  return error instanceof BindenError && error.code === "deadline";
}

/** A response without a connection: nothing is actually sent */
function detached(): BindenResponse {
  return new BindenResponse(new IncomingMessage(new Socket()));
}

/** A source that never ends (nor pushes anything by itself) */
function silent(): PassThrough {
  return new PassThrough();
}

/**
 * Feeds a source from a timer created outside of any request (a work of no
 * request, e.g. a shared broadcaster): its chunks once `start()` is called,
 * then its end
 */
function feeder(
  source: PassThrough,
  chunks: readonly string[],
): { start(): void; stop(): void } {
  let started = false;
  const pending = [...chunks];
  const timer = owners.exit(() =>
    setInterval(() => {
      if (!started) {
        return;
      }
      const chunk = pending.shift();
      if (typeof chunk === "undefined") {
        clearInterval(timer);
        source.end();
      } else {
        source.write(chunk);
      }
    }, 5),
  );
  return {
    start: (): void => {
      started = true;
    },
    stop: (): void => {
      clearInterval(timer);
    },
  };
}

/** The messages of the records of a captured logger, at a level */
function messages(captured: ICaptured, level: number): unknown[] {
  return captured.records
    .filter((record) => record.level === level)
    .map(({ msg }) => msg);
}

/** A head that Node.js refuses (an invalid reason phrase) */
const refused = "bad\n";

const require = createRequire(import.meta.url);

/** The streams of a version of `readable-stream` (typed as those of Node.js) */
interface IReadableStream {
  readonly PassThrough: new () => PassThrough;
}

/** `readable-stream` 2 and 3 (the streams of Node.js 10), and 4 (a control) */
const libraries: readonly (readonly [string, IReadableStream])[] = [
  ["2", require("readable-stream-v2") as IReadableStream],
  ["3", require("readable-stream-v3") as IReadableStream],
  ["4", require("readable-stream-v4") as IReadableStream],
];

/** `through2` 2 (a transform of `readable-stream` 2) */
const through2 = require("through2-v2") as (
  transform: (
    chunk: Buffer,
    encoding: string,
    callback: (error: null, chunk: string) => void,
  ) => void,
) => PassThrough;

/**
 * Wraps `on()` and `emit()` on a response, as an instrumentation does (e.g.
 * with `shimmer`): the wrappers call the methods of the response
 */
function instrument(response: BindenResponse): void {
  for (const name of ["on", "emit"] as const) {
    const original = Reflect.get(response, name) as (
      ...args: unknown[]
    ) => unknown;
    response[name] = function wrapper(
      this: BindenResponse,
      ...args: unknown[]
    ): unknown {
      return Reflect.apply(original, this, args);
    } as never;
  }
}

suite("A pipe into the response", () => {
  suite(
    "adopted (its owner writes and ends it, whatever work feeds it)",
    () => {
      test("`pipeline()` of an error handler, fed by a work of no request, ends the reply", async () => {
        const source = silent();
        const feed = feeder(source, ["REAL", "!"]);
        try {
          await withApp(
            {
              timeout: 20,
              error_handler_timeout: 2000,
              error_handler: async (context: Context, error): Promise<void> => {
                if (!isDeadline(error)) {
                  return;
                }
                context.response.status(503).type("text/plain");
                const piped = pipelineAsync(source, context.response);
                feed.start();
                await piped;
              },
            },
            (app) => {
              app.use(async () => {
                await never();
              });
            },
            async ({ port }, captured) => {
              const reply = await exchange(port);
              deepStrictEqual(
                [reply.status, reply.body, reply.complete, reply.closed],
                [503, "REAL!", true, false],
              );
              deepStrictEqual(messages(captured, 50), []);
            },
          );
        } finally {
          feed.stop();
        }
      });

      test("a listener that another work adds to the source in the same turn writes nothing", async () => {
        const source = silent();
        const feed = feeder(source, ["REAL"]);
        try {
          await withApp(
            {
              timeout: 20,
              error_handler: async (context: Context, error): Promise<void> => {
                if (!isDeadline(error)) {
                  return;
                }
                context.response.status(503).type("text/plain");
                source.pipe(context.response);
                feed.start();
                await new Promise<void>((resolve) => {
                  context.response.once("finish", resolve);
                });
              },
            },
            (app) => {
              app.use(async (context: Context) => {
                // Of the abandoned work: prepended, it runs before the
                // listeners of the pipe
                context.response.prependListener("pipe", (piped: Readable) => {
                  piped.on("data", () => {
                    context.response.write("OLD");
                  });
                });
                await never();
              });
            },
            async ({ port }) => {
              const reply = await exchange(port);
              deepStrictEqual(
                [reply.status, reply.body, reply.complete],
                [503, "REAL", true],
              );
            },
          );
        } finally {
          feed.stop();
        }
      });

      for (const first of ["/a", "/b"]) {
        test(`one source of the works of two requests (${first} pipes first in the turn): the end of each fails its own work`, async () => {
          const source = silent();
          const start = Promise.withResolvers<unknown>();
          const waiting: string[] = [];
          const settled: Record<string, unknown> = {};
          await withApp(
            {},
            (app) => {
              app.use(async (context: Context) => {
                const { pathname } = context.url;
                if (pathname === "/a") {
                  context.response.statusMessage = refused;
                }
                waiting.push(pathname);
                await start.promise;
                pipelineAsync(source, context.response).then(
                  () => {
                    settled[pathname] = null;
                  },
                  (error: unknown) => {
                    settled[pathname] = (error as { code?: string }).code;
                  },
                );
                await never();
              });
            },
            async ({ port }) => {
              const order = first === "/a" ? ["/a", "/b"] : ["/b", "/a"];
              const replies: Promise<IRaw>[] = [];
              for (const path of order) {
                replies.push(exchange(port, { path }));
                while (waiting.length < replies.length) {
                  await sleep(5);
                }
              }
              // Both pipe in the same turn, in that order
              start.resolve(null);
              // Its end from a work of no request
              owners.exit(() => {
                setTimeout(() => {
                  source.end();
                }, 10);
              });
              const [one, two] = (await Promise.all(replies)) as [IRaw, IRaw];
              const [a, b] = first === "/a" ? [one, two] : [two, one];
              deepStrictEqual([a.status, a.complete], [500, true]);
              deepStrictEqual([b.status, b.body, b.complete], [200, "", true]);
              deepStrictEqual(settled, {
                "/a": "ERR_INVALID_CHAR",
                "/b": null,
              });
            },
          );
        });
      }

      test("one source of a failed work and of an independent destination: the destination gets every chunk", async () => {
        const source = silent();
        const feed = feeder(source, ["x", "y"]);
        const destination = new PassThrough();
        let collected = "";
        destination.setEncoding("latin1").on("data", (chunk: string) => {
          collected += chunk;
        });
        const ended = once(destination, "end");
        owners.exit(() => {
          source.pipe(destination);
        });
        try {
          await withApp(
            {},
            (app) => {
              app.use(async (context: Context) => {
                // Its first write fails
                context.response.statusMessage = refused;
                source.pipe(context.response);
                feed.start();
                await never();
              });
            },
            async ({ port }) => {
              const reply = await exchange(port);
              deepStrictEqual([reply.status, reply.complete], [500, true]);
              await within(ended);
              deepStrictEqual([collected, source.errored], ["xy", null]);
            },
          );
        } finally {
          feed.stop();
        }
      });

      test("a throwing `end` listener that the abandoned work adds to the source from its listener of `pipe` is logged", async () => {
        const source = silent();
        const feed = feeder(source, ["REAL"]);
        try {
          await withApp(
            {
              timeout: 20,
              error_handler: async (context: Context, error): Promise<void> => {
                if (!isDeadline(error)) {
                  return;
                }
                context.response.status(503).type("text/plain");
                source.pipe(context.response);
                feed.start();
                await once(context.response, "finish");
              },
            },
            (app) => {
              app.use(async (context: Context) => {
                context.response.prependListener("pipe", (piped: Readable) => {
                  // In the window of the pipe of the error handler
                  piped.once("end", () => {
                    throw new Error("A listener of the application has failed");
                  });
                });
                await never();
              });
            },
            async ({ port }, captured) => {
              const reply = await exchange(port);
              deepStrictEqual(
                [reply.status, reply.body, reply.complete],
                [503, "REAL", true],
              );
              await captured.waitFor("A pipe of an abandoned work has failed");
            },
          );
        } finally {
          feed.stop();
        }
      });

      test("a source that has ended already ends the reply as its owner", async () => {
        await withApp(
          {
            timeout: 20,
            error_handler: async (context: Context, error): Promise<void> => {
              if (!isDeadline(error)) {
                return;
              }
              const ended = new PassThrough();
              ended.end();
              ended.resume();
              await once(ended, "end");
              context.response.status(503);
              ended.pipe(context.response);
              await once(context.response, "finish");
            },
          },
          (app) => {
            app.use(async () => {
              await never();
            });
          },
          async ({ port }) => {
            const reply = await exchange(port);
            deepStrictEqual(
              [reply.status, reply.body, reply.complete],
              [503, "", true],
            );
          },
        );
      });

      test("with `{ end: false }`, the owner ends the reply itself", async () => {
        const source = silent();
        const feed = feeder(source, ["a", "b"]);
        try {
          await withApp(
            {
              timeout: 20,
              error_handler: async (context: Context, error): Promise<void> => {
                if (!isDeadline(error)) {
                  return;
                }
                context.response.status(503).type("text/plain");
                source.pipe(context.response, { end: false });
                feed.start();
                await once(source, "end");
                context.response.end("c");
              },
            },
            (app) => {
              app.use(async () => {
                await never();
              });
            },
            async ({ port }) => {
              const reply = await exchange(port);
              deepStrictEqual(
                [reply.status, reply.body, reply.complete],
                [503, "abc", true],
              );
            },
          );
        } finally {
          feed.stop();
        }
      });

      test("two responses pipe one source in one turn: both bodies are exact", async () => {
        const source = silent();
        const feed = feeder(source, ["x", "y"]);
        const start = Promise.withResolvers<unknown>();
        const count = { waiting: 0, piped: 0 };
        try {
          await withApp(
            {},
            (app) => {
              app.use(async (context: Context) => {
                count.waiting += 1;
                await start.promise;
                source.pipe(context.response);
                count.piped += 1;
                if (count.piped === 2) {
                  // The patches of the window, until the end of the turn
                  ok(Object.hasOwn(source, "on"));
                  feed.start();
                }
                await once(context.response, "finish");
              });
            },
            async ({ port }) => {
              const replies = Promise.all([exchange(port), exchange(port)]);
              while (count.waiting < 2) {
                await sleep(5);
              }
              // Both pipe in the same turn
              start.resolve(null);
              const [first, second] = await replies;
              deepStrictEqual(count.piped, 2);
              deepStrictEqual(
                [first.body, second.body, first.complete, second.complete],
                ["xy", "xy", true, true],
              );
              // Restored: the methods of its class
              ok(
                !Object.hasOwn(source, "on") && !Object.hasOwn(source, "once"),
              );
            },
          );
        } finally {
          feed.stop();
        }
      });
    },
  );

  suite("of an abandoned work (its response is closed for it)", () => {
    for (const [name, end] of [
      [
        "ends",
        (source: PassThrough): void => {
          source.push(null);
        },
      ],
      [
        "destroys",
        (source: PassThrough): void => {
          source.destroy();
        },
      ],
    ] as const) {
      for (const streams of [2, 3]) {
        test(`its \`pipeline()\` of ${streams} streams settles at once, and never ends the reply when the new owner ${name} its source`, async () => {
          const source = silent();
          const settled = Promise.withResolvers<unknown>();
          await withApp(
            {
              timeout: 20,
              error_handler: async (context: Context, error): Promise<void> => {
                if (!isDeadline(error)) {
                  return;
                }
                end(source);
                await sleep(20);
                // Finished at the abandonment: it has not ended the reply
                deepStrictEqual(await within(settled.promise, 0), {
                  code: "ERR_STREAM_PREMATURE_CLOSE",
                });
                await context.status(503).send("new");
              },
            },
            (app) => {
              app.use(async (context: Context) => {
                const piped =
                  streams === 2
                    ? pipelineAsync(source, context.response)
                    : pipelineAsync(
                        source,
                        new PassThrough(),
                        context.response,
                      );
                piped.then(
                  () => {
                    settled.resolve(null);
                  },
                  (error: unknown) => {
                    settled.resolve({
                      code: (error as { code?: string }).code,
                    });
                  },
                );
                await never();
              });
            },
            async ({ port }) => {
              const reply = await exchange(port);
              deepStrictEqual(
                [reply.status, reply.body, reply.complete, reply.closed],
                [503, "new", true, false],
              );
            },
          );
        });
      }
    }

    test("its plain pipe of a source that the new owner pipes is unpiped: the new body is exact, the source alive", async () => {
      const source = silent();
      const feed = feeder(source, ["REAL"]);
      try {
        await withApp(
          {
            timeout: 20,
            error_handler: async (context: Context, error): Promise<void> => {
              if (!isDeadline(error)) {
                return;
              }
              ok(!source.destroyed);
              context.response.status(503).type("text/plain");
              source.pipe(context.response);
              feed.start();
              await once(context.response, "finish");
            },
          },
          (app) => {
            app.use(async (context: Context) => {
              context.response.type("text/html");
              source.pipe(context.response);
              await never();
            });
          },
          async ({ port }) => {
            const reply = await exchange(port);
            deepStrictEqual(
              [reply.status, reply.body, reply.complete],
              [503, "REAL", true],
            );
            ok(/^Content-Type: text\/plain/imu.test(reply.head), reply.head);
          },
        );
      } finally {
        feed.stop();
      }
    });

    test("its pipe whose own `close` listener is gone is unpiped all the same", async () => {
      const source = silent();
      await withApp(
        {
          timeout: 20,
          error_handler: async (context: Context, error): Promise<void> => {
            if (!isDeadline(error)) {
              return;
            }
            await context.status(503).send(`${source.listenerCount("data")}`);
          },
        },
        (app) => {
          app.use(async (context: Context) => {
            const { response } = context;
            source.pipe(response);
            // The `close` listener of the pipe of Node.js (its `onclose()`)
            for (const listener of response.rawListeners("close")) {
              const wrapped = Reflect.get(listener, "listener") as
                (() => void) | undefined;
              const { name } = wrapped ?? listener;
              if (name === "onclose") {
                response.removeListener("close", listener as () => void);
              }
            }
            await never();
          });
        },
        async ({ port }) => {
          const reply = await exchange(port);
          deepStrictEqual([reply.status, reply.body], [503, "0"]);
        },
      );
    });

    test("its `close` listeners run once, at the abandonment; those of the framework at the real close", async () => {
      const calls: string[] = [];
      const cleaned = Promise.withResolvers<unknown>();
      await withApp(
        {
          timeout: 20,
          access_log: true,
          error_handler: async (context: Context, error): Promise<void> => {
            if (!isDeadline(error)) {
              return;
            }
            // Before the reply of the deadline
            deepStrictEqual(calls, ["close"]);
            calls.push("reply");
            await context.status(503).send("deadline!");
          },
        },
        (app) => {
          app.use(async (context: Context) => {
            context.onCleanup(() => {
              calls.push("cleanup");
              cleaned.resolve(null);
            });
            context.response.on("close", () => {
              calls.push("close");
            });
            await never();
          });
        },
        async ({ port }, captured) => {
          const reply = await exchange(port);
          deepStrictEqual([reply.status, reply.body], [503, "deadline!"]);
          await within(cleaned.promise);
          deepStrictEqual(calls, ["close", "reply", "cleanup"]);
          const logged = captured.records.filter(
            ({ msg }) => msg === "The request has completed",
          );
          deepStrictEqual(
            logged.map(({ status, body_bytes }) => [status, body_bytes]),
            [[503, 9]],
          );
        },
      );
    });

    test("a `close` listener that it adds later runs at once, and `finished()` settles", async () => {
      const outcome = Promise.withResolvers<unknown>();
      await withApp(
        {
          timeout: 20,
          error_handler: async (context: Context, error): Promise<void> => {
            if (!isDeadline(error)) {
              return;
            }
            await sleep(30);
            await context.status(503).send("deadline");
          },
        },
        (app) => {
          app.use(async (context: Context) => {
            await sleep(40);
            finished(context.response, (error) => {
              outcome.resolve((error as { code?: string } | undefined)?.code);
            });
            await never();
          });
        },
        async ({ port }) => {
          const replied = exchange(port);
          // Before the reply of the deadline has been sent
          deepStrictEqual(
            await within(outcome.promise, 60),
            "ERR_STREAM_PREMATURE_CLOSE",
          );
          deepStrictEqual((await replied).status, 503);
        },
      );
    });

    test("the `close` listeners of an error handler that times out run before the reply that replaces it", async () => {
      const sent: boolean[] = [];
      await withApp(
        {
          error_handler_timeout: 30,
          error_handler: async (context: Context): Promise<void> => {
            context.response.on("close", () => {
              sent.push(context.response.headersSent);
            });
            await never();
          },
        },
        (app) => {
          app.use(() => {
            throw new BindenError(409);
          });
        },
        async ({ port }) => {
          const reply = await exchange(port);
          deepStrictEqual([reply.status, reply.complete], [500, true]);
          deepStrictEqual(sent, [false]);
        },
      );
    });

    test("a `close` listener of the abandoned work that throws is logged", async () => {
      await withApp(
        { timeout: 20 },
        (app) => {
          app.use(async (context: Context) => {
            context.response.on("close", () => {
              throw new Error("A cleanup has failed");
            });
            await never();
          });
        },
        async ({ port }, captured) => {
          const reply = await exchange(port);
          deepStrictEqual(reply.status, 503);
          await captured.waitFor("A listener of an abandoned work has failed");
        },
      );
    });

    test("an observer of the framework (closed by the real close only) is removed by `kUnlisten`, not by `removeListener()`", () => {
      const response = detached();
      let closed = 0;
      const listener = (): void => {
        closed += 1;
      };
      response[kListen]("close", listener, { once: false });
      response.removeListener("close", listener);
      response.emit("close");
      response[kUnlisten]("close", listener);
      response.emit("close");
      deepStrictEqual(closed, 1);
    });
  });

  suite("that fails (its owner fails with its error)", () => {
    test("of the stack, before the headers: the error handler replies, and the deadline still applies", async () => {
      const seen: unknown[] = [];
      await withApp(
        {
          timeout: 100,
          error_handler: async (context: Context, error): Promise<void> => {
            if (isDeadline(error)) {
              seen.push((context.signal.reason as { reason?: string }).reason);
              await context.status(503).send("deadline");
              return;
            }
            seen.push(error instanceof TypeError, context.signal.aborted);
            // Slower than the deadline: it takes the reply over
            await sleep(300);
            await context.status(502).send("late");
          },
        },
        (app) => {
          app.use(async (context: Context) => {
            // Refused (see below): its pipe fails at once
            context.response.on("newListener", () => null);
            Readable.from(["body"]).pipe(context.response);
            await never();
          });
        },
        async ({ port }) => {
          const reply = await exchange(port, { linger: 350 });
          deepStrictEqual(
            [reply.status, reply.body, reply.complete, reply.closed],
            [503, "deadline", true, false],
          );
          ok(!reply.raw.includes("late"), reply.raw);
          deepStrictEqual(seen, [true, false, "deadline"]);
        },
      );
    });

    for (const [form, streams] of [
      ["promise", 2],
      ["promise", 3],
      ["callback", 2],
      ["callback", 3],
    ] as const) {
      test(`refused while \`pipeline()\` (${form}, ${streams} streams) is created: it settles with the error, one reply`, async () => {
        const settled = Promise.withResolvers<unknown>();
        await withApp(
          {},
          (app) => {
            app.use(async (context: Context) => {
              const { response } = context;
              // Code that the pipe would run while it adds its listeners
              response.on("newListener", () => null);
              const chain =
                streams === 2
                  ? [silent(), response]
                  : [silent(), new PassThrough(), response];
              if (form === "promise") {
                pipelineAsync(chain).then(
                  () => {
                    settled.resolve(null);
                  },
                  (error: unknown) => {
                    settled.resolve(error);
                  },
                );
              } else {
                pipeline(chain, (error) => {
                  settled.resolve(error ?? null);
                });
              }
              await never();
            });
          },
          async ({ port }, captured) => {
            const reply = await exchange(port, { linger: 50 });
            deepStrictEqual(
              [reply.status, reply.complete, reply.closed],
              [500, true, false],
            );
            deepStrictEqual(reply.raw.match(/HTTP\/1\.1/gu)?.length, 1);
            const error = (await within(settled.promise)) as Error;
            ok(error instanceof TypeError, String(error));
            ok(error.message.includes("refused"), error.message);
            const failures = captured.records
              .filter(({ msg }) => msg === "The request has failed")
              .map(({ failure }) => (failure as { type: string }).type);
            deepStrictEqual(failures, ["TypeError"]);
          },
        );
      });
    }

    test("of a middleware that has settled meanwhile: the next middleware does not run", async () => {
      const ran = { next: false };
      await withApp(
        {},
        (app) => {
          app
            .use((context: Context) => {
              // Settled before its pipe fails (not `async`)
              const settled = Promise.resolve();
              // Refused: its pipe fails at once
              context.response.on("newListener", () => null);
              silent().pipe(context.response);
              return settled;
            })
            .use(() => {
              ran.next = true;
            });
        },
        async ({ port }) => {
          const reply = await exchange(port);
          deepStrictEqual([reply.status, reply.complete], [500, true]);
          deepStrictEqual(ran, { next: false });
        },
      );
    });

    for (const done of [false, true]) {
      test(`of a synchronous middleware${done ? " that sets `done`" : ""}: the next middleware does not run`, async () => {
        const ran = { next: false };
        await withApp(
          {},
          (app) => {
            app
              .use((context: Context) => {
                // Refused: its pipe fails at once
                context.response.on("newListener", () => null);
                silent().pipe(context.response);
                context.done = done;
              })
              .use(async (context: Context) => {
                ran.next = true;
                await context.json({ next: true });
              });
          },
          async ({ port }, captured) => {
            const reply = await exchange(port, { linger: 50 });
            deepStrictEqual([reply.status, reply.complete], [500, true]);
            deepStrictEqual(reply.raw.match(/HTTP\/1\.1/gu)?.length, 1);
            deepStrictEqual(ran, { next: false });
            deepStrictEqual(messages(captured, 50), ["The request has failed"]);
          },
        );
      });
    }

    test("an `error` that its listener emits again reaches no other work, nor throws", async () => {
      const received: string[] = [];
      await withApp(
        {},
        (app) => {
          app.use(async (context: Context) => {
            const { response } = context;
            // Of a work of no request
            owners.exit(() => {
              response.on("error", () => {
                received.push("other");
              });
            });
            response.on("error", (error: Error) => {
              received.push("own");
              response.emit("error", error);
            });
            response.statusMessage = refused;
            Readable.from(["body"]).pipe(response);
            await never();
          });
        },
        async ({ port }) => {
          const reply = await exchange(port);
          deepStrictEqual([reply.status, reply.complete], [500, true]);
          deepStrictEqual(received, ["own"]);
        },
      );
    });

    test("of an error handler, whose source fails before its end: it fails at once", async () => {
      const source = silent();
      await withApp(
        {
          error_handler_timeout: 5000,
          error_handler: async (context: Context): Promise<void> => {
            context.response.status(409);
            source.pipe(context.response);
            owners.exit(() => {
              setTimeout(() => {
                source.destroy(new Error("The source has failed"));
              }, 10);
            });
            await never();
          },
        },
        (app) => {
          app.use(() => {
            throw new BindenError(409);
          });
        },
        async ({ port }, captured) => {
          const started = Date.now();
          const reply = await exchange(port);
          deepStrictEqual([reply.status, reply.complete], [500, true]);
          ok(Date.now() - started < 1000);
          ok(
            messages(captured, 50).includes(
              "The provided `error_handler` has failed",
            ),
          );
        },
      );
    });

    test("of an error handler, whose source closes before its end: it fails at once", async () => {
      const source = silent();
      await withApp(
        {
          error_handler_timeout: 5000,
          error_handler: async (context: Context): Promise<void> => {
            source.pipe(context.response);
            owners.exit(() => {
              setTimeout(() => {
                source.destroy();
              }, 10);
            });
            await never();
          },
        },
        (app) => {
          app.use(() => {
            throw new BindenError(409);
          });
        },
        async ({ port }) => {
          const reply = await exchange(port);
          deepStrictEqual([reply.status, reply.complete], [500, true]);
        },
      );
    });

    test("`pipeline()` of an error handler, whose head fails from a work of no request", async () => {
      const head = silent();
      await withApp(
        {
          timeout: 20,
          error_handler_timeout: 5000,
          error_handler: async (context: Context, error): Promise<void> => {
            if (!isDeadline(error)) {
              return;
            }
            context.response.status(503).type("text/plain");
            const piped = pipelineAsync(
              head,
              new PassThrough(),
              context.response,
            );
            owners.exit(() => {
              setTimeout(() => {
                head.write("partial");
                head.destroy(new Error("The head has failed"));
              }, 10);
            });
            await piped;
          },
        },
        (app) => {
          app.use(async () => {
            await never();
          });
        },
        async ({ port }) => {
          const started = Date.now();
          const reply = await exchange(port);
          ok(reply.status === 500 || reply.closed, reply.raw);
          ok(!reply.complete || reply.status === 500, reply.raw);
          ok(Date.now() - started < 1000);
        },
      );
    });
  });

  suite(
    "refused (its owner fails), when code other than its source may have run",
    () => {
      /** Pipes a source fed by a work of no request into the response, refused by `prepare` */
      const refusedBy = async (
        prepare: (source: PassThrough, response: BindenResponse) => void,
        pipe: (source: PassThrough, response: BindenResponse) => void = (
          source,
          response,
        ): void => {
          source.pipe(response);
        },
      ): Promise<{ reply: IRaw; logged: unknown[] }> => {
        const source = silent();
        const feed = feeder(source, ["REAL"]);
        try {
          let result: { reply: IRaw; logged: unknown[] } | null = null;
          await withApp(
            {},
            (app) => {
              app.use(async (context: Context) => {
                context.response.type("text/plain");
                prepare(source, context.response);
                pipe(source, context.response);
                feed.start();
                await never();
              });
            },
            async ({ port }, captured) => {
              const reply = await exchange(port, { linger: 60 });
              result = {
                reply,
                logged: captured.records
                  .filter(({ msg }) => msg === "The request has failed")
                  .map(({ failure }) => (failure as { type: string }).type),
              };
            },
          );
          return result as unknown as { reply: IRaw; logged: unknown[] };
        } finally {
          feed.stop();
        }
      };

      test("a listener of `newListener` of the response that adds a `data` listener to the source", async () => {
        const { reply, logged } = await refusedBy((source, response) => {
          response.on("newListener", (event: unknown) => {
            if (event === "unpipe") {
              // Named as the one of the pipe of Node.js
              const ondata = (): void => {
                response.write("SPOOF");
              };
              source.on("data", ondata);
            }
          });
        });
        deepStrictEqual(
          [reply.status, reply.body, reply.complete],
          [500, "", true],
        );
        ok(!reply.raw.includes("SPOOF") && !reply.raw.includes("REAL"));
        deepStrictEqual(logged, ["TypeError"]);
      });

      test("a listener of `removeListener` of the response", async () => {
        const { reply } = await refusedBy((_source, response) => {
          response.on("removeListener", () => null);
        });
        deepStrictEqual([reply.status, reply.complete], [500, true]);
      });

      for (const event of ["newListener", "removeListener"]) {
        test(`a listener of \`${event}\` of the source`, async () => {
          const { reply } = await refusedBy((source) => {
            source.on(event, () => null);
          });
          deepStrictEqual([reply.status, reply.complete], [500, true]);
        });
      }

      for (const name of [
        "on",
        "once",
        "emit",
        "pipe",
        "pause",
        "resume",
        "read",
      ]) {
        test(`a method \`${name}()\` of the source itself`, async () => {
          const { reply } = await refusedBy((source) => {
            const inherited = Reflect.get(PassThrough.prototype, name) as (
              ...args: unknown[]
            ) => unknown;
            Object.defineProperty(source, name, {
              configurable: true,
              writable: true,
              value(this: PassThrough, ...args: unknown[]): unknown {
                return Reflect.apply(inherited, this, args);
              },
            });
          });
          deepStrictEqual([reply.status, reply.complete], [500, true]);
        });
      }

      for (const name of ["rawListeners", "unpipe", "removeListener"]) {
        test(`a method \`${name}()\` of the source itself, which binden never calls`, async () => {
          const calls: string[] = [];
          const { reply } = await refusedBy((source) => {
            const inherited = Reflect.get(PassThrough.prototype, name) as (
              ...args: unknown[]
            ) => unknown;
            Object.defineProperty(source, name, {
              configurable: true,
              writable: true,
              value(this: PassThrough, ...args: unknown[]): unknown {
                // Node.js calls it from the pipe that it dismantles (its
                // `cleanup()`), as it would without binden
                const { stack = "" } = new Error("Called");
                calls.push(/\bat cleanup\b/u.test(stack) ? "cleanup" : "other");
                return Reflect.apply(inherited, this, args);
              },
            });
          });
          deepStrictEqual([reply.status, reply.complete], [500, true]);
          ok(
            calls.every((call) => call === "cleanup"),
            JSON.stringify(calls),
          );
        });
      }

      test("a legacy `Stream.prototype.pipe()` (with no `unpipe()`), dismantled", async () => {
        const legacy = new Stream() as Stream & { readable: boolean };
        legacy.readable = true;
        const { reply } = await refusedBy(
          () => null,
          (_source, response) => {
            legacy.pipe(response);
            owners.exit(() => {
              setTimeout(() => {
                legacy.emit("data", Buffer.from("LEGACY"));
                legacy.emit("end");
              }, 10);
            });
          },
        );
        deepStrictEqual(
          [reply.status, reply.body, reply.complete],
          [500, "", true],
        );
        ok(!reply.raw.includes("LEGACY"));
        deepStrictEqual(legacy.listenerCount("data"), 0);
      });

      test("a legacy `Stream.prototype.pipe()` of a source that has ended", async () => {
        const ended = new PassThrough();
        ended.end();
        ended.resume();
        await once(ended, "end");
        const { reply } = await refusedBy(
          () => null,
          (_source, response) => {
            const legacy = Reflect.get(Stream.prototype, "pipe") as (
              destination: BindenResponse,
            ) => unknown;
            Reflect.apply(legacy, ended, [response]);
          },
        );
        deepStrictEqual([reply.status, reply.complete], [500, true]);
      });

      test("its own `resume()` that adds a `data` listener (called by the pipe before it is adopted)", async () => {
        const { reply } = await refusedBy((source, response) => {
          const inherited = Reflect.get(PassThrough.prototype, "resume") as (
            ...args: unknown[]
          ) => unknown;
          let armed = true;
          Object.defineProperty(source, "resume", {
            configurable: true,
            writable: true,
            value(this: PassThrough, ...args: unknown[]): unknown {
              if (armed) {
                armed = false;
                // As the pipe of Node.js, after its own listener
                EventEmitter.prototype.on.call(this, "data", () => {
                  response.write("OLD");
                });
              }
              return Reflect.apply(inherited, this, args);
            },
          });
        });
        deepStrictEqual(
          [reply.status, reply.body, reply.complete],
          [500, "", true],
        );
        ok(!reply.raw.includes("OLD"), reply.raw);
      });

      for (const spoof of [false, true]) {
        test(`a proxy of a source${spoof ? " whose trap adds a `data` listener" : ""}: refused before its inspection, its traps run only to unpipe it`, async () => {
          const traps: string[] = [];
          const { reply } = await refusedBy(
            () => null,
            (source, response) => {
              let piping = false;
              const emit = Reflect.get(response, "emit") as (
                ...args: unknown[]
              ) => unknown;
              response.emit = function wrapper(
                this: BindenResponse,
                ...args: unknown[]
              ): boolean {
                piping = args[0] === "pipe";
                try {
                  return Reflect.apply(emit, this, args) as boolean;
                } finally {
                  piping = false;
                }
              } as never;
              const trap = (name: string): void => {
                if (piping) {
                  traps.push(name);
                  // Ignored once its work has lost the response
                  response.setHeader("X-Trap", name);
                }
              };
              const proxy = new Proxy(source, {
                get(target, key, receiver): unknown {
                  trap(`get ${String(key)}`);
                  const value: unknown = Reflect.get(target, key, receiver);
                  if (spoof && key === "on" && typeof value === "function") {
                    return function on(
                      this: PassThrough,
                      event: string,
                      listener: () => void,
                    ): unknown {
                      Reflect.apply(value, this, [event, listener]);
                      if (event === "data") {
                        Reflect.apply(value, this, [
                          "data",
                          function ondata(): void {
                            response.write("OLD");
                          },
                        ]);
                      }
                      return this;
                    };
                  }
                  return value;
                },
                getOwnPropertyDescriptor(
                  target,
                  key,
                ): PropertyDescriptor | undefined {
                  trap(`getOwnPropertyDescriptor ${String(key)}`);
                  return Reflect.getOwnPropertyDescriptor(target, key);
                },
                getPrototypeOf(target): object | null {
                  trap("getPrototypeOf");
                  return Reflect.getPrototypeOf(target);
                },
              });
              proxy.pipe(response);
            },
          );
          deepStrictEqual(
            [reply.status, reply.body, reply.complete],
            [500, "", true],
          );
          ok(!/OLD|X-Trap/u.test(reply.raw), reply.raw);
          // Its traps run only to unpipe it, once its work has lost the response
          ok(traps.includes("getPrototypeOf"), JSON.stringify(traps));
        });
      }

      test("a source that cannot be patched (not extensible)", async () => {
        const { reply } = await refusedBy((source) => {
          Object.preventExtensions(source);
        });
        deepStrictEqual(
          [reply.status, reply.body, reply.complete],
          [500, "", true],
        );
      });

      for (const [name, prepare] of [
        [
          "a listener of `removeListener` of the source",
          (source: PassThrough, response: BindenResponse): void => {
            source.on("removeListener", () => {
              response.end("OLD");
            });
          },
        ],
        [
          "its own `removeListener()`",
          (source: PassThrough, response: BindenResponse): void => {
            const inherited = Reflect.get(
              PassThrough.prototype,
              "removeListener",
            ) as (...args: unknown[]) => unknown;
            Object.defineProperty(source, "removeListener", {
              configurable: true,
              writable: true,
              value(this: PassThrough, ...args: unknown[]): unknown {
                response.end("OLD");
                return Reflect.apply(inherited, this, args);
              },
            });
          },
        ],
      ] as const) {
        test(`the cleanup of its unpipe (${name}) runs once its work has lost the response`, async () => {
          const { reply, logged } = await refusedBy(prepare);
          deepStrictEqual(
            [reply.status, reply.body, reply.complete],
            [500, "", true],
          );
          ok(!reply.raw.includes("OLD"), reply.raw);
          deepStrictEqual(logged, ["TypeError"]);
        });
      }

      test("the cleanup of its unpipe that throws (from a timer) is logged: the reply is the error", async () => {
        await withApp(
          {},
          (app) => {
            app.use(async (context: Context) => {
              const source = silent();
              source.on("removeListener", () => {
                throw new Error("The cleanup has failed");
              });
              // Out of the middleware: what it throws would crash
              setTimeout(() => {
                source.pipe(context.response);
              }, 5);
              await never();
            });
          },
          async ({ port }, captured) => {
            const reply = await exchange(port);
            deepStrictEqual([reply.status, reply.complete], [500, true]);
            await captured.waitFor("The cleanup of a refused pipe has failed");
            deepStrictEqual(
              captured.records
                .filter(({ msg }) => msg === "The request has failed")
                .map(({ failure }) => (failure as { type: string }).type),
              ["TypeError"],
            );
          },
        );
      });

      test("one of two responses of one source: the other gets its exact body, the source lives", async () => {
        const source = silent();
        const feed = feeder(source, ["x", "y"]);
        const count = { piped: 0 };
        try {
          await withApp(
            {},
            (app) => {
              app.use(async (context: Context) => {
                if (context.url.pathname === "/refused") {
                  context.response.on("newListener", () => null);
                }
                source.pipe(context.response);
                count.piped += 1;
                await once(context.response, "finish");
              });
            },
            async ({ port }) => {
              const refusedReply = exchange(port, { path: "/refused" });
              const accepted = exchange(port);
              while (count.piped < 2) {
                await sleep(5);
              }
              const failed = await refusedReply;
              deepStrictEqual([failed.status, failed.body], [500, ""]);
              ok(!source.destroyed);
              feed.start();
              const reply = await accepted;
              deepStrictEqual(
                [reply.status, reply.body, reply.complete],
                [200, "xy", true],
              );
            },
          );
        } finally {
          feed.stop();
        }
      });
    },
  );

  suite("of an error handler, destroyed by its own pipe (its failure)", () => {
    /** A transform that passes its chunks */
    const passing = (): Transform =>
      new Transform({
        transform(chunk: Buffer, _encoding, callback): void {
          callback(null, chunk);
        },
      });

    /**
     * The reply of an error handler that runs `handle`, for a `409` (or only
     * for the deadline, with `timeout`, unless `throws`: the stack hangs)
     */
    const handled = async (
      handle: (context: Context, error: unknown) => Promise<void>,
      options: IBindenOptions = {},
      throws = typeof options.timeout === "undefined",
    ): Promise<{ reply: IRaw; captured: ICaptured }> => {
      let result: { reply: IRaw; captured: ICaptured } | null = null;
      await withApp(
        { error_handler_timeout: 2000, ...options, error_handler: handle },
        (app) => {
          app.use(async () => {
            if (throws) {
              throw new BindenError(409);
            }
            await never();
          });
        },
        async ({ port }, captured) => {
          result = { reply: await exchange(port, { linger: 40 }), captured };
        },
      );
      return result as unknown as { reply: IRaw; captured: ICaptured };
    };

    for (const form of ["pipe", "pipeline", "pipeline of 3 streams"]) {
      for (const committed of [false, true]) {
        for (const error of [true, false]) {
          test(`its ${form}, whose source ${error ? "fails" : "closes"} ${committed ? "after" : "before"} its first chunk: ${committed ? "the connection is closed" : "500"}`, async () => {
            const settled = Promise.withResolvers<unknown>();
            const { reply } = await handled(
              async (context, failure) => {
                if (!isDeadline(failure)) {
                  return;
                }
                context.response.status(503);
                const source = new PassThrough();
                const { response } = context;
                if (form === "pipe") {
                  source.pipe(response);
                  settled.resolve(null);
                } else {
                  const piped =
                    form === "pipeline"
                      ? pipelineAsync(source, response)
                      : pipelineAsync(source, passing(), response);
                  piped.catch((rejection: unknown) => {
                    const { code, message } = rejection as Error & {
                      code?: string;
                    };
                    settled.resolve(code ?? message);
                  });
                }
                // Of a work of no request
                owners.exit(() => {
                  setTimeout(() => {
                    if (committed) {
                      source.write("abc");
                    }
                    setTimeout(() => {
                      if (error) {
                        source.destroy(new Error("boom"));
                      } else {
                        source.destroy();
                      }
                    }, 10);
                  }, 5);
                });
                await never();
              },
              { timeout: 20 },
            );
            if (committed) {
              deepStrictEqual(
                [reply.status, reply.complete, reply.closed],
                [503, false, true],
              );
            } else {
              deepStrictEqual(
                [reply.status, reply.complete, reply.closed],
                [500, true, false],
              );
              deepStrictEqual(reply.raw.match(/HTTP\/1\.1/gu)?.length, 1);
            }
            if (form !== "pipe") {
              // The original error
              deepStrictEqual(
                await within(settled.promise),
                error ? "boom" : "ERR_STREAM_PREMATURE_CLOSE",
              );
            }
          });
        }
      }
    }

    test("a pipeline of the stack whose source closes before the headers: as Node.js, the response is destroyed", async () => {
      const settled = Promise.withResolvers<unknown>();
      await withApp(
        {},
        (app) => {
          app.use(async (context: Context) => {
            const source = new PassThrough();
            pipelineAsync(source, passing(), context.response).catch(
              (error: unknown) => {
                settled.resolve((error as { code?: string }).code);
              },
            );
            owners.exit(() => {
              setTimeout(() => {
                source.destroy();
              }, 10);
            });
            await never();
          });
        },
        async ({ port }) => {
          const reply = await exchange(port);
          deepStrictEqual([reply.status, reply.closed], [null, true]);
          deepStrictEqual(
            await within(settled.promise),
            "ERR_STREAM_PREMATURE_CLOSE",
          );
        },
      );
    });

    test("its pipeline of a head destroyed before: 500", async () => {
      const settled = Promise.withResolvers<unknown>();
      const { reply } = await handled(async (context) => {
        const head = new PassThrough();
        head.destroy();
        pipelineAsync(head, passing(), context.response).catch(
          (failure: unknown) => {
            settled.resolve((failure as { code?: string }).code);
          },
        );
        await never();
      });
      deepStrictEqual(
        [reply.status, reply.complete, reply.closed],
        [500, true, false],
      );
      deepStrictEqual(
        await within(settled.promise),
        "ERR_STREAM_PREMATURE_CLOSE",
      );
    });

    for (const which of ["of a work of no request", "of its own, unpiped"]) {
      test(`a destroy while only a pipe ${which} is adopted: the connection is closed`, async () => {
        const { reply, captured } = await handled(async (context) => {
          const { response } = context;
          const source = new PassThrough();
          if (which === "of a work of no request") {
            owners.exit(() => {
              source.pipe(response);
            });
          } else {
            source.pipe(response, { end: false });
            source.end();
            await once(source, "end");
          }
          await sleep(5);
          response.destroy(new Error("Destroyed by the handler"));
          await never();
        });
        deepStrictEqual([reply.status, reply.closed], [null, true]);
        deepStrictEqual(messages(captured, 50), []);
      });
    }

    test("a destroy of the response by the error handler while its pipe is adopted: 500", async () => {
      const outcome = Promise.withResolvers<unknown>();
      const { reply } = await handled(async (context) => {
        const { response } = context;
        new PassThrough().pipe(response);
        finished(response, (error) => {
          outcome.resolve(error?.code);
        });
        await sleep(5);
        response.destroy();
        await never();
      });
      deepStrictEqual(
        [reply.status, reply.complete, reply.closed],
        [500, true, false],
      );
      deepStrictEqual(
        await within(outcome.promise),
        "ERR_STREAM_PREMATURE_CLOSE",
      );
    });

    test("a destroy of the response by the error handler once its pipe has committed the headers: not a failure", async () => {
      const { reply, captured } = await handled(async (context) => {
        const { response } = context;
        const source = new PassThrough();
        source.pipe(response);
        source.write("abc");
        await sleep(10);
        response.destroy();
        await never();
      });
      deepStrictEqual(
        [reply.status, reply.complete, reply.closed],
        [200, false, true],
      );
      deepStrictEqual(messages(captured, 50), []);
    });

    test("a destroy of an error handler that has been superseded changes nothing", async () => {
      const { reply, captured } = await handled(
        async (context, error) => {
          if (isDeadline(error)) {
            await sleep(60);
            await context.status(503).send("deadline");
            return;
          }
          const { response } = context;
          pipelineAsync(new PassThrough(), passing(), response).catch(
            () => null,
          );
          // Once the deadline has passed (and its work has been told), with
          // a pipe of its own
          await sleep(40);
          new PassThrough().pipe(response);
          response.destroy();
          await never();
        },
        { timeout: 20 },
        true,
      );
      deepStrictEqual(
        [reply.status, reply.body, reply.complete, reply.closed],
        [503, "deadline", true, false],
      );
      ok(
        !messages(captured, 20).includes(
          "A pipe of an abandoned work has failed",
        ),
      );
    });

    test("its pipe that the framework destroys (it has not ended its reply): the connection is closed", async () => {
      const { reply, captured } = await handled(async (context) => {
        // Settles without ending its reply
        new PassThrough().pipe(context.response, { end: false });
        await sleep(5);
      });
      deepStrictEqual([reply.status, reply.closed], [null, true]);
      await captured.waitFor(
        "The provided `error_handler` has not ended its reply. Destroying the socket",
      );
    });

    for (const how of ["the client goes away", "a shutdown"]) {
      test(`its pipeline once ${how}: the transport closes it, as with Node.js`, async () => {
        const settled = Promise.withResolvers<unknown>();
        const piping = Promise.withResolvers<unknown>();
        await withApp(
          {
            error_handler: async (context: Context): Promise<void> => {
              const { response } = context;
              // Before the listeners of the pipe: while it is adopted
              response.on("close", () => {
                response.destroy();
              });
              try {
                const piped = pipelineAsync(
                  new PassThrough(),
                  passing(),
                  response,
                );
                piping.resolve(null);
                await piped;
              } catch (failure: unknown) {
                settled.resolve((failure as { code?: string }).code);
              }
            },
          },
          (app) => {
            app.use(() => {
              throw new BindenError(409);
            });
          },
          async ({ port, server }, captured) => {
            const socket = connect(port, "localhost");
            await once(socket, "connect");
            socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
            await within(piping.promise);
            if (how === "a shutdown") {
              await shutdown(server, { timeout: 10 });
            } else {
              socket.destroy();
            }
            deepStrictEqual(
              await within(settled.promise),
              "ERR_STREAM_PREMATURE_CLOSE",
            );
            await sleep(20);
            socket.destroy();
            // Not a failure of the handler (as a failed pipe)
            ok(
              !messages(captured, 50).includes(
                "The provided `error_handler` has failed",
              ),
              JSON.stringify(captured.records),
            );
          },
        );
      });
    }
  });

  suite("transfer once its work is abandoned", () => {
    /**
     * Reads the response of a request on a connection that is not read for
     * `pause` milliseconds (the reply waits under backpressure)
     */
    const slowly = async (port: number, pause: number): Promise<IRaw> => {
      const socket = connect(port, "localhost");
      await once(socket, "connect");
      socket.write(
        "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
      );
      socket.pause();
      await sleep(pause);
      let raw = "";
      socket.setEncoding("latin1").on("data", (chunk: string) => {
        raw += chunk;
      });
      const closed = once(socket, "close");
      socket.resume();
      await within(closed, 10_000);
      const end = raw.indexOf("\r\n\r\n");
      const head = raw.slice(0, end);
      const [body, complete] = bodyOf(head, raw.slice(end + 4));
      return { raw: "", status: null, head, body, complete, closed: true };
    };
    const size = 8 * 1024 * 1024;

    test("an error handler that has ended its reply, then times out: the whole body is sent", async () => {
      await withApp(
        {
          error_handler_timeout: 50,
          error_handler: async (context: Context): Promise<void> => {
            context.response.on("close", () => null);
            context.response.statusCode = 409;
            context.response.end(Buffer.alloc(size, "a"));
            await never();
          },
        },
        (app) => {
          app.use(() => {
            throw new BindenError(409);
          });
        },
        async ({ port }) => {
          const reply = await slowly(port, 300);
          deepStrictEqual([reply.body.length, reply.complete], [size, true]);
        },
      );
    });

    test("the send of an error handler that has ended its reply settles once flushed, also once it times out", async () => {
      const outcomes: unknown[] = [];
      await withApp(
        {
          error_handler_timeout: 50,
          error_handler: async (context: Context): Promise<void> => {
            context.response.statusCode = 409;
            context.send(Buffer.alloc(size, "a")).then(
              () => {
                outcomes.push("sent");
              },
              (error: unknown) => {
                outcomes.push((error as { code?: string }).code);
              },
            );
            await never();
          },
        },
        (app) => {
          app.use(() => {
            throw new BindenError(409);
          });
        },
        async ({ port }) => {
          const reply = await slowly(port, 300);
          deepStrictEqual([reply.body.length, reply.complete], [size, true]);
          for (let tick = 0; tick < 100 && outcomes.length === 0; tick += 1) {
            await sleep(5);
          }
          deepStrictEqual(outcomes, ["sent"]);
        },
      );
    });

    test(
      "the deadline cuts a body that has not been sent in full",
      {
        // Windows takes a whole write while its send buffer has room: the
        // response may finish before the client reads it
        skip: process.platform === "win32",
      },
      async () => {
        await withApp(
          { timeout: 50 },
          (app) => {
            app.use(async (context: Context) => {
              context.response.end(Buffer.alloc(size, "a"));
              await never();
            });
          },
          async ({ port }) => {
            const reply = await slowly(port, 300);
            ok(!reply.complete && reply.body.length < size);
          },
        );
      },
    );
  });

  suite("its failures once the outcome of its work is decided", () => {
    test("of the stack that has completed, before the headers: the error handler replies", async () => {
      await withApp(
        {},
        (app) => {
          app.use((context: Context) => {
            const source = silent();
            context.response.statusMessage = refused;
            source.pipe(context.response);
            owners.exit(() => {
              setTimeout(() => {
                source.write("late");
              }, 10);
            });
            // Completed, the response started by the pipe
          });
        },
        async ({ port }) => {
          const reply = await exchange(port);
          deepStrictEqual([reply.status, reply.complete], [500, true]);
        },
      );
    });

    test("of the stack that has completed, once the headers are sent: the connection is closed", async () => {
      await withApp(
        {},
        (app) => {
          app.use((context: Context) => {
            const source = new PassThrough({ objectMode: true });
            context.response.flushHeaders();
            source.pipe(context.response);
            owners.exit(() => {
              setTimeout(() => {
                // Not bytes: its write throws
                source.write(42);
              }, 10);
            });
          });
        },
        async ({ port }, captured) => {
          const reply = await exchange(port);
          deepStrictEqual([reply.status, reply.closed], [200, true]);
          await captured.waitFor(
            "A pipe into the response has failed once its headers were sent. Destroying the socket",
          );
        },
      );
    });

    test("of the stack once the client has gone away: nothing is replied", async () => {
      const piped = Promise.withResolvers<unknown>();
      await withApp(
        {},
        (app) => {
          app.use(async (context: Context) => {
            context.response.flushHeaders();
            await once(context.response, "close");
            // Once the stack has stopped
            await sleep(10);
            context.response.on("newListener", () => null);
            silent().pipe(context.response);
            piped.resolve(null);
          });
        },
        async ({ port }, captured) => {
          const socket = connect(port, "localhost");
          await once(socket, "connect");
          socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
          await once(socket, "data");
          socket.destroy();
          await within(piped.promise);
          await sleep(20);
          deepStrictEqual(messages(captured, 50), []);
        },
      );
    });

    test("of the stack as the client goes away: nothing is replied", async () => {
      const piped = Promise.withResolvers<unknown>();
      await withApp(
        {},
        (app) => {
          app.use(async (context: Context) => {
            context.response.flushHeaders();
            await once(context.response, "close");
            // Before the stack has stopped
            context.response.on("newListener", () => null);
            silent().pipe(context.response);
            piped.resolve(null);
          });
        },
        async ({ port }, captured) => {
          const socket = connect(port, "localhost");
          await once(socket, "connect");
          socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
          await once(socket, "data");
          socket.destroy();
          await within(piped.promise);
          await sleep(20);
          deepStrictEqual(messages(captured, 50), []);
        },
      );
    });

    test("of the stack that has completed, whose error reply fails unexpectedly: the connection is closed", async () => {
      await withApp(
        {},
        (app) => {
          app.use((context: Context) => {
            const source = silent();
            // The default reply then fails: it removes the `ETag` of the body
            context.setHeader("ETag", `"tag"`);
            context.response.removeHeader = (): never => {
              throw new Error("Unexpected");
            };
            context.response.statusMessage = refused;
            source.pipe(context.response);
            owners.exit(() => {
              setTimeout(() => {
                source.write("late");
              }, 10);
            });
          });
        },
        async ({ port }, captured) => {
          const reply = await exchange(port);
          deepStrictEqual([reply.status, reply.closed], [null, true]);
          await captured.waitFor("The request has failed");
        },
      );
    });

    for (const work of ["another request", "no request"]) {
      test(`refused, of a work of ${work}: unpiped and logged, the response left to its owner`, async () => {
        const source = silent();
        await withApp(
          {},
          (app) => {
            app.use(async (context: Context) => {
              context.response.on("newListener", () => null);
              const pipe = (): void => {
                source.pipe(context.response);
              };
              if (work === "no request") {
                owners.exit(pipe);
              } else {
                owners.run({ name: "a work of another request" }, pipe);
              }
              await context.status(202).send("sent");
            });
          },
          async ({ port }, captured) => {
            const reply = await exchange(port);
            deepStrictEqual([reply.status, reply.body], [202, "sent"]);
            const { reason } = await captured.waitFor(
              "A pipe of a work of no request (or of another) has been refused",
            );
            deepStrictEqual(
              reason,
              "the response has listeners of its listeners",
            );
            deepStrictEqual(source.listenerCount("data"), 0);
          },
        );
      });
    }

    test("of the stack once the error handler runs: only its own work is abandoned", async () => {
      await withApp(
        {
          error_handler: async (context: Context): Promise<void> => {
            await sleep(40);
            await context.status(409).send("handler");
          },
        },
        (app) => {
          app.use((context: Context) => {
            setTimeout(() => {
              context.response.on("newListener", () => null);
              silent().pipe(context.response);
            }, 10);
            throw new Error("A failure");
          });
        },
        async ({ port }, captured) => {
          const reply = await exchange(port);
          deepStrictEqual([reply.status, reply.body], [409, "handler"]);
          await captured.waitFor(
            "A pipe of the stack has failed once it had failed",
          );
        },
      );
    });

    test("of an error handler that has settled: only its own work is abandoned", async () => {
      await withApp(
        {
          error_handler: async (context: Context): Promise<void> => {
            await context.status(409).send("handler");
            setTimeout(() => {
              context.response.on("newListener", () => null);
              silent().pipe(context.response);
            }, 10);
          },
        },
        (app) => {
          app.use(() => {
            throw new Error("A failure");
          });
        },
        async ({ port }, captured) => {
          const reply = await exchange(port);
          deepStrictEqual([reply.status, reply.body], [409, "handler"]);
          await captured.waitFor(
            "A pipe of the provided `error_handler` has failed late",
          );
        },
      );
    });

    test("a listener of `end` of its source that the abandoned work has added, which throws, is logged", async () => {
      const source = silent();
      const added = Promise.withResolvers<unknown>();
      await withApp(
        { timeout: 20 },
        (app) => {
          app.use(async (context: Context) => {
            source.pipe(context.response);
            // In the turn of the pipe: bound to its work
            source.once("end", () => {
              throw new Error("A listener of the application has failed");
            });
            added.resolve(null);
            await never();
          });
        },
        async ({ port }, captured) => {
          const reply = await exchange(port);
          deepStrictEqual([reply.status, reply.complete], [503, true]);
          await within(added.promise);
          source.resume();
          source.end();
          // Once its request has completed
          await captured.waitFor(
            "A pipe of a work has failed once its request had completed",
          );
        },
      );
    });

    test("a listener of `end` that a completed work has left on a source, which throws, is logged", async () => {
      const source = silent();
      const cleaned = Promise.withResolvers<unknown>();
      await withApp(
        {},
        (app) => {
          app.use(async (context: Context) => {
            context.onCleanup(() => {
              cleaned.resolve(null);
            });
            source.pipe(context.response);
            // In the turn of the pipe: bound to its work
            source.once("end", () => {
              throw new Error("A listener of the application has failed");
            });
            source.unpipe(context.response);
            await context.response.text("ok");
          });
        },
        async ({ port }, captured) => {
          const reply = await exchange(port);
          deepStrictEqual(
            [reply.status, reply.body, reply.complete],
            [200, "ok", true],
          );
          await within(cleaned.promise);
          source.resume();
          source.end();
          const { level, failure } = await captured.waitFor(
            "A pipe of a work has failed once its request had completed",
          );
          deepStrictEqual(
            [level, (failure as { location: string }).location],
            [20, "send"],
          );
          ok(
            !captured.records.some(({ level: logged }) => Number(logged) > 30),
            captured.output(),
          );
        },
      );
    });

    test("whose `end()` throws (from `pipeline()`): its work fails", async () => {
      const settled = Promise.withResolvers<unknown>();
      await withApp(
        {},
        (app) => {
          app.use(async (context: Context) => {
            context.response.statusMessage = refused;
            pipeline(Readable.from([]), context.response, (error) => {
              settled.resolve(error);
            });
            await never();
          });
        },
        async ({ port }) => {
          const reply = await exchange(port);
          deepStrictEqual([reply.status, reply.complete], [500, true]);
          deepStrictEqual(
            ((await within(settled.promise)) as { code?: string }).code,
            "ERR_INVALID_CHAR",
          );
        },
      );
    });

    for (const kind of ["error handler", "stack"]) {
      test(`the \`close\` listeners of a failed ${kind} run before the reply that replaces it`, async () => {
        const sent: boolean[] = [];
        const pipeAndWait = async (context: Context): Promise<void> => {
          context.response.on("close", () => {
            sent.push(context.response.headersSent);
          });
          // Then in a continuation, whose ticks come after it
          await sleep(1);
          // Refused: its work fails
          context.response.on("newListener", () => null);
          silent().pipe(context.response);
          await never();
        };
        await withApp(
          kind === "stack" ? {} : { error_handler: pipeAndWait },
          (app) => {
            app.use(async (context: Context) => {
              if (kind === "stack") {
                await pipeAndWait(context);
              }
              throw new BindenError(409);
            });
          },
          async ({ port }) => {
            const reply = await exchange(port);
            deepStrictEqual([reply.status, reply.complete], [500, true]);
            deepStrictEqual(sent, [false]);
          },
        );
      });
    }
  });

  suite(
    "with `on()` and `emit()` of the response wrapped by a middleware (an instrumentation)",
    () => {
      test("`pipeline()` of an error handler, fed by a work of no request, ends the reply", async () => {
        const source = silent();
        const feed = feeder(source, ["REAL", "!"]);
        try {
          await withApp(
            {
              timeout: 20,
              error_handler: async (context: Context, error): Promise<void> => {
                if (!isDeadline(error)) {
                  return;
                }
                context.response.status(503).type("text/plain");
                const piped = pipelineAsync(source, context.response);
                feed.start();
                await piped;
              },
            },
            (app) => {
              app.use(async (context: Context) => {
                instrument(context.response);
                await never();
              });
            },
            async ({ port }, captured) => {
              const reply = await exchange(port);
              deepStrictEqual(
                [reply.status, reply.body, reply.complete, reply.closed],
                [503, "REAL!", true, false],
              );
              deepStrictEqual(messages(captured, 50), []);
            },
          );
        } finally {
          feed.stop();
        }
      });

      test("a listener that the abandoned work adds to the source writes nothing", async () => {
        const source = silent();
        const feed = feeder(source, ["REAL"]);
        try {
          await withApp(
            {
              timeout: 20,
              error_handler: async (context: Context, error): Promise<void> => {
                if (!isDeadline(error)) {
                  return;
                }
                context.response.status(503).type("text/plain");
                source.pipe(context.response);
                feed.start();
                await once(context.response, "finish");
              },
            },
            (app) => {
              app.use(async (context: Context) => {
                instrument(context.response);
                context.response.prependListener("pipe", (piped: Readable) => {
                  piped.on("data", () => {
                    context.response.write("OLD");
                  });
                });
                await never();
              });
            },
            async ({ port }) => {
              const reply = await exchange(port);
              deepStrictEqual(
                [reply.status, reply.body, reply.complete],
                [503, "REAL", true],
              );
            },
          );
        } finally {
          feed.stop();
        }
      });

      test("a pipe whose write throws fails its work", async () => {
        await withApp(
          {},
          (app) => {
            app.use(async (context: Context) => {
              instrument(context.response);
              context.response.statusMessage = refused;
              Readable.from(["body"]).pipe(context.response);
              await never();
            });
          },
          async ({ port }) => {
            const reply = await exchange(port, { linger: 50 });
            deepStrictEqual([reply.status, reply.complete], [500, true]);
            deepStrictEqual(reply.raw.match(/HTTP\/1\.1/gu)?.length, 1);
          },
        );
      });

      test("the pipe of the stack is unpiped at its deadline", async () => {
        const source = silent();
        await withApp(
          {
            timeout: 20,
            error_handler: async (context: Context, error): Promise<void> => {
              if (!isDeadline(error)) {
                return;
              }
              await context.status(503).send(`${source.listenerCount("data")}`);
            },
          },
          (app) => {
            app.use(async (context: Context) => {
              instrument(context.response);
              source.pipe(context.response);
              await never();
            });
          },
          async ({ port }) => {
            const reply = await exchange(port);
            deepStrictEqual(
              [reply.status, reply.body, reply.complete],
              [503, "0", true],
            );
          },
        );
      });
    },
  );

  for (const [version, { PassThrough: Source }] of libraries) {
    // A `PassThrough` of `readable-stream` 2 emits its `end` once destroyed:
    // the pipe ends the response, as without binden
    const ends = version === "2";
    suite(`of \`readable-stream\` ${version}`, () => {
      for (const how of ["pipe", "pipeline", "two destinations"]) {
        test(`${how}: the whole body`, async () => {
          const source = new Source();
          const feed = feeder(source, ["hel", "lo"]);
          const other = new Source();
          other.resume();
          try {
            await withApp(
              {},
              (app) => {
                app.use(async (context: Context) => {
                  if (how === "pipeline") {
                    await pipelineAsync(source, context.response);
                    return;
                  } else if (how === "two destinations") {
                    source.pipe(other);
                  }
                  source.pipe(context.response);
                  feed.start();
                  await once(context.response, "finish");
                });
              },
              async ({ port }, captured) => {
                if (how === "pipeline") {
                  feed.start();
                }
                const reply = await exchange(port);
                deepStrictEqual(
                  [reply.status, reply.body, reply.complete],
                  [200, "hello", true],
                );
                deepStrictEqual(messages(captured, 50), []);
              },
            );
          } finally {
            feed.stop();
          }
        });
      }

      test("a source that has ended already: an empty reply, ended by its owner", async () => {
        const source = new Source();
        source.end();
        source.resume();
        await once(source, "end");
        await withApp(
          {},
          (app) => {
            app.use(async (context: Context) => {
              source.pipe(context.response);
              await once(context.response, "finish");
            });
          },
          async ({ port }) => {
            const reply = await exchange(port);
            deepStrictEqual(
              [reply.status, reply.body, reply.complete],
              [200, "", true],
            );
          },
        );
      });

      test("the deadline during the pipe: the reply of the error handler, and nothing after it", async () => {
        const source = new Source();
        const feed = feeder(source, ["OLD", "OLD"]);
        try {
          await withApp(
            {
              timeout: 20,
              error_handler: async (context: Context, error): Promise<void> => {
                if (!isDeadline(error)) {
                  return;
                }
                feed.start();
                await sleep(10);
                await context.status(503).send("deadline");
              },
            },
            (app) => {
              app.use(async (context: Context) => {
                source.pipe(context.response);
                await never();
              });
            },
            async ({ port }) => {
              const reply = await exchange(port, { linger: 60 });
              deepStrictEqual(
                [reply.status, reply.body, reply.complete, reply.closed],
                [503, "deadline", true, false],
              );
              ok(reply.raw.endsWith("\r\n\r\ndeadline"), reply.raw);
            },
          );
        } finally {
          feed.stop();
        }
      });

      for (const form of ["promise", "callback"]) {
        test(`a head refused before the commit (\`pipeline()\`, ${form}): one 500, it settles with the error`, async () => {
          const source = new Source();
          const feed = feeder(source, ["body", "more"]);
          const settled = Promise.withResolvers<unknown>();
          const outcome = (error: unknown): void => {
            settled.resolve((error as { code?: string } | null)?.code);
          };
          try {
            await withApp(
              {},
              (app) => {
                app.use(async (context: Context) => {
                  context.response.statusMessage = refused;
                  if (form === "promise") {
                    pipelineAsync(source, context.response).catch(outcome);
                  } else {
                    pipeline(source, context.response, outcome);
                  }
                  feed.start();
                  await never();
                });
              },
              async ({ port }) => {
                const reply = await exchange(port, { linger: 60 });
                deepStrictEqual(
                  [reply.status, reply.complete, reply.closed],
                  [500, true, false],
                );
                deepStrictEqual(reply.raw.match(/HTTP\/1\.1/gu)?.length, 1);
                ok(!reply.raw.includes("body"), reply.raw);
                deepStrictEqual(
                  await within(settled.promise),
                  "ERR_INVALID_CHAR",
                );
              },
            );
          } finally {
            feed.stop();
          }
        });
      }

      test(`a source of an error handler that closes before its end: ${ends ? "it ends" : "it fails at once"}`, async () => {
        const source = new Source();
        await withApp(
          {
            error_handler: async (context: Context): Promise<void> => {
              source.pipe(context.response);
              owners.exit(() => {
                setTimeout(() => {
                  source.destroy();
                }, 10);
              });
              await never();
            },
          },
          (app) => {
            app.use(() => {
              throw new BindenError(409);
            });
          },
          async ({ port }) => {
            const reply = await exchange(port);
            deepStrictEqual(
              [reply.status, reply.complete],
              [ends ? 200 : 500, true],
            );
          },
        );
      });

      test("a guarded source that closes once it has ended does not fail its work", async () => {
        // Without a connection: the response never finishes, and the pipe
        // stays (Node.js unpipes it once the response has finished)
        const response = detached();
        const failures: unknown[] = [];
        response[kOwnership]({
          fail: (_owner, error): boolean => {
            failures.push(error);
            return true;
          },
          guards: () => true,
          debug: () => null,
          warn: () => null,
        });
        const source = new Source();
        owners.run({ name: "an error handler" }, () => {
          source.pipe(response);
        });
        // Once destroyed (by `readable-stream` 4 itself, once it has ended)
        const closed = once(source, "close");
        source.end("ended");
        await once(source, "end");
        source.destroy();
        await within(closed);
        deepStrictEqual(failures, []);
      });

      test(`a source of the stack that closes before its end (\`pipeline()\`): ${ends ? "it ends" : "as Node.js, the response is destroyed"}`, async () => {
        const source = new Source();
        const settled = Promise.withResolvers<unknown>();
        await withApp(
          {},
          (app) => {
            app.use(async (context: Context) => {
              pipelineAsync(source, context.response).then(
                () => {
                  settled.resolve(null);
                },
                (error: unknown) => {
                  settled.resolve((error as { code?: string }).code);
                },
              );
              owners.exit(() => {
                setTimeout(() => {
                  source.destroy();
                }, 10);
              });
              await never();
            });
          },
          async ({ port }) => {
            const reply = await exchange(port);
            deepStrictEqual(
              [reply.status, reply.complete || reply.closed],
              [ends ? 200 : null, true],
            );
            deepStrictEqual(
              await within(settled.promise),
              ends ? null : "ERR_STREAM_PREMATURE_CLOSE",
            );
          },
        );
      });

      test("with `{ end: false }`, the owner ends the reply itself", async () => {
        const source = new Source();
        const feed = feeder(source, ["a", "b"]);
        try {
          await withApp(
            {},
            (app) => {
              app.use(async (context: Context) => {
                source.pipe(context.response, { end: false });
                feed.start();
                await once(source, "end");
                context.response.end("c");
              });
            },
            async ({ port }) => {
              const reply = await exchange(port);
              deepStrictEqual(
                [reply.status, reply.body, reply.complete],
                [200, "abc", true],
              );
            },
          );
        } finally {
          feed.stop();
        }
      });

      test("a second, independent destination still gets the source once the work has failed", async () => {
        const source = new Source();
        const feed = feeder(source, ["x", "y"]);
        const destination = new Source();
        let collected = "";
        destination.on("data", (chunk: Buffer) => {
          collected += chunk.toString("latin1");
        });
        const ended = once(destination, "end");
        owners.exit(() => {
          source.pipe(destination);
        });
        try {
          await withApp(
            {},
            (app) => {
              app.use(async (context: Context) => {
                context.response.statusMessage = refused;
                source.pipe(context.response);
                feed.start();
                await never();
              });
            },
            async ({ port }) => {
              const reply = await exchange(port, { linger: 60 });
              deepStrictEqual([reply.status, reply.complete], [500, true]);
              deepStrictEqual(reply.raw.match(/HTTP\/1\.1/gu)?.length, 1);
              await within(ended);
              deepStrictEqual(collected, "xy");
            },
          );
        } finally {
          feed.stop();
        }
      });
    });
  }

  test("through a transform of `through2` 2 (`pipeline()`): the whole body", async () => {
    const [, { PassThrough: Source }] = libraries[0] as [
      string,
      IReadableStream,
    ];
    const source = new Source();
    const feed = feeder(source, ["hel", "lo"]);
    try {
      await withApp(
        {},
        (app) => {
          app.use(async (context: Context) => {
            const piped = pipelineAsync(
              source,
              through2((chunk, _encoding, callback) => {
                callback(null, chunk.toString("latin1").toUpperCase());
              }),
              context.response,
            );
            feed.start();
            await piped;
          });
        },
        async ({ port }) => {
          const reply = await exchange(port);
          deepStrictEqual(
            [reply.status, reply.body, reply.complete],
            [200, "HELLO", true],
          );
        },
      );
    } finally {
      feed.stop();
    }
  });

  suite("into a response without the framework (Node.js decides)", () => {
    test("refused: it is unpiped, and nothing else", () => {
      const response = detached();
      const source = silent();
      response.on("newListener", () => null);
      source.pipe(response);
      const { pipes } = Reflect.get(source, "_readableState") as {
        pipes: unknown[];
      };
      deepStrictEqual([source.listenerCount("data"), pipes.length], [0, 0]);
      // A legacy pipe, which has no `unpipe()`: left as it is
      const legacy = new Stream();
      legacy.pipe(response);
      deepStrictEqual(legacy.listenerCount("data"), 1);
    });

    test("whose write throws: Node.js destroys the response", async () => {
      const response = detached();
      response.on("error", () => null);
      const source = new PassThrough({ objectMode: true });
      source.pipe(response);
      source.write(42);
      // Node.js 24.14 emits no `close` without a socket
      for (let tick = 0; tick < 10 && !response.destroyed; tick += 1) {
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
      }
      ok(response.destroyed);
    });

    test("whose end throws: it is thrown, as by Node.js", () => {
      const response = detached();
      response.statusMessage = refused;
      const source = silent();
      source.pipe(response);
      let thrown: unknown = null;
      try {
        source.emit("end");
      } catch (error: unknown) {
        thrown = error;
      }
      deepStrictEqual((thrown as { code?: string }).code, "ERR_INVALID_CHAR");
    });

    for (const owner of [null, { name: "a work of no framework" }]) {
      test(`a listener of \`end\` added in the window that throws: it is thrown (${owner === null ? "no work" : "a work"})`, () => {
        const response = detached();
        response[kOwnership]({
          fail: () => false,
          guards: () => true,
          debug: () => null,
          warn: () => null,
        });
        const source = silent();
        const thrown = new Error("Thrown");
        const run = (fn: () => void): void => {
          if (owner === null) {
            owners.exit(fn);
          } else {
            owners.run(owner, fn);
          }
        };
        run(() => {
          source.pipe(response);
          source.once("end", () => {
            throw thrown;
          });
        });
        let caught: unknown = null;
        try {
          source.emit("end");
        } catch (error: unknown) {
          caught = error;
        }
        ok(caught === thrown);
      });
    }

    test("of a class whose listeners are not those of `Readable.prototype.pipe()`", () => {
      // Its `on()` wraps the `data` listener, its `once()` does not wrap
      const on = Reflect.get(PassThrough.prototype, "on") as (
        ...args: unknown[]
      ) => unknown;
      class Wrapping extends PassThrough {}
      class Plain extends PassThrough {}
      Object.defineProperty(Wrapping.prototype, "on", {
        value(this: PassThrough, event: unknown, listener: () => void) {
          const wrapped = Object.assign(listener.bind(this), { listener });
          return Reflect.apply(on, this, [
            event,
            event === "data" ? wrapped : listener,
          ]);
        },
      });
      Object.defineProperty(Plain.prototype, "once", {
        value(this: PassThrough, event: unknown, listener: () => void) {
          return Reflect.apply(on, this, [event, listener]);
        },
      });
      for (const source of [new Wrapping(), new Plain()]) {
        const response = detached();
        source.pipe(response);
        // Refused: unpiped
        deepStrictEqual(source.listenerCount("data"), 0);
      }
    });

    test("a method set on the source while its window is open is not a patch of the window", () => {
      const first = detached();
      const second = detached();
      const source = silent();
      source.pipe(first);
      // Not the patch of the window (which is open until the next tick)
      const on = Reflect.get(PassThrough.prototype, "on") as (
        ...args: unknown[]
      ) => unknown;
      Object.defineProperty(source, "on", {
        configurable: true,
        writable: true,
        value(this: PassThrough, ...args: unknown[]): unknown {
          return Reflect.apply(on, this, args);
        },
      });
      source.pipe(second);
      const { pipes } = Reflect.get(source, "_readableState") as {
        pipes: unknown[];
      };
      // The second pipe is refused: unpiped
      ok(pipes.length === 1 && pipes[0] === first);
    });

    for (const [count, adopted] of [
      [1, true],
      [2, false],
    ] as const) {
      test(`a state of Node.js 10 with the response as its pipe (${count} pipe${count === 1 ? "" : "s"}): ${adopted ? "adopted" : "refused"}`, () => {
        const response = detached();
        const source = Object.assign(new EventEmitter(), {
          _readableState: { pipes: response, pipesCount: count },
        });
        source.on("data", () => null).once("end", () => null);
        response.emit("pipe", source);
        // The patches of its window, once adopted
        deepStrictEqual(Object.hasOwn(source, "on"), adopted);
      });
    }

    test("a write that throws out of a pipe that does not catch it: Node.js decides (thrown)", () => {
      const response = detached();
      const [, { PassThrough: Source }] = libraries[0] as [
        string,
        IReadableStream,
      ];
      const source = new Source();
      source.pipe(response);
      let thrown: unknown = null;
      try {
        // Not bytes
        source.emit("data", 42);
      } catch (error: unknown) {
        thrown = error;
      }
      deepStrictEqual(
        (thrown as { code?: string }).code,
        "ERR_INVALID_ARG_TYPE",
      );
    });

    test("the patches of its window are left once replaced, or removed", async () => {
      const response = detached();
      const replaced = silent();
      const removed = silent();
      const own = (): null => null;
      replaced.pipe(response);
      removed.pipe(response);
      Object.defineProperty(replaced, "on", { value: own, configurable: true });
      Reflect.deleteProperty(removed, "on");
      await new Promise((resolve) => {
        process.nextTick(resolve);
      });
      ok((replaced.on as unknown) === own && !Object.hasOwn(replaced, "once"));
      ok(!Object.hasOwn(removed, "on") && !Object.hasOwn(removed, "once"));
    });
  });
});
