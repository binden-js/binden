import { Binden, BindenAbortError, type Context } from "../index.js";
import { capture, listen, pollUntil, send, sleep, within } from "./helpers.js";
import { deepStrictEqual, ok } from "node:assert/strict";
import { suite, test } from "node:test";
import { Readable } from "node:stream";
import { connect } from "node:net";
import { join } from "node:path";
import { once } from "node:events";
import { spawnSync } from "node:child_process";

/** A raw connection to a server */
interface IRaw {
  /** Writes bytes to the server */
  write(text: string): void;
  /**
   * Resolves with what has been received once it passes the check (or once
   * the server has closed the connection), within 5 s
   */
  until(check: (data: string) => boolean): Promise<string>;
  /** Whether the server has closed the connection */
  readonly closed: boolean;
  close(): void;
}

/** Opens a raw connection to a port */
async function connection(port: number): Promise<IRaw> {
  const socket = connect(port, "127.0.0.1");
  await once(socket, "connect");
  let data = "";
  let closed = false;
  socket
    .setEncoding("latin1")
    .on("data", (chunk: string) => {
      data += chunk;
    })
    .on("error", () => {
      // Closed by the server: `close` follows
    })
    .on("close", () => {
      closed = true;
    });
  return {
    write: (text: string): void => {
      socket.write(text);
    },
    until: async (check: (received: string) => boolean): Promise<string> => {
      const deadline = Date.now() + 5000;
      for (;;) {
        if (check(data) || closed) {
          return data;
        } else if (Date.now() > deadline) {
          throw new Error(`Not received: ${JSON.stringify(data)}`);
        }
        await sleep(5);
      }
    },
    get closed(): boolean {
      return closed;
    },
    close: (): void => {
      socket.destroy();
    },
  };
}

/** The status lines of the responses that a connection has received, and their bodies (framed by `Content-Length`) */
function responsesOf(data: string): [string, string][] {
  const responses: [string, string][] = [];
  let rest = data;
  while (rest !== "") {
    const end = rest.indexOf("\r\n\r\n");
    ok(end !== -1, `Not a response: ${JSON.stringify(data)}`);
    const head = rest.slice(0, end);
    const length = Number(
      /^Content-Length: (?<length>\d+)$/imu.exec(head)?.groups?.length ?? 0,
    );
    const status = head.slice(0, head.indexOf("\r\n"));
    const close = /^Connection: close$/imu.test(head) ? " (close)" : "";
    responses.push([
      `${status}${close}`,
      rest.slice(end + 4, end + 4 + length),
    ]);
    rest = rest.slice(end + 4 + length);
  }
  return responses;
}

/** How a send has settled: `resolved`, or its error (its `code`, or itself) */
function outcomeOf(promise: Promise<void>): Promise<unknown> {
  return promise.then(
    () => "resolved",
    (error: unknown) => (error as { code?: unknown }).code ?? error,
  );
}

suite("A Node.js `Readable` that a response does not send", () => {
  test("released by many sends (to `HEAD`, with 204 or 103): one guard, which logs its late error, and no warning", async () => {
    const captured = capture();
    const warnings: string[] = [];
    const warned = (warning: Error): void => {
      warnings.push(warning.name);
    };
    process.on("warning", warned);
    // Its destroy fails once every send has released it
    const failing = Promise.withResolvers<null>();
    const source = new Readable({
      read(): void {
        // Nothing to read
      },
      destroy(_error, callback): void {
        failing.promise.then(
          () => {
            callback(new Error("The source has failed to close"));
          },
          () => null,
        );
      },
    });
    const outcomes: unknown[] = [];
    const app = new Binden({
      logger: captured.logger,
      log_error_details: true,
    }).use(async (context: Context) => {
      const { pathname } = context.url;
      if (pathname === "/no-content") {
        context.status(204);
      } else if (pathname === "/informational") {
        context.status(103);
      }
      outcomes.push(
        await context.response.send(source).then(
          () => "resolved",
          (error: unknown) => (error as Error).name,
        ),
      );
    });
    const listening = await listen(app);
    try {
      const statuses: number[] = [];
      for (let index = 0; index < 21; index += 1) {
        const [method, path] = (
          [
            ["HEAD", "/"],
            ["GET", "/no-content"],
            ["GET", "/informational"],
          ] as const
        )[index % 3] as readonly [string, string];
        statuses.push((await send(listening.port, { method, path })).status);
      }
      // The send of a 103 rejects, and the middleware replies nothing
      deepStrictEqual(
        statuses,
        Array.from({ length: 7 }, () => [200, 204, 404]).flat(),
      );
      deepStrictEqual(
        outcomes,
        Array.from({ length: 7 }, () => [
          "resolved",
          "resolved",
          "TypeError",
        ]).flat(),
      );
      // Released once, by `Readable.prototype.destroy()`: its guard is the
      // only listener that the sends have left on it
      deepStrictEqual(
        [
          source.destroyed,
          source.readableFlowing,
          source.listenerCount("error"),
          source.listenerCount("close"),
        ],
        [true, null, 1, 1],
      );
      failing.resolve(null);
      const record = await captured.waitFor(
        "A stream-like source has failed once released",
      );
      deepStrictEqual(
        [record.level, (record.failure as { message: string }).message],
        [20, "The source has failed to close"],
      );
      // Removed on the turn after its `close`
      await pollUntil(() => source.listenerCount("error") === 0);
      deepStrictEqual(source.listenerCount("close"), 0);
      deepStrictEqual(
        captured.records.filter(
          ({ msg }) => msg === "A stream-like source has failed once released",
        ).length,
        1,
      );
      deepStrictEqual(warnings, []);
    } finally {
      process.off("warning", warned);
      await listening.close();
    }
  });
});

suite("The request of a response, sent as its body (an echo)", () => {
  test("by a late send, or once the response has ended: ignored, never destroyed (the 503 of the deadline, and the responses pipelined with it)", async () => {
    const outcomes: unknown[] = [];
    const app = new Binden({ logger: capture().logger }).use(
      async (context: Context) => {
        const { pathname } = context.url;
        if (pathname === "/slow") {
          // The others wait for its response on the connection
          await sleep(100);
          await context.text("slow");
          return;
        } else if (pathname === "/late") {
          context.setTimeout(20);
          await sleep(60);
          outcomes.push(await outcomeOf(context.send(context.request)));
          return;
        } else if (pathname === "/ended") {
          // Ended, and sent once the responses before it have been
          const sent = context.text("ended");
          outcomes.push(
            await outcomeOf(context.response.send(context.request)),
          );
          await sent;
          return;
        }
        await context.text("next");
      },
    );
    const listening = await listen(app);
    const raw = await connection(listening.port);
    try {
      raw.write(
        "GET /slow HTTP/1.1\r\nHost: localhost\r\n\r\n" +
          "POST /late HTTP/1.1\r\nHost: localhost\r\nContent-Length: 5\r\n\r\nhello" +
          "POST /ended HTTP/1.1\r\nHost: localhost\r\nContent-Length: 5\r\n\r\nhello" +
          "GET /next HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
      );
      const data = await raw.until(() => false);
      deepStrictEqual(responsesOf(data), [
        ["HTTP/1.1 200 OK", "slow"],
        ["HTTP/1.1 503 Service Unavailable", ""],
        ["HTTP/1.1 200 OK", "ended"],
        ["HTTP/1.1 200 OK (close)", "next"],
      ]);
      deepStrictEqual(outcomes, ["resolved", "resolved"]);
    } finally {
      raw.close();
      await listening.close();
    }
  });

  test("to `HEAD`, with a 204 or a 1xx status: not destroyed (complete replies, without a body, and the connection is kept)", async () => {
    const outcomes: unknown[] = [];
    const app = new Binden({ logger: capture().logger }).use(
      async (context: Context) => {
        const { pathname } = context.url;
        if (pathname === "/next") {
          await context.text("next");
          return;
        } else if (pathname === "/no-content") {
          context.status(204);
        } else if (pathname === "/informational") {
          context.status(103);
        }
        const outcome = await outcomeOf(context.send(context.request));
        outcomes.push(outcome instanceof TypeError ? "TypeError" : outcome);
        if (outcome !== "resolved") {
          // Replied (500)
          throw outcome;
        }
      },
    );
    const listening = await listen(app);
    const raw = await connection(listening.port);
    try {
      raw.write(
        "HEAD / HTTP/1.1\r\nHost: localhost\r\n\r\n" +
          "GET /no-content HTTP/1.1\r\nHost: localhost\r\n\r\n" +
          "POST /no-content HTTP/1.1\r\nHost: localhost\r\nContent-Length: 5\r\n\r\nhello" +
          "GET /next HTTP/1.1\r\nHost: localhost\r\n\r\n" +
          // Its error is replied (the last request of the connection)
          "POST /informational HTTP/1.1\r\nHost: localhost\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello",
      );
      const data = await raw.until(() => false);
      deepStrictEqual(data.match(/HTTP\/1\.1 [^\r]*/gu), [
        "HTTP/1.1 200 OK",
        "HTTP/1.1 204 No Content",
        "HTTP/1.1 204 No Content",
        "HTTP/1.1 200 OK",
        "HTTP/1.1 500 Internal Server Error",
      ]);
      ok(data.includes("\r\n\r\nnextHTTP/1.1 500 "), data);
      deepStrictEqual(outcomes, [
        "resolved",
        "resolved",
        "resolved",
        "TypeError",
      ]);
    } finally {
      raw.close();
      await listening.close();
    }
  });

  test("whose body has not come, cancelled by the deadline: the 503, which closes the connection", async () => {
    const outcome = Promise.withResolvers<unknown>();
    const app = new Binden({ logger: capture().logger, timeout: 30 }).use(
      async (context: Context) => {
        outcome.resolve(await outcomeOf(context.send(context.request)));
      },
    );
    const listening = await listen(app);
    const raw = await connection(listening.port);
    try {
      raw.write(
        "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n",
      );
      const data = await raw.until(() => false);
      deepStrictEqual(responsesOf(data), [
        ["HTTP/1.1 503 Service Unavailable (close)", ""],
      ]);
      const reason = await within(outcome.promise);
      ok(reason instanceof BindenAbortError, String(reason));
      deepStrictEqual(reason.reason, "deadline");
    } finally {
      raw.close();
      await listening.close();
    }
  });

  test("whose body has not come, by an error handler that fails: cancelled, and the 500 closes the connection", async () => {
    const outcome = Promise.withResolvers<unknown>();
    const failure = new Error("The error handler has failed");
    const app = new Binden({
      logger: capture().logger,
      error_handler: async (context: Context): Promise<void> => {
        outcomeOf(context.send(context.request)).then(
          outcome.resolve,
          outcome.reject,
        );
        await sleep(20);
        throw failure;
      },
    }).use(() => {
      throw new Error("A failure");
    });
    const listening = await listen(app);
    const raw = await connection(listening.port);
    try {
      raw.write(
        "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n",
      );
      const data = await raw.until(() => false);
      deepStrictEqual(responsesOf(data), [
        ["HTTP/1.1 500 Internal Server Error (close)", ""],
      ]);
      deepStrictEqual(await within(outcome.promise), failure);
    } finally {
      raw.close();
      await listening.close();
    }
  });

  test("longer than its `Content-Length`, before the headers: the send rejects, and its error is replied on the connection", async () => {
    const outcome = Promise.withResolvers<unknown[]>();
    const echoed = Promise.withResolvers<Context["request"]>();
    const app = new Binden({ logger: capture().logger }).use(
      async (context: Context) => {
        context.response.setHeader("Content-Length", 3);
        const error = await outcomeOf(context.send(context.request));
        const { socket } = context.request;
        // Nothing of the send is left on it but its guard, which listens
        // until the turn after its close (see below)
        outcome.resolve([
          error,
          socket.destroyed,
          context.request.listenerCount("error"),
          context.request.listenerCount("data"),
        ]);
        echoed.resolve(context.request);
        throw new Error("Replied");
      },
    );
    const listening = await listen(app);
    const raw = await connection(listening.port);
    try {
      raw.write(
        "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 5\r\n\r\nhello",
      );
      // The connection is closed after it, as for any error replied before
      // the body of the request has been parsed in full
      const data = await raw.until(() => false);
      deepStrictEqual(responsesOf(data), [
        ["HTTP/1.1 500 Internal Server Error (close)", ""],
      ]);
      deepStrictEqual(await within(outcome.promise), [
        "ERR_HTTP_CONTENT_LENGTH_MISMATCH",
        false,
        1,
        0,
      ]);
      const request = await within(echoed.promise);
      await pollUntil(() => request.listenerCount("error") === 0);
      ok(request.closed);
    } finally {
      raw.close();
      await listening.close();
    }
  });

  test("whose error Node.js has scheduled once it has found the listener of the send, without a listener of the application: its guard, which listens before the send removes its own, logs it, and the process does not crash", () => {
    for (const [mode, expected] of [
      // A write of the response fails while the request aborts
      ["write", "Write aborted 0\n"],
      // Its client goes away once the send has failed
      ["rst", "ERR_HTTP_CONTENT_LENGTH_MISMATCH 0\n20 ECONNRESET\n"],
      ["fin", "ERR_HTTP_CONTENT_LENGTH_MISMATCH 0\n20 ECONNRESET\n"],
    ] as const) {
      const { status, stdout, stderr } = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          join(import.meta.dirname, "fixtures", "echo-errors.ts"),
          mode,
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      deepStrictEqual(
        { mode, status, stdout, stderr },
        { mode, status: 0, stdout: expected, stderr: "" },
      );
    }
  });

  test("longer than its `Content-Length`, once the headers are committed: the send rejects, and the connection is closed", async () => {
    const outcome = Promise.withResolvers<unknown>();
    const app = new Binden({ logger: capture().logger }).use(
      async (context: Context) => {
        context.response.setHeader("Content-Length", 7);
        outcome.resolve(await outcomeOf(context.send(context.request)));
      },
    );
    const listening = await listen(app);
    const raw = await connection(listening.port);
    try {
      // The rest of its body would not come
      raw.write(
        "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 20\r\n\r\nhello",
      );
      // Its first chunk is sent
      await raw.until((data) => data.endsWith("\r\n\r\nhello"));
      raw.write("world");
      const data = await raw.until(() => false);
      ok(raw.closed);
      ok(data.startsWith("HTTP/1.1 200 OK\r\n"), data);
      ok(data.endsWith("\r\n\r\nhello"), data);
      deepStrictEqual(
        await within(outcome.promise),
        "ERR_HTTP_CONTENT_LENGTH_MISMATCH",
      );
    } finally {
      raw.close();
      await listening.close();
    }
  });

  test(
    "paused by the backpressure of its send, whose reply another writer ends: resumed (the rest of its body is read, and the next request of the connection answered)",
    {
      // Windows takes a whole write while its send buffer has room: the
      // response is never full, and the send never pauses the request
      skip: process.platform === "win32",
    },
    async () => {
      const size = 4 * 1024 * 1024;
      const paused = Promise.withResolvers<null>();
      const outcome = Promise.withResolvers<unknown>();
      const app = new Binden({ logger: capture().logger }).use(
        async (context: Context) => {
          if (context.url.pathname === "/next") {
            await context.text("next");
            return;
          }
          const sent = outcomeOf(context.send(context.request));
          // Its client does not read the reply yet
          await pollUntil(() => context.request.isPaused());
          paused.resolve(null);
          context.response.end();
          outcome.resolve(await sent);
        },
      );
      const listening = await listen(app);
      const socket = connect(listening.port, "127.0.0.1");
      try {
        await once(socket, "connect");
        let tail = "";
        socket
          .on("data", (chunk: Buffer) => {
            tail = (tail + chunk.toString("latin1")).slice(-100);
          })
          .on("error", () => {
            // Closed by the server: `close` follows
          })
          .pause();
        socket.write(
          `POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${size}\r\n\r\n`,
        );
        socket.write(Buffer.alloc(size / 2, "a"));
        await within(paused.promise);
        socket.resume();
        deepStrictEqual(await within(outcome.promise), "resolved");
        socket.write(Buffer.alloc(size / 2, "b"));
        socket.write(
          "GET /next HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        );
        await within(
          new Promise((resolve) => {
            socket.once("close", resolve);
          }),
        );
        ok(tail.endsWith("\r\n\r\nnext"), tail);
      } finally {
        socket.destroy();
        await listening.close();
      }
    },
  );

  test("whose reply another writer ends before its body has come: not destroyed (the rest of its body is read, and the connection is kept)", async () => {
    const outcome = Promise.withResolvers<unknown>();
    const app = new Binden({ logger: capture().logger }).use(
      async (context: Context) => {
        if (context.url.pathname === "/next") {
          await context.text("next");
          return;
        }
        const sent = outcomeOf(context.send(context.request));
        await sleep(10);
        context.response.end("other");
        outcome.resolve(await sent);
      },
    );
    const listening = await listen(app);
    const raw = await connection(listening.port);
    try {
      raw.write(
        "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\n",
      );
      await raw.until((data) => data.endsWith("\r\n\r\nother"));
      deepStrictEqual(await within(outcome.promise), "resolved");
      // Once the response has closed
      await sleep(20);
      raw.write(
        "helloworld" +
          "GET /next HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
      );
      const data = await raw.until(() => false);
      deepStrictEqual(responsesOf(data), [
        ["HTTP/1.1 200 OK", "other"],
        ["HTTP/1.1 200 OK (close)", "next"],
      ]);
    } finally {
      raw.close();
      await listening.close();
    }
  });
});
