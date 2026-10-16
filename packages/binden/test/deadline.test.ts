import { type AddressInfo, connect } from "node:net";
import {
  Binden,
  BindenAbortError,
  BindenError,
  type Context,
  Cookie,
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
import { type IncomingMessage, createServer, get } from "node:http";
import { PassThrough, Readable } from "node:stream";
import { deepStrictEqual, ok, rejects } from "node:assert/strict";
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

  test("cancels a send that has not committed its headers, which the time out of an error handler cuts", async () => {
    await withApp(
      {
        timeout: 60,
        error_handler_timeout: 30,
        error_handler: async (
          context: Context,
          error: unknown,
        ): Promise<void> => {
          if (context.url.pathname === "/handler" && !isDeadline(error)) {
            // Started (see `response.started`): its time out cuts it
            await context.send(silent());
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
        const cut = await client(port);
        try {
          await rejects(cut.request("/handler"), /No complete response: ""/u);
          ok(cut.closed);
        } finally {
          cut.close();
        }
      },
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
});
