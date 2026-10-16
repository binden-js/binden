import {
  Binden,
  BindenError,
  BindenResponse,
  type Context,
  type IBindenOptions,
} from "../index.js";
import {
  type ICaptured,
  type IListening,
  capture,
  listen,
  never,
  sleep,
  within,
} from "./helpers.js";
import { PassThrough, finished } from "node:stream";
import { Socket, connect } from "node:net";
import { deepStrictEqual, ok } from "node:assert/strict";
import { kListen, owners } from "../src/seal.js";
import { suite, test } from "node:test";
import { IncomingMessage } from "node:http";
import { once } from "node:events";
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

suite("A pipe into the response", () => {
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

    test("a listener of the framework (closed by the real close only) is removed by its function", () => {
      const response = detached();
      const listener = (): null => null;
      const before = response.listenerCount("close");
      response[kListen]("close", listener);
      deepStrictEqual(response.listenerCount("close"), before + 1);
      response.removeListener("close", listener);
      deepStrictEqual(response.listenerCount("close"), before);
    });
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
});
