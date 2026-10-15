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
import { deepStrictEqual, ok, rejects } from "node:assert/strict";
import { suite, test } from "node:test";
import { Readable } from "node:stream";
import { connect } from "node:net";
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

/** A source that never ends (nor pushes anything by itself) */
function silent(): Readable {
  return new Readable({
    read(): void {
      // Nothing
    },
  });
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
});
