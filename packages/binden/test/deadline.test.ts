import { type AddressInfo, connect } from "node:net";
import {
  Binden,
  BindenAbortError,
  BindenError,
  type Context,
  Cookie,
  type IBindenOptions,
  shutdown,
} from "../index.js";
import {
  type ICaptured,
  type IListening,
  capture,
  listen,
  never,
  send,
  sleep,
  within,
} from "./helpers.js";
import { type IncomingMessage, createServer, get } from "node:http";
import { PassThrough, Readable, finished } from "node:stream";
import { deepStrictEqual, ok } from "node:assert/strict";
import { suite, test } from "node:test";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import { setTimeout as wait } from "node:timers/promises";

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

/** A connection that sends requests and reads their responses, one at a time */
interface IClient {
  /** Sends a request, and reads its response (framed by `Content-Length`) */
  request(path: string): Promise<{ head: string; body: string }>;
  /** Whether the server has closed the connection */
  readonly closed: boolean;
  close(): void;
}

/** Opens a connection that is kept alive */
async function client(port: number): Promise<IClient> {
  const socket = connect(port, "localhost");
  await once(socket, "connect");
  let data = "";
  let closed = false;
  socket.setEncoding("latin1").on("data", (chunk: string) => {
    data += chunk;
  });
  socket.on("close", () => {
    closed = true;
  });
  const response = async (): Promise<{ head: string; body: string }> => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const end = data.indexOf("\r\n\r\n");
      const length = /^Content-Length: (?<length>\d+)$/imu.exec(
        data.slice(0, end),
      )?.groups?.length;
      if (
        end !== -1 &&
        typeof length !== "undefined" &&
        data.length >= end + 4 + Number(length)
      ) {
        const head = data.slice(0, end);
        const body = data.slice(end + 4, end + 4 + Number(length));
        data = data.slice(end + 4 + Number(length));
        return { head, body };
      } else if (closed || Date.now() > deadline) {
        throw new Error(`No complete response: ${JSON.stringify(data)}`);
      }
      await sleep(5);
    }
  };
  return {
    request: (path: string): Promise<{ head: string; body: string }> => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`);
      return response();
    },
    get closed(): boolean {
      return closed;
    },
    close: (): void => {
      socket.destroy();
    },
  };
}

/** Whether the error is the `503` of a deadline */
function isDeadline(error: unknown): boolean {
  return error instanceof BindenError && error.code === "deadline";
}

/**
 * A promise that settles synchronously from a listener of the abort of the
 * request (before the framework learns of it), as the path of the request
 * says: it rejects (`/rejects`), resolves, or resolves and then throws from its
 * own continuation (`/throws`)
 */
function settledAtTheDeadline(context: Context): Promise<void> {
  const { pathname } = context.url;
  const { promise, resolve, reject } = Promise.withResolvers<never>();
  context.signal.addEventListener("abort", () => {
    if (pathname === "/rejects") {
      reject(new Error("Rejected at the deadline"));
    } else {
      (resolve as () => void)();
    }
  });
  return pathname === "/throws"
    ? promise.then(() => {
        throw new Error("Thrown at the deadline");
      })
    : promise;
}

/** A source that never ends (nor pushes anything by itself) */
function silent(): Readable {
  return new Readable({
    read(): void {
      // Nothing
    },
  });
}

/**
 * Writes requests on one connection (the last one with `Connection: close`)
 * and reads everything until the server closes it: the responses, each
 * framed exactly by its `Content-Length` or its chunks
 */
async function converse(
  port: number,
  requests: string,
): Promise<{ head: string; body: string }[]> {
  const socket = connect(port, "localhost");
  await once(socket, "connect");
  let data = "";
  socket.setEncoding("latin1").on("data", (chunk: string) => {
    data += chunk;
  });
  socket.write(requests);
  await within(once(socket, "close"), 5000);
  const responses: { head: string; body: string }[] = [];
  while (data !== "") {
    const end = data.indexOf("\r\n\r\n");
    const head = data.slice(0, end);
    let rest = data.slice(end + 4);
    const length = /^Content-Length: (?<length>\d+)$/imu.exec(head)?.groups
      ?.length;
    let body = "";
    if (/^Transfer-Encoding: chunked$/imu.test(head)) {
      for (;;) {
        const line = rest.indexOf("\r\n");
        const size = Number.parseInt(rest.slice(0, line), 16);
        ok(line > 0 && Number.isSafeInteger(size), `Not chunked: ${data}`);
        body += rest.slice(line + 2, line + 2 + size);
        rest = rest.slice(line + 2 + size + 2);
        if (size === 0) {
          break;
        }
      }
    } else {
      ok(typeof length !== "undefined", `Not framed: ${data}`);
      body = rest.slice(0, Number(length));
      rest = rest.slice(Number(length));
    }
    responses.push({ head, body });
    data = rest;
  }
  return responses;
}

suite("The deadline", () => {
  test("seals the response before its signal is aborted", async () => {
    const paths = [
      "/pipeline",
      "/listener",
      "/headers",
      "/caught",
      "/caught-large",
    ];
    await withApp(
      { timeout: 30 },
      (app) => {
        app.use(async (context: Context) => {
          const { response, signal } = context;
          switch (context.url.pathname) {
            case "/pipeline":
              // Its first chunk comes after the deadline: the abort destroys
              // the destination (the response) as well
              await pipeline(
                Readable.from(
                  (async function* produce(): AsyncGenerator<string> {
                    await sleep(200);
                    yield "late";
                  })(),
                ),
                response,
                { signal },
              );
              break;
            case "/listener":
              signal.addEventListener("abort", () => {
                response.statusCode = 200;
                response.end("listener");
              });
              await never();
              break;
            case "/headers":
              signal.addEventListener("abort", () => {
                response.setHeader("X-Listener", "1");
                response.cookies.add(new Cookie({ key: "late", value: "1" }));
              });
              await never();
              break;
            case "/caught":
            default:
              try {
                await wait(1000, null, { signal });
              } catch {
                // The work stops: its reply, once the signal is aborted
              }
              await context
                .status(504)
                .text(
                  context.url.pathname === "/caught"
                    ? "caught"
                    : "x".repeat(4 * 1024 * 1024),
                );
          }
        });
      },
      async ({ port }) => {
        for (const path of paths) {
          const connection = await client(port);
          try {
            const { head, body } = await connection.request(path);
            ok(head.startsWith("HTTP/1.1 503 "), `${path}: ${head}`);
            ok(!/^(?:X-Listener|Set-Cookie)/imu.test(head), head);
            deepStrictEqual(body, "", path);
          } finally {
            connection.close();
          }
        }
      },
    );
  });

  test("takes the reply over from an error handler that runs, whatever it does later", async () => {
    const paths = [
      "/hangs",
      "/stream",
      "/throws-late",
      "/replies-late",
      "/expires",
    ];
    const cancelled: unknown[] = [];
    await withApp(
      {
        timeout: 40,
        error_handler_timeout: 300,
        error_handler: async (
          context: Context,
          error: unknown,
        ): Promise<void> => {
          if (error instanceof BindenError && error.code === "deadline") {
            await context.status(503).send("deadline");
            return;
          }
          switch (context.url.pathname) {
            case "/hangs":
              await never();
              break;
            case "/stream":
              // Its first chunk never comes: the deadline cancels it
              await context.send(silent()).catch((reason: unknown) => {
                cancelled.push(reason);
              });
              await context.status(500).send("late");
              break;
            case "/throws-late":
              await sleep(100);
              throw new Error("A late failure");
            case "/replies-late":
              await sleep(100);
              await context.status(500).send("late");
              break;
            case "/expires":
            default:
              // Longer than `error_handler_timeout`
              await sleep(400);
          }
        },
      },
      (app) => {
        app.use((context: Context) => {
          if (context.url.pathname === "/ok") {
            return context.send("ok");
          }
          throw new Error("A failure");
        });
      },
      async ({ port }, captured) => {
        for (const path of paths) {
          const connection = await client(port);
          try {
            const start = Date.now();
            const { head, body } = await connection.request(path);
            ok(head.startsWith("HTTP/1.1 503 "), `${path}: ${head}`);
            deepStrictEqual(body, "deadline", path);
            // At once, not once `error_handler_timeout` has passed
            ok(Date.now() - start < 250, `${path}: ${Date.now() - start} ms`);
            // The later outcome of the handler changes nothing: the connection
            // is neither cut nor given another reply
            await sleep(450);
            ok(!connection.closed, path);
            deepStrictEqual((await connection.request("/ok")).body, "ok");
          } finally {
            connection.close();
          }
        }
        deepStrictEqual(cancelled.length, 1);
        ok(
          cancelled[0] instanceof BindenAbortError &&
            cancelled[0].reason === "deadline",
        );
        const messages = captured.records.map(({ msg }) => msg);
        deepStrictEqual(
          messages.filter(
            (msg) =>
              msg ===
              "The provided `error_handler` has been abandoned at the deadline",
          ).length,
          paths.length,
        );
        for (const message of [
          "The provided `error_handler` has not settled in time",
          "The provided `error_handler` has failed",
        ]) {
          ok(!messages.includes(message), message);
        }
        await within(
          captured.waitFor("The provided `error_handler` has failed late"),
        );
      },
    );
  });

  test("takes the reply over from an error handler that settles as the deadline passes", async () => {
    const paths = ["/rejects", "/resolves", "/throws"];
    await withApp(
      {
        timeout: 30,
        error_handler_timeout: 1000,
        // Not `async`: its promise is the one that settles at the deadline
        error_handler: (context: Context, error: unknown): Promise<void> => {
          if (isDeadline(error)) {
            // Its reply comes later than the outcome of the handler
            return sleep(20).then(async () => {
              await context.status(503).send("deadline");
            });
          }
          return settledAtTheDeadline(context);
        },
      },
      (app) => {
        app.use(() => {
          throw new Error("A failure");
        });
      },
      async ({ port }, captured) => {
        for (const path of paths) {
          const connection = await client(port);
          try {
            const { head, body } = await connection.request(path);
            ok(head.startsWith("HTTP/1.1 503 "), `${path}: ${head}`);
            deepStrictEqual(body, "deadline", path);
          } finally {
            connection.close();
          }
        }
        const messages = captured.records.map(({ msg }) => msg);
        deepStrictEqual(
          messages.filter(
            (msg) => msg === "The provided `error_handler` has failed late",
          ).length,
          2,
        );
        ok(!messages.includes("The provided `error_handler` has failed"));
      },
    );
  });

  test("stops the stack whose middleware settles from a listener of the abort", async () => {
    let next = false;
    await withApp(
      { timeout: 20 },
      (app) => {
        app
          .use(
            (context: Context) =>
              new Promise<void>((resolve) => {
                context.signal.addEventListener("abort", () => {
                  resolve();
                });
              }),
          )
          .use(() => {
            next = true;
          });
      },
      async ({ port }) => {
        const connection = await client(port);
        try {
          const { head } = await connection.request("/");
          ok(head.startsWith("HTTP/1.1 503 "), head);
        } finally {
          connection.close();
        }
        await sleep(20);
        ok(!next);
      },
    );
  });

  test("cancels a send that has not committed its headers, as the time out of an error handler does", async () => {
    let rejection: unknown = null;
    await withApp(
      {
        timeout: 60,
        error_handler_timeout: 30,
        error_handler: async (
          context: Context,
          error: unknown,
        ): Promise<void> => {
          if (context.url.pathname === "/handler" && !isDeadline(error)) {
            // Started (see `response.started`) until its time out cancels it
            await context.send(silent()).catch((reason: unknown) => {
              rejection = reason;
            });
            return;
          }
          await context.status(isDeadline(error) ? 503 : 500).send("reply");
        },
      },
      (app) => {
        app.use(async (context: Context) => {
          if (context.url.pathname === "/handler") {
            context.setTimeout(0);
            throw new Error("A failure");
          }
          // The deadline cancels it, and replies
          await context.send(silent());
        });
      },
      async ({ port }) => {
        const connection = await client(port);
        try {
          const { head, body } = await connection.request("/middleware");
          ok(head.startsWith("HTTP/1.1 503 "), head);
          deepStrictEqual(body, "reply");
        } finally {
          connection.close();
        }
        // Replaced by the opaque `500`, on a connection that stays open
        const replaced = await client(port);
        try {
          const { head, body } = await replaced.request("/handler");
          ok(head.startsWith("HTTP/1.1 500 "), head);
          deepStrictEqual([body, replaced.closed], ["", false]);
        } finally {
          replaced.close();
        }
      },
    );
    ok(rejection instanceof BindenError);
    deepStrictEqual(
      [rejection.status, rejection.code],
      [500, "error_handler_timeout"],
    );
  });

  test("a send that its source ends at the deadline leaves no framing to the reply that follows", async () => {
    const upstream = createServer((_request, response) => {
      // The head of a body that never comes
      response.writeHead(200, { "Content-Length": 100_000 }).flushHeaders();
    });
    upstream.listen(0, "localhost");
    await once(upstream, "listening");
    const { port: up } = upstream.address() as AddressInfo;
    const rejected: unknown[] = [];
    try {
      await withApp(
        {
          timeout: 50,
          error_handler: async (context: Context, error: unknown) => {
            if (!isDeadline(error)) {
              throw error;
            } else if (context.url.pathname.endsWith("/native")) {
              context.response
                .writeHead(503, { "Content-Type": "text/plain" })
                .end("busy\n");
              return;
            }
            context.response
              .status(503)
              .setHeader("Content-Type", "text/plain");
            // Of an unknown length: chunked, unless a length is left over
            await context.send(Readable.from(["busy\n"]));
          },
        },
        (app) => {
          app.use(async (context: Context) => {
            const { response, signal, url } = context;
            if (url.pathname === "/next") {
              await context.send("next");
              return;
            }
            let source: Readable = new PassThrough();
            if (url.pathname.startsWith("/proxy")) {
              // A proxy of the upstream, which forwards its length
              source = await new Promise<IncomingMessage>((resolve, reject) => {
                get({ host: "localhost", port: up, signal }, resolve).once(
                  "error",
                  reject,
                );
              });
              response.setHeader(
                "Content-Length",
                `${(source as IncomingMessage).headers["content-length"]}`,
              );
            } else {
              response.setHeader("Content-Length", 123_456);
            }
            // Its source is destroyed at once by the abort of the deadline,
            // before the deadline cancels the send
            signal.addEventListener("abort", () => {
              source.destroy();
            });
            await context.send(source).catch((error: unknown) => {
              rejected.push(error);
            });
          });
        },
        async ({ port }) => {
          for (const path of [
            "/stream",
            "/native",
            "/proxy",
            "/proxy/native",
          ]) {
            rejected.length = 0;
            const responses = await converse(
              port,
              `GET ${path} HTTP/1.1\r\nHost: a\r\n\r\n` +
                "GET /next HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n",
            );
            deepStrictEqual(
              responses.map(({ head, body }) => [head.split("\r\n")[0], body]),
              [
                ["HTTP/1.1 503 Service Unavailable", "busy\n"],
                ["HTTP/1.1 200 OK", "next"],
              ],
              path,
            );
            ok(!/^Content-Length/imu.test(responses[0]?.head ?? ""), path);
            // As a send that the deadline cancels
            ok(rejected[0] instanceof BindenAbortError, path);
            deepStrictEqual(rejected[0].reason, "deadline", path);
          }
        },
      );
    } finally {
      upstream.closeAllConnections();
      upstream.close();
    }
  });

  test("a send that the client leaves rejects with its own error (its owner may still reply)", async () => {
    const rejected: unknown[] = [];
    const sending = Promise.withResolvers<null>();
    await withApp(
      {},
      (app) => {
        app.use(async (context: Context) => {
          context.response.setHeader("Content-Length", 10);
          const sent = context.send(silent());
          sending.resolve(null);
          await sent.catch((error: unknown) => {
            rejected.push(error);
          });
        });
      },
      async ({ port }) => {
        const socket = connect(port, "localhost");
        await once(socket, "connect");
        socket.write("GET / HTTP/1.1\r\nHost: a\r\n\r\n");
        await within(sending.promise);
        socket.destroy();
        const deadline = Date.now() + 5000;
        while (rejected.length === 0 && Date.now() < deadline) {
          await sleep(5);
        }
        deepStrictEqual(
          (rejected[0] as { code?: unknown }).code,
          "ERR_STREAM_PREMATURE_CLOSE",
        );
      },
    );
  });

  test("a send that fails late leaves the framing of the reply that has replaced it", async () => {
    const outcomes: unknown[] = [];
    await withApp(
      {
        error_handler: async (context: Context) => {
          // The framing of this reply, while the failed send still runs
          context.response.statusMessage = "";
          context.response.status(500).setHeader("Content-Length", 4);
          await sleep(60);
          context.response.write("bu");
          context.response.end("sy");
        },
      },
      (app) => {
        app.use(async (context: Context) => {
          if (context.url.pathname === "/next") {
            await context.send("next");
            return;
          }
          const source = new PassThrough();
          context.response.setHeader("Content-Length", 50);
          context.send(source).then(
            () => outcomes.push("sent"),
            (error: unknown) => outcomes.push((error as Error).message),
          );
          setTimeout(() => {
            source.destroy(new Error("Late"));
          }, 20);
          throw new Error("A failure");
        });
      },
      async ({ port }) => {
        const responses = await converse(
          port,
          "GET /late HTTP/1.1\r\nHost: a\r\n\r\nGET /next HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n",
        );
        deepStrictEqual(outcomes, ["Late"]);
        const [replaced, next] = responses as [
          { head: string; body: string },
          { head: string; body: string },
        ];
        ok(/^Content-Length: 4$/imu.test(replaced.head), replaced.head);
        ok(!/^Transfer-Encoding/imu.test(replaced.head));
        deepStrictEqual(replaced.body, "busy");
        deepStrictEqual(next.body, "next");
      },
    );
  });

  test("the abandoned work cannot change how the reply of the deadline is framed", async () => {
    /** The framing properties of Node.js, and what the abandoned work sets */
    const assigned: Record<string, boolean> = {
      chunkedEncoding: true,
      maxRequestsOnConnectionReached: true,
      strictContentLength: true,
      useChunkedEncodingByDefault: false,
    };
    /** The replies of the deadline: the default one, a native one, a stream */
    const handlers: Record<
      string,
      [IBindenOptions["error_handler"], string, string]
    > = {
      default: [({} as { value?: undefined }).value, "Content-Length: 0", ""],
      native: [
        async ({ response }: Context): Promise<void> => {
          response.writeHead(503, { "Content-Length": 4 }).write("busy");
          // While the abandoned work assigns them again
          await sleep(30);
          response.end();
        },
        "Content-Length: 4",
        "busy",
      ],
      stream: [
        async (context: Context): Promise<void> => {
          context.response.status(503);
          await context.send(
            Readable.from(
              (async function* produce(): AsyncGenerator<string> {
                yield "bu";
                await sleep(30);
                yield "sy";
              })(),
            ),
          );
        },
        "Transfer-Encoding: chunked",
        "busy",
      ],
    };
    for (const [property, value] of Object.entries(assigned)) {
      for (const [name, [handler, framing, body]] of Object.entries(handlers)) {
        await withApp(
          {
            timeout: 30,
            ...(typeof handler === "undefined"
              ? {}
              : { error_handler: handler }),
          },
          (app) => {
            app.use(async (context: Context) => {
              const { response, signal, url } = context;
              if (url.pathname === "/next") {
                // Queued behind the reply of the deadline: never cut by its own
                context.setTimeout(0);
                await context.send("next");
                return;
              }
              const assign = (): void => {
                Reflect.set(response, property, value);
              };
              signal.addEventListener("abort", () => {
                // Strict once the reply has written its body (strict before,
                // Node.js would count its bytes)
                if (property !== "strictContentLength") {
                  assign();
                }
                setTimeout(assign, 10);
              });
              await never();
            });
          },
          async ({ port }) => {
            const key = `${property} (${name})`;
            const [replied, next] = (await converse(
              port,
              "GET / HTTP/1.1\r\nHost: a\r\n\r\n" +
                "GET /next HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n",
            )) as [
              { head: string; body: string },
              { head: string; body: string },
            ];
            const head = replied.head.split("\r\n");
            deepStrictEqual(head[0], "HTTP/1.1 503 Service Unavailable", key);
            ok(head.includes(framing), `${key}: ${replied.head}`);
            ok(
              head.includes("Connection: keep-alive"),
              `${key}: ${replied.head}`,
            );
            deepStrictEqual(replied.body, body, key);
            deepStrictEqual(next.body, "next", key);
          },
        );
      }
    }
  });

  suite("is changed only by the work that may reply", () => {
    for (const [name, stack, handler, status] of [
      [
        "an early `close` listener of the failed stack removes it",
        (context: Context): void => {
          context.response.once("close", () => {
            context.setTimeout(0);
          });
        },
        null,
        503,
      ],
      [
        "an early `close` listener of the failed stack restarts it",
        (context: Context): void => {
          context.response.once("close", () => {
            context.setTimeout(1000);
          });
        },
        null,
        503,
      ],
      [
        "a later continuation of the failed stack removes it",
        (context: Context): void => {
          setTimeout(() => {
            context.setTimeout(0);
          }, 10);
        },
        null,
        503,
      ],
      [
        "the error handler that replaces the stack removes it",
        null,
        (context: Context): void => {
          context.setTimeout(0);
        },
        500,
      ],
      [
        "the error handler that replaces the stack restarts it",
        null,
        (context: Context): void => {
          context.setTimeout(150);
        },
        500,
      ],
    ] as const) {
      test(`${name}: ${status === 503 ? "ignored" : "applied"}`, async () => {
        const checked: string[] = [];
        await withApp(
          {
            timeout: 35,
            error_handler_timeout: 1000,
            error_handler: async (context: Context, error): Promise<void> => {
              if (isDeadline(error)) {
                await context.status(503).send("deadline");
                return;
              }
              handler?.(context);
              // Slower than the deadline
              await sleep(75);
              await context.status(500).send("handler");
            },
          },
          (app) => {
            app.use(async (context: Context) => {
              stack?.(context);
              context.response.once("close", () => {
                // Not even checked
                try {
                  context.setTimeout(-1);
                  checked.push("ignored");
                } catch {
                  checked.push("checked");
                }
              });
              // Refused: the stack fails at once
              const source = new PassThrough();
              source.on("newListener", () => null);
              source.pipe(context.response);
              await never();
            });
          },
          async ({ port }) => {
            const reply = await send(port);
            deepStrictEqual(
              [reply.status, reply.body],
              [status, status === 503 ? "deadline" : "handler"],
            );
            deepStrictEqual(checked, ["ignored"]);
          },
        );
      });
    }
  });

  for (const path of ["the option `timeout`", "`context.setTimeout()`"]) {
    test(`runs its abort listeners as the abandoned stack, through ${path}`, async () => {
      const events: string[] = [];
      const done = Promise.withResolvers<unknown>();
      await withApp(
        {
          timeout: path === "the option `timeout`" ? 30 : 0,
          error_handler: async (context: Context, error): Promise<void> => {
            if (!isDeadline(error)) {
              return;
            }
            await sleep(60);
            events.push("reply");
            await context.status(503).send("deadline");
          },
        },
        (app) => {
          app.use(async (context: Context) => {
            if (path === "`context.setTimeout()`") {
              context.setTimeout(30);
            }
            const { response } = context;
            context.signal.addEventListener("abort", () => {
              // Closed for them early, as for the stack
              response.on("close", () => {
                events.push("sync");
              });
              setImmediate(() => {
                response.on("close", () => {
                  events.push("immediate");
                });
              });
              setTimeout(() => {
                response.on("close", () => {
                  events.push("later");
                });
                finished(response, (error) => {
                  events.push(`finished ${String(error?.code)}`);
                  done.resolve(null);
                });
              }, 15);
            });
            await never();
          });
        },
        async ({ port }) => {
          const reply = await send(port);
          deepStrictEqual([reply.status, reply.body], [503, "deadline"]);
          await within(done.promise);
          deepStrictEqual(events, [
            "sync",
            "immediate",
            "later",
            "finished ERR_STREAM_PREMATURE_CLOSE",
            "reply",
          ]);
        },
      );
    });
  }
});

suite("A complete reply that waits for the response before it", () => {
  /**
   * An application whose `/` never replies by itself, and whose `/next` ends
   * its reply at once (or only writes a part of it), which then waits for the
   * response of `/` (pipelined before it): whether the response of `/next`
   * has finished once it is closed
   */
  function queued(
    options: IBindenOptions,
    complete = true,
  ): {
    app: Binden;
    captured: ICaptured;
    ended: Promise<null>;
    closed: Promise<boolean>;
  } {
    const captured = capture();
    const ended = Promise.withResolvers<null>();
    const closed = Promise.withResolvers<boolean>();
    const app = new Binden({ ...options, logger: captured.logger }).use(
      async (context: Context) => {
        const { response } = context;
        if (context.url.pathname !== "/next") {
          await never();
          return;
        }
        context.onCleanup(() => {
          closed.resolve(response.writableFinished);
        });
        const sent = complete ? context.text("next") : never();
        if (!complete) {
          response.write("part");
        }
        // Without a connection yet
        ok(response.writableEnded === complete && response.socket === null);
        ended.resolve(null);
        await sent;
      },
    );
    return { app, captured, ended: ended.promise, closed: closed.promise };
  }

  const requests =
    "GET / HTTP/1.1\r\nHost: a\r\n\r\n" +
    "GET /next HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n";

  test("is sent once that response is, after its deadline (on every Node.js)", async () => {
    const { app, captured, closed } = queued({
      timeout: 50,
      access_log: true,
      error_handler: async ({ response }: Context): Promise<void> => {
        // The reply of `/` comes once the deadline of `/next` has passed
        await sleep(40);
        await response.status(503).send("late");
      },
    });
    const listening = await listen(app);
    try {
      const responses = await converse(listening.port, requests);
      deepStrictEqual(
        responses.map(({ head, body }) => [head.split("\r\n")[0], body]),
        [
          ["HTTP/1.1 503 Service Unavailable", "late"],
          ["HTTP/1.1 200 OK", "next"],
        ],
      );
      // Finalized once it has been sent
      deepStrictEqual(await within(closed), true);
      const logged = captured.records.filter(
        ({ msg }) => msg === "The request has completed",
      );
      deepStrictEqual(
        logged.map(({ status, aborted }) => [status, aborted]),
        [
          [503, true],
          [200, true],
        ],
      );
      await captured.waitFor(
        "The deadline has passed once the response was complete. It is sent after the responses before it",
      );
    } finally {
      await listening.close();
    }
  });

  test("is sent once that response is, after a pipe of its stack has failed (on every Node.js)", async () => {
    const captured = capture();
    const waiting = Promise.withResolvers<boolean>();
    const app = new Binden({ logger: captured.logger }).use(
      async (context: Context) => {
        const { response } = context;
        if (context.url.pathname !== "/next") {
          response.setHeader("Content-Length", 10).write("first");
          await sleep(60);
          response.end("-done");
          return;
        }
        const source = new PassThrough();
        source.pipe(response);
        // Added in the turn of the pipe: its throw fails the stack, once the
        // pipe has ended the response, which waits for `/`
        source.once("end", () => {
          waiting.resolve(response.writableEnded && response.socket === null);
          throw new Error("A listener of the end has failed");
        });
        source.end("next");
        await once(response, "close");
      },
    );
    const listening = await listen(app);
    try {
      const responses = await converse(
        listening.port,
        "GET / HTTP/1.1\r\nHost: a\r\n\r\n" +
          "GET /next HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n",
      );
      ok(await within(waiting.promise));
      deepStrictEqual(
        responses.map(({ head, body }) => [head.split("\r\n")[0], body]),
        [
          ["HTTP/1.1 200 OK", "first-done"],
          ["HTTP/1.1 200 OK", "next"],
        ],
      );
      const { failure } = await captured.waitFor(
        "A pipe into the response has failed once its reply was complete. It is sent after the responses before it",
      );
      const { type, location } = failure as Record<string, unknown>;
      deepStrictEqual([type, location], ["Error", "send"]);
    } finally {
      await listening.close();
    }
  });

  test("is not a reply that has only started, which is still cut at its deadline", async () => {
    const { app, captured, closed } = queued(
      {
        timeout: 50,
        error_handler: async ({
          request,
          response,
        }: Context): Promise<void> => {
          if (request.url === "/") {
            await sleep(40);
            await response.status(503).send("late");
          }
        },
      },
      false,
    );
    const listening = await listen(app);
    const socket = connect(listening.port, "localhost");
    try {
      await once(socket, "connect");
      let data = "";
      socket.setEncoding("latin1").on("data", (chunk: string) => {
        data += chunk;
      });
      socket.write(requests);
      // Destroyed: closed before it has finished (its connection is closed
      // once it would be sent, see `cut.test.ts`)
      deepStrictEqual(await within(closed), false);
      await captured.waitFor("The deadline has passed. Destroying the socket");
      // The response before it is complete
      await within(
        (async (): Promise<void> => {
          while (!data.includes("\r\n\r\nlate")) {
            await sleep(5);
          }
        })(),
      );
      ok(data.startsWith("HTTP/1.1 503 Service Unavailable\r\n"), data);
    } finally {
      socket.destroy();
      await listening.close();
    }
  });

  test("is cut when the client goes away, on every Node.js", async () => {
    const { app, captured, ended, closed } = queued({});
    const listening = await listen(app);
    try {
      const socket = connect(listening.port, "localhost");
      await once(socket, "connect");
      socket.write(requests);
      await within(ended);
      socket.destroy();
      // Closed by the framework once its connection has closed (Node.js
      // 24.14 never closes it by itself)
      deepStrictEqual(await within(closed), false);
      const message = "The request has been aborted. Destroying the socket";
      await captured.waitFor(message);
      // `/` and `/next`
      deepStrictEqual(
        captured.records
          .filter(({ msg }) => msg === message)
          .map(({ reason }) => reason),
        ["client_closed", "client_closed"],
      );
    } finally {
      await listening.close();
    }
  });

  test("is cut by a shutdown that times out, on every Node.js", async () => {
    const { app, captured, ended, closed } = queued({});
    const listening = await listen(app);
    const socket = connect(listening.port, "localhost");
    await once(socket, "connect");
    let data = "";
    socket.setEncoding("latin1").on("data", (chunk: string) => {
      data += chunk;
    });
    socket.write(requests);
    await within(ended);
    const closing = shutdown(listening.server, {
      timeout: 50,
      cleanup_timeout: 100,
    }).then(
      () => null,
      (error: unknown) => (error as Error).message,
    );
    await within(once(socket, "close"));
    deepStrictEqual(data, "");
    // Its cleanup runs once its connection has closed
    deepStrictEqual(await within(closing), null);
    deepStrictEqual(await within(closed), false);
    // Both requests, at the end of the time of the shutdown
    deepStrictEqual(
      captured.records
        .filter(
          ({ msg }) =>
            msg === "The request has been aborted. Destroying the socket",
        )
        .map(({ reason }) => reason),
      ["shutdown", "shutdown"],
    );
  });
});

suite("A sealed reply that waits for the response before it", () => {
  /**
   * An application whose `/` replies only after `hold` milliseconds (without
   * a deadline of its own), and whose `/next` (with the deadline of the
   * application) ends its reply at once (`complete`, which is left to be
   * sent once its deadline has passed) or never replies (`hangs`: the `503`
   * of its deadline waits as well), and reads its body first (`read`): how
   * the response of `/next` is closed, once
   */
  function sealed(
    kind: "complete" | "hangs",
    hold: number,
  ): {
    app: Binden;
    captured: ICaptured;
    cleaned: Promise<boolean>;
    events: string[];
  } {
    const captured = capture();
    const cleaned = Promise.withResolvers<boolean>();
    const events: string[] = [];
    const app = new Binden({
      timeout: 30,
      access_log: { path: "path" },
      logger: captured.logger,
    }).use(async (context: Context) => {
      const { request, response } = context;
      if (context.url.pathname !== "/next") {
        context.setTimeout(0);
        await sleep(hold);
        await context.text("first");
        return;
      }
      context.onCleanup(() => {
        // Closed by Node.js, or destroyed by the framework
        events.push(`cleanup (destroyed: ${String(response.destroyed)})`);
        cleaned.resolve(response.writableFinished);
      });
      request.once("close", () => {
        events.push("request closed");
      });
      for await (const chunk of request) {
        events.push(`read ${String(chunk)}`);
      }
      if (kind === "hangs") {
        await never();
      }
      response.end("next");
      // Without a connection yet
      ok(response.socket === null);
    });
    return { app, captured, cleaned: cleaned.promise, events };
  }

  const requests =
    "GET / HTTP/1.1\r\nHost: a\r\n\r\n" +
    "POST /next HTTP/1.1\r\nHost: a\r\nContent-Length: 4\r\n\r\nbody";

  /** The `aborted` of the access log of `/next` */
  const nextAborted = (captured: ICaptured): unknown[] =>
    captured.records
      .filter(
        ({ msg, path }) =>
          msg === "The request has completed" && path === "/next",
      )
      .map(({ aborted }) => aborted);

  for (const kind of ["complete", "hangs"] as const) {
    test(`${kind === "complete" ? "a complete reply left at its deadline" : "the 503 of its deadline"}: finalized once the client goes away`, async () => {
      const { app, captured, cleaned, events } = sealed(kind, 5000);
      const listening = await listen(app);
      try {
        const socket = connect(listening.port, "localhost");
        await once(socket, "connect");
        socket.write(requests);
        // Once its deadline has passed
        await sleep(80);
        deepStrictEqual(events, ["read body", "request closed"]);
        socket.destroy();
        deepStrictEqual(await within(cleaned), false);
        await captured.waitFor("The request has completed");
        await sleep(20);
        deepStrictEqual(nextAborted(captured), [true]);
        // Once
        deepStrictEqual(events, [
          "read body",
          "request closed",
          "cleanup (destroyed: true)",
        ]);
      } finally {
        await listening.close();
      }
    });

    test(`${kind === "complete" ? "a complete reply left at its deadline" : "the 503 of its deadline"}: finalized by a shutdown that times out`, async () => {
      const { app, cleaned, events } = sealed(kind, 5000);
      const listening = await listen(app);
      const socket = connect(listening.port, "localhost");
      try {
        await once(socket, "connect");
        socket.on("error", () => null);
        socket.write(requests);
        await sleep(80);
        const closing = shutdown(listening.server, {
          timeout: 50,
          cleanup_timeout: 200,
        }).then(
          () => null,
          (error: unknown) => (error as Error).message,
        );
        deepStrictEqual(await within(closing), null);
        deepStrictEqual(await within(cleaned), false);
        deepStrictEqual(events, [
          "read body",
          "request closed",
          "cleanup (destroyed: true)",
        ]);
      } finally {
        socket.destroy();
      }
    });
  }

  test("is not finalized by the close of its request (its body read): it is sent once that response is", async () => {
    const { app, cleaned, events } = sealed("complete", 150);
    const listening = await listen(app);
    try {
      const responses = await converse(
        listening.port,
        requests.replace(
          "POST /next HTTP/1.1\r\n",
          "POST /next HTTP/1.1\r\nConnection: close\r\n",
        ),
      );
      deepStrictEqual(
        responses.map(({ head, body }) => [head.split("\r\n")[0], body]),
        [
          ["HTTP/1.1 200 OK", "first"],
          ["HTTP/1.1 200 OK", "next"],
        ],
      );
      deepStrictEqual(await within(cleaned), true);
      deepStrictEqual(events, [
        "read body",
        "request closed",
        "cleanup (destroyed: true)",
      ]);
    } finally {
      await listening.close();
    }
  });
});
