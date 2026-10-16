/* eslint-disable init-declarations */
import {
  Binden,
  BindenAbortError,
  BindenError,
  BindenResponse,
  type Context,
  Cookie,
  type IBindenOptions,
  type IResponseOperation,
  kOperation,
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
import {
  type IncomingHttpHeaders,
  IncomingMessage,
  type OutgoingHttpHeaders,
  ServerResponse,
  request,
} from "node:http";
import { PassThrough, Readable } from "node:stream";
import { Socket, connect } from "node:net";
import { after, afterEach, before, mock, suite, test } from "node:test";
import { deepStrictEqual, ok } from "node:assert/strict";
import fsp, {
  type FileHandle,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { kCancel, kFramework, kSeal, owners } from "../src/seal.js";
import { join } from "node:path";
import { listen as listenPlain } from "./http.js";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";

/** A response as the client receives it, with its informational responses */
interface IReceived {
  readonly status: number;
  readonly message: string;
  readonly headers: IncomingHttpHeaders;
  readonly trailers: NodeJS.Dict<string>;
  readonly body: string;
  readonly informational: number[];
}

/** Sends a request (on a new connection), and reads its response within 5 s */
function fetch(
  port: number,
  headers: OutgoingHttpHeaders = {},
): Promise<IReceived> {
  return new Promise<IReceived>((resolve, reject) => {
    const informational: number[] = [];
    request({ agent: false, headers, port, signal: AbortSignal.timeout(5000) })
      .on("information", ({ statusCode }) => {
        informational.push(statusCode);
      })
      .on("response", (response) => {
        let body = "";
        response
          .setEncoding("utf8")
          .on("data", (chunk: string) => {
            body += chunk;
          })
          .once("end", () => {
            resolve({
              status: response.statusCode ?? 0,
              message: response.statusMessage ?? "",
              headers: response.headers,
              trailers: response.trailers,
              body,
              informational,
            });
          })
          .once("error", reject);
      })
      .once("error", reject)
      .end();
  });
}

/**
 * Sends a request on a connection that is not read for `pause` milliseconds
 * (a slow client), then reads everything until the server closes it
 */
async function slowly(port: number, pause: number): Promise<Buffer> {
  const socket = connect(port, "localhost");
  await once(socket, "connect");
  socket.write(
    "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
  );
  socket.pause();
  await sleep(pause);
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  const closed = once(socket, "close");
  socket.resume();
  await within(closed, 10_000);
  return Buffer.concat(chunks);
}

/**
 * Sends raw bytes on a new connection, and reads the head of the response
 * (the connection is closed once it has come)
 */
async function headOf(port: number, data: string): Promise<string> {
  const socket = connect(port, "localhost");
  await once(socket, "connect");
  let received = "";
  const { promise, resolve } = Promise.withResolvers<string>();
  socket.setEncoding("latin1").on("data", (chunk: string) => {
    received += chunk;
    const end = received.indexOf("\r\n\r\n");
    if (end !== -1) {
      resolve(received.slice(0, end));
    }
  });
  socket.write(data);
  try {
    return await within(promise, 5000);
  } finally {
    socket.destroy();
  }
}

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

/** A promise with its `resolve()` */
function gate(): { promise: Promise<void>; open(): void } {
  const { promise, resolve } = Promise.withResolvers<never>();
  return { promise, open: resolve as () => void };
}

/** A source that never ends (nor pushes anything by itself) */
function silent(): Readable {
  return new Readable({
    read(): void {
      // Nothing
    },
  });
}

/** The reason of the rejection of a promise (`null` once it resolves) */
function reasonOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

suite("Ownership of the response once the exchange is sealed", () => {
  test("every mutation of the abandoned work is ignored once the deadline has passed", async () => {
    const abandoned = gate();
    const calls: string[] = [];
    let synchronous = 0;
    let accepted: unknown = null;
    const threw: unknown[] = [];
    const handlerCookie = new Cookie({ key: "handler", value: "1" });
    const callback =
      (name: string) =>
      (...args: unknown[]): void => {
        calls.push(`${name}:${args.length}`);
      };
    await withApp(
      {
        timeout: 20,
        error_handler: async (context: Context): Promise<void> => {
          context.response
            .status(503)
            .setHeader("X-Handler", "1")
            .cookies.add(handlerCookie);
          // The abandoned work tries to reply in the meantime
          await abandoned.promise;
          // Chunked, with its trailers (and headers that are set only now)
          context.response.setHeader("Content-Type", "text/plain");
          context.response.write("hand");
          context.response.end("ler");
        },
      },
      (app) => {
        app.use(async (context: Context) => {
          const { response } = context;
          // Captured before the deadline
          const { cookies } = response;
          await sleep(60);
          // Not even validated
          for (const invalid of [
            (): unknown => response.status(99),
            (): unknown => response.type("invalid"),
            (): unknown => response.vary("a b"),
            (): unknown => response.attachment(""),
            (): unknown => response.clearCookie("a b"),
            (): unknown => response.setHeaders(null as never),
          ]) {
            try {
              invalid();
            } catch (error: unknown) {
              threw.push(error);
            }
          }
          response.setHeader("X-Late", "1");
          response.appendHeader("X-Handler", "late");
          response.removeHeader("X-Handler");
          response.setHeaders(new Map([["X-Late-Map", "1"]]));
          response.statusCode = 200;
          response.statusMessage = "Late";
          response
            .status(201)
            .set({ "X-Set": "1" })
            .type("text/html")
            .vary("X-Late")
            .attachment("late.txt")
            .clearCookie("handler");
          cookies.add(new Cookie({ key: "late", value: "1" }));
          cookies.delete(handlerCookie);
          cookies.clear();
          response.writeContinue(callback("continue"));
          response.writeProcessing(callback("processing"));
          response.writeEarlyHints(
            { link: "</late.css>; rel=preload" },
            callback("hints"),
          );
          response.addTrailers({ "X-Trailer": "late" });
          response.flushHeaders();
          response.writeHead(200, { "X-Head": "late" });
          // The alias of Node.js 24 as well
          response.writeHeader(200, { "X-Header": "late" });
          accepted = response.write("late", callback("write"));
          response.write("late", "utf8", callback("write-encoding"));
          response.end("late", callback("end"));
          response.end(callback("end-again"));
          response.destroy();
          synchronous = calls.length;
          await context.send("late");
          await context.response.json({ late: true });
          await sleep(10);
          abandoned.open();
        });
      },
      async ({ port }) => {
        const received = await fetch(port);
        deepStrictEqual(
          [received.status, received.message, received.body],
          [503, "Service Unavailable", "handler"],
        );
        deepStrictEqual(received.informational, []);
        deepStrictEqual(received.headers["x-handler"], "1");
        deepStrictEqual(received.headers["set-cookie"], [
          handlerCookie.toString(),
        ]);
        deepStrictEqual(received.headers["content-type"], "text/plain");
        deepStrictEqual(received.trailers, {});
        for (const name of [
          "x-late",
          "x-late-map",
          "x-set",
          "x-head",
          "x-header",
          "vary",
          "content-disposition",
          "trailer",
        ]) {
          ok(!(name in received.headers), name);
        }
      },
    );
    deepStrictEqual(threw, []);
    // Called once each, asynchronously, without an error
    deepStrictEqual(synchronous, 0);
    deepStrictEqual(accepted, true);
    deepStrictEqual(calls.toSorted(), [
      "continue:0",
      "end-again:0",
      "end:0",
      "hints:0",
      "processing:0",
      "write-encoding:0",
      "write:0",
    ]);
  });

  test(
    "without writeInformation() (before Node.js 24.18.0), it is ignored or throws",
    {
      skip:
        typeof (ServerResponse.prototype as { writeInformation?: unknown })
          .writeInformation === "function",
    },
    async () => {
      const abandoned = gate();
      const calls: string[] = [];
      await withApp(
        {
          timeout: 20,
          error_handler: async (context: Context): Promise<void> => {
            await abandoned.promise;
            try {
              context.response.writeInformation(110, {});
            } catch (error: unknown) {
              calls.push(error instanceof TypeError ? "TypeError" : "other");
            }
            await context.status(503).send("handler");
          },
        },
        (app) => {
          app.use(async (context: Context) => {
            await sleep(60);
            // Ignored, as Node.js would not have it either: no TypeError
            context.response.writeInformation(102, {}, () => {
              calls.push("ignored");
            });
            abandoned.open();
          });
        },
        async ({ port }) => {
          const received = await fetch(port);
          deepStrictEqual(received.body, "handler");
        },
      );
      deepStrictEqual(calls.toSorted(), ["TypeError", "ignored"]);
    },
  );

  test(
    "an informational response of the abandoned work is ignored",
    // From Node.js 24.18.0
    {
      skip:
        typeof (ServerResponse.prototype as { writeInformation?: unknown })
          .writeInformation !== "function",
    },
    async () => {
      const abandoned = gate();
      const calls: number[] = [];
      await withApp(
        {
          timeout: 20,
          error_handler: async (context: Context): Promise<void> => {
            await abandoned.promise;
            context.response.writeInformation(110, {}, () => {
              calls.push(110);
            });
            await context.status(503).send("handler");
          },
        },
        (app) => {
          app.use(async (context: Context) => {
            await sleep(60);
            context.response.writeInformation(102, {}, () => {
              calls.push(102);
            });
            context.response.writeInformation(103, { link: "</a>" });
            abandoned.open();
          });
        },
        async ({ port }) => {
          const received = await fetch(port);
          deepStrictEqual(received.informational, [110]);
          deepStrictEqual(received.body, "handler");
        },
      );
      deepStrictEqual(
        calls.toSorted((a, b) => a - b),
        [102, 110],
      );
    },
  );

  test("the reply of a deadline closes the connection of a body that has not been read", async () => {
    await withApp(
      { timeout: 30 },
      (app) => {
        app.use(async () => {
          // Does not read the body
          await never();
        });
      },
      async ({ port }) => {
        // The rest of the body is never sent
        const unread = await headOf(
          port,
          "POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 1000\r\n\r\npart",
        );
        ok(unread.startsWith("HTTP/1.1 503 "), unread);
        ok(/^Connection: close$/imu.test(unread), unread);
        // Without a body, the connection is kept
        const read = await headOf(port, "GET / HTTP/1.1\r\nHost: a\r\n\r\n");
        ok(read.startsWith("HTTP/1.1 503 "), read);
        ok(/^Connection: keep-alive$/imu.test(read), read);
      },
    );
  });

  test("the abandoned work changes neither the connection nor the headers of the reply", async () => {
    const abandoned = gate();
    await withApp(
      {
        timeout: 20,
        error_handler: async (context: Context): Promise<void> => {
          await abandoned.promise;
          // Long enough for a timeout of the socket of 1 ms
          await sleep(30);
          await context.status(503).send("handler");
        },
      },
      (app) => {
        app.use(async (context: Context) => {
          const { response } = context;
          // Arrays of values, kept by the work before the deadline
          const set = ["a"];
          response.setHeader("X-Set", set);
          response.setHeader("X-Got", ["a"]);
          const got = response.getHeader("X-Got") as string[];
          response.setHeader("X-All", ["a"]);
          const all = response.getHeaders()["x-all"] as string[];
          const appended = ["a"];
          response.appendHeader("X-Appended", appended);
          const mapped = ["a"];
          response.setHeaders(new Map([["X-Mapped", mapped]]));
          await sleep(60);
          for (const values of [set, got, all, appended, mapped]) {
            values.push("late");
          }
          response.sendDate = false;
          response.shouldKeepAlive = false;
          response.setTimeout(1);
          abandoned.open();
        });
      },
      async ({ port }) => {
        const head = await headOf(port, "GET / HTTP/1.1\r\nHost: a\r\n\r\n");
        ok(head.startsWith("HTTP/1.1 503 "), head);
        ok(/^Date: /mu.test(head), head);
        ok(/^Connection: keep-alive$/imu.test(head), head);
        for (const name of [
          "X-Set",
          "X-Got",
          "X-All",
          "X-Appended",
          "X-Mapped",
        ]) {
          ok(head.includes(`\r\n${name}: a\r\n`), head);
        }
        ok(!head.includes("late"), head);
      },
    );
  });

  test("a cancelled source is released without the rights of the framework", async () => {
    const released = gate();
    await withApp(
      { timeout: 20 },
      (app) => {
        app.use(async (context: Context) => {
          const { response } = context;
          const source = new Readable({
            read(): void {
              // Its first chunk never comes
            },
            destroy(error, callback): void {
              // Code of the application, run by the cancellation
              response.setHeader("X-Released", "1");
              response.statusCode = 200;
              released.open();
              callback(error);
            },
          });
          await reasonOf(context.send(source));
          await never();
        });
      },
      async ({ port }) => {
        const head = await headOf(port, "GET / HTTP/1.1\r\nHost: a\r\n\r\n");
        await within(released.promise);
        ok(head.startsWith("HTTP/1.1 503 "), head);
        ok(!/^X-Released/imu.test(head), head);
      },
    );
  });

  test("the default error reply closes the connection of a body that has not been read in full", async () => {
    await withApp(
      {},
      (app) => {
        app.use(async (context: Context) => {
          if (context.request.method === "POST") {
            // A part of the body, then a failure
            await once(context.request, "data");
          }
          throw new BindenError(422);
        });
      },
      async ({ port }) => {
        // The rest of the body is never sent: Node.js would wait for it
        // before it reads the next request of the connection
        const unread = await headOf(
          port,
          "POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 1000\r\n\r\npart",
        );
        ok(unread.startsWith("HTTP/1.1 422 "), unread);
        ok(/^Connection: close$/imu.test(unread), unread);
        const read = await headOf(port, "GET / HTTP/1.1\r\nHost: a\r\n\r\n");
        ok(read.startsWith("HTTP/1.1 422 "), read);
        ok(/^Connection: keep-alive$/imu.test(read), read);
      },
    );
  });

  test("the error replies have the reason phrase of their status", async () => {
    await withApp(
      {
        error_handler: (context: Context): void => {
          if (context.url.pathname === "/failed-handler") {
            // Refused by Node.js: the opaque `500` does not keep it
            context.response.statusMessage = "a\nb";
            throw new Error("Failed");
          }
        },
      },
      (app) => {
        app.use((context: Context) => {
          context.response.status(201).statusMessage = "Made";
          throw new BindenError(422);
        });
      },
      async ({ port }) => {
        for (const [path, line] of [
          ["/", "HTTP/1.1 422 Unprocessable Entity"],
          ["/failed-handler", "HTTP/1.1 500 Internal Server Error"],
        ]) {
          const head = await headOf(
            port,
            `GET ${path} HTTP/1.1\r\nHost: a\r\n\r\n`,
          );
          deepStrictEqual(head.split("\r\n")[0], line);
        }
      },
    );
  });

  test("the reply of a timed out error handler closes the connection of a body that has not been read", async () => {
    await withApp(
      {
        error_handler_timeout: 20,
        error_handler: async (): Promise<void> => {
          await never();
        },
      },
      (app) => {
        app.use(() => {
          throw new Error("Failed");
        });
      },
      async ({ port }) => {
        const unread = await headOf(
          port,
          "POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 1000\r\n\r\npart",
        );
        ok(unread.startsWith("HTTP/1.1 500 "), unread);
        ok(/^Connection: close$/imu.test(unread), unread);
        const read = await headOf(port, "GET / HTTP/1.1\r\nHost: a\r\n\r\n");
        ok(read.startsWith("HTTP/1.1 500 "), read);
        ok(/^Connection: keep-alive$/imu.test(read), read);
      },
    );
  });

  test("a stream piped by the abandoned work does not start the response", async () => {
    const abandoned = gate();
    await withApp(
      {
        timeout: 20,
        error_handler: async (): Promise<void> => {
          // It does not reply: the default reply is sent
          await abandoned.promise;
        },
      },
      (app) => {
        app.use(async (context: Context) => {
          await sleep(60);
          silent().pipe(context.response);
          abandoned.open();
        });
      },
      async ({ port }) => {
        const received = await fetch(port);
        deepStrictEqual([received.status, received.body], [503, ""]);
      },
    );
  });

  test(
    "a timed out error handler that has ended its reply: it is still sent, and its late mutations are ignored",
    {
      // Windows takes a whole write while its send buffer has room: the
      // response may finish before the client reads it
      skip: process.platform === "win32",
    },
    async () => {
      const size = 8 * 1024 * 1024;
      const states: boolean[] = [];
      await withApp(
        {
          error_handler_timeout: 50,
          error_handler: async (context: Context): Promise<void> => {
            const { response } = context;
            response.status(500);
            // Not awaited: the client reads slowly
            response.send(Buffer.alloc(size, "a")).catch(() => null);
            states.push(response.writableEnded, response.writableFinished);
            await sleep(150);
            states.push(response.writableFinished);
            // Once timed out
            response.destroy();
            response.setHeader("X-Late", "1");
            response.statusCode = 200;
            await never();
          },
        },
        (app) => {
          app.use(() => {
            throw new Error("Failed");
          });
        },
        async ({ port }, captured) => {
          const received = await slowly(port, 400);
          const index = received.indexOf("\r\n\r\n");
          const head = received.subarray(0, index).toString();
          ok(head.startsWith("HTTP/1.1 500 "), head);
          deepStrictEqual(received.length - index - 4, size);
          await captured.waitFor(
            "The provided `error_handler` has not settled in time",
          );
        },
      );
      deepStrictEqual(states, [true, false, false]);
    },
  );

  test("a deadline cancels a send whose first chunk has not come: the error handler replies at once", async () => {
    const source = silent();
    let rejection: unknown = null;
    let started: unknown = null;
    await withApp(
      {
        timeout: 30,
        error_handler: (context: Context): void => {
          ({ started } = context.response);
          // A late continuation of the stream, while the handler replies
          source.emit("data", "late");
          source.emit("end");
          // Framed by Node.js: the length set for the stream is gone
          context.response.statusCode = 503;
          context.response.end("deadline");
        },
      },
      (app) => {
        app.use(async (context: Context) => {
          context.response.status(206).set({
            "Content-Length": 1000,
            "Content-Range": "bytes 0-999/2000",
          });
          rejection = await reasonOf(context.response.send(source));
        });
      },
      async ({ port }) => {
        const received = await fetch(port);
        // Chunked, as Node.js frames a body without a length
        deepStrictEqual(
          [
            received.status,
            received.body,
            received.headers["content-length"] ?? null,
            received.headers["transfer-encoding"],
          ],
          [503, "deadline", null, "chunked"],
        );
        ok(!("content-range" in received.headers));
      },
    );
    deepStrictEqual(started, false);
    ok(source.destroyed);
    ok(rejection instanceof BindenAbortError);
    deepStrictEqual(rejection.reason, "deadline");
  });

  test("a deadline once a send has committed its headers closes the connection", async () => {
    await withApp(
      { timeout: 30 },
      (app) => {
        app.use(async (context: Context) => {
          const source = silent();
          source.push("first");
          await context.response.send(source);
        });
      },
      async ({ port }) => {
        await within(
          fetch(port).then(
            () => {
              throw new Error("Not cut");
            },
            () => null,
          ),
        );
      },
    );
  });

  suite("`sendFile()` cancelled by a deadline", () => {
    let tmp: string;
    let file: string;

    before(async () => {
      tmp = await realpath(await mkdtemp(join(tmpdir(), "binden-owner-")));
      file = join(tmp, "file.txt");
      await writeFile(file, "file");
    });

    after(async () => {
      await rm(tmp, { recursive: true, force: true });
    });

    afterEach(() => {
      mock.restoreAll();
      syncBuiltinESMExports();
    });

    /** The streams of the files (see `delay()`) */
    const streams: Readable[] = [];

    /** Delays `open()` (and `stat()` of the handles that it opens) until the gates open */
    const delay = ({
      opening,
      stating,
      reading,
    }: {
      opening?: Promise<void>;
      stating?: Promise<void>;
      reading?: Promise<void>;
    }): FileHandle[] => {
      const handles: FileHandle[] = [];
      streams.length = 0;
      const { open: original } = fsp;
      mock.method(
        fsp,
        "open",
        async (...args: Parameters<typeof original>): Promise<FileHandle> => {
          await opening;
          const handle = await original(...args);
          const stat = handle.stat.bind(handle);
          handle.stat = (async () => {
            await stating;
            return stat();
          }) as FileHandle["stat"];
          const create = handle.createReadStream.bind(handle);
          handle.createReadStream = ((
            ...options: Parameters<FileHandle["createReadStream"]>
          ) => {
            const stream = create(...options);
            streams.push(stream);
            if (!reading) {
              return stream;
            }
            // Read once the gate opens (`stream.pipe()` would start it)
            const proxy = new PassThrough();
            proxy.once("close", () => {
              stream.destroy();
            });
            reading
              .then(() => {
                stream.pipe(proxy);
              })
              .catch(() => null);
            return proxy;
          }) as FileHandle["createReadStream"];
          handles.push(handle);
          return handle;
        },
      );
      syncBuiltinESMExports();
      return handles;
    };

    /** Resolves once every handle is closed */
    const closed = async (handles: FileHandle[]): Promise<void> => {
      // Not polled forever: a file that stays open fails the test
      const deadline = Date.now() + 2000;
      while (handles.length === 0 || handles.some(({ fd }) => fd !== -1)) {
        if (Date.now() > deadline) {
          throw new Error("A file is still open");
        }
        await sleep(5);
      }
    };

    /**
     * A file operation cancelled in a phase goes on while the error handler
     * replies: the file is closed, and nothing of it is replied
     */
    const cancelled = async (phase: "opening" | "stating"): Promise<void> => {
      const released = gate();
      const handles = delay({ [phase]: released.promise });
      let rejection: unknown = null;
      await withApp(
        {
          timeout: 30,
          error_handler: async (context: Context): Promise<void> => {
            context.response.status(503).setHeader("X-Handler", "1");
            // The file operation goes on meanwhile
            released.open();
            await within(closed(handles));
            await sleep(10);
            await context.send("handler");
          },
        },
        (app) => {
          app.use(async (context: Context) => {
            rejection = await reasonOf(context.response.sendFile(file));
          });
        },
        async ({ port }) => {
          const received = await fetch(port);
          deepStrictEqual(
            [received.status, received.body, received.headers["x-handler"]],
            [503, "handler", "1"],
          );
          for (const name of [
            "etag",
            "last-modified",
            "accept-ranges",
            "x-content-type-options",
          ]) {
            ok(!(name in received.headers), name);
          }
        },
      );
      ok(rejection instanceof BindenAbortError);
      deepStrictEqual(handles.length, 1);
      // Opened or stated late: it is not read (no stream of it)
      deepStrictEqual(streams.length, 0);
    };

    test("while the file is opened, concurrently with the reply of the error handler", async () => {
      await cancelled("opening");
    });

    test("while the metadata of the file is read, concurrently with the reply of the error handler", async () => {
      await cancelled("stating");
    });

    test("while its stream has not delivered its first chunk: its status and its headers are removed", async () => {
      const handles = delay({ reading: never() });
      let rejection: unknown = null;
      await withApp(
        {
          timeout: 30,
          error_handler: (context: Context): void => {
            // The status from before the file
            context.response.end("handler");
          },
        },
        (app) => {
          app.use(async (context: Context) => {
            context.response
              .setHeader("X-Before", "1")
              .setHeader("Content-Type", "text/html");
            rejection = await reasonOf(
              context.response.sendFile(file, { content_type: "text/plain" }),
            );
          });
        },
        async ({ port }) => {
          const received = await fetch(port, { Range: "bytes=0-1" });
          deepStrictEqual(
            [
              received.status,
              received.body,
              received.headers["x-before"],
              received.headers["content-type"],
            ],
            [200, "handler", "1", "text/html"],
          );
          for (const name of [
            "etag",
            "last-modified",
            "accept-ranges",
            "content-range",
            "x-content-type-options",
          ]) {
            ok(!(name in received.headers), name);
          }
        },
      );
      ok(rejection instanceof BindenAbortError);
      await within(closed(handles));
    });

    test("the reply does not wait for the file, whose headers are removed", async () => {
      const released = gate();
      const handles = delay({ stating: released.promise });
      await withApp(
        { timeout: 30 },
        (app) => {
          app.use(async (context: Context) => {
            context.response.setHeader("ETag", '"before"');
            await context.response.sendFile(file, {
              cache_control: "no-store",
            });
          });
        },
        async ({ port }) => {
          const received = await fetch(port);
          deepStrictEqual([received.status, received.body], [503, ""]);
          ok(!("cache-control" in received.headers));
          // The default reply removes the `ETag`
          ok(!("etag" in received.headers));
        },
      );
      released.open();
      await within(closed(handles));
    });

    test("while the path is resolved under `root`: the file is not opened", async () => {
      const released = gate();
      const handles = delay({});
      const { realpath: original } = fsp;
      // The root, then the file
      const resolved: Promise<string>[] = [];
      const both = gate();
      mock.method(fsp, "realpath", (path: string): Promise<string> => {
        const real = released.promise.then(async () => original(path));
        resolved.push(real);
        if (resolved.length === 2) {
          both.open();
        }
        return real;
      });
      syncBuiltinESMExports();
      await withApp(
        { timeout: 30 },
        (app) => {
          app.use(async (context: Context) => {
            await context.response.sendFile("file.txt", { root: tmp });
          });
        },
        async ({ port }) => {
          deepStrictEqual((await fetch(port)).status, 503);
        },
      );
      released.open();
      await within(both.promise);
      await Promise.all(resolved);
      await sleep(20);
      deepStrictEqual(handles.length, 0);
    });

    test("once the stack has completed", async () => {
      const released = gate();
      const handles = delay({ opening: released.promise });
      await withApp(
        { timeout: 30 },
        (app) => {
          app.use((context: Context) => {
            context.response.sendFile(file).catch(() => null);
            context.done = true;
          });
        },
        async ({ port }) => {
          deepStrictEqual((await fetch(port)).status, 503);
        },
      );
      released.open();
      await within(closed(handles));
    });

    test("an unexpected failure once the stack has completed closes the connection", async () => {
      const released = gate();
      const handles = delay({ opening: released.promise });
      await withApp(
        { timeout: 30 },
        (app) => {
          app.use((context: Context) => {
            context.setHeader("ETag", '"tag"');
            context.response.sendFile(file).catch(() => null);
            context.done = true;
            // The cancellation fails: it restores the headers
            context.response.removeHeader = (): never => {
              throw new Error("Unexpected");
            };
          });
        },
        async ({ port }, captured) => {
          await within(
            fetch(port).then(
              () => {
                throw new Error("Not cut");
              },
              () => null,
            ),
          );
          await captured.waitFor("The request has failed");
        },
      );
      released.open();
      await within(closed(handles));
    });
  });
});

suite("Operations of a response (sealed by its own checks)", () => {
  /** Handles one request on a server of `BindenResponse` */
  const serve = async (
    handler: (response: BindenResponse) => Promise<void>,
  ): Promise<{ status: number; body: string }> => {
    const server = await listenPlain();
    try {
      const handled = server.handle(async (_request, response) =>
        handler(response),
      );
      const reply = await server.request();
      deepStrictEqual(await handled, null);
      return { status: reply.status, body: reply.body.toString() };
    } finally {
      await server.close();
    }
  };

  test("the callbacks of a stream run as the owner that has sent it", async () => {
    const first = {};
    const second = {};
    let owner: object = first;
    const source = silent();
    const reply = await serve(async (response) => {
      response[kSeal]((current) => current === owner);
      const sent = reasonOf(owners.run(first, () => response.send(source)));
      // The owner changes before the first chunk, which comes from its work
      owner = second;
      await owners.run(second, async () => {
        source.push("late");
        await sleep(10);
        // Released at once
        ok(source.destroyed);
        ok(!response.headersSent);
        await response.status(503).send("second");
      });
      // Released: it has not been sent
      deepStrictEqual(
        ((await sent) as { code?: unknown }).code,
        "ERR_STREAM_PREMATURE_CLOSE",
      );
    });
    deepStrictEqual(reply, { status: 503, body: "second" });
  });

  test("the callbacks of a stream keep the rights of its owner, whoever emits them", async () => {
    const first = {};
    const second = {};
    const source = silent();
    const reply = await serve(async (response) => {
      response[kSeal]((current) => current === second);
      const sent = owners.run(second, () => response.send(source));
      // Flowing: a chunk pushed now is emitted at once
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      // Pushed by the work of an owner that may not reply
      owners.run(first, () => {
        source.push("data");
        source.push(null);
      });
      await sent;
    });
    deepStrictEqual(reply, { status: 200, body: "data" });
  });

  test("a cancelled send ignores its source, which it has released", async () => {
    const source = silent();
    let rejection: unknown = null;
    const reason = new Error("Cancelled");
    const reply = await serve(async (response) => {
      response.setHeader("Content-Range", "bytes 0-3/4");
      const sent = reasonOf(response.send(source));
      ok(response.started);
      response[kCancel](reason);
      ok(!response.started);
      ok(source.destroyed);
      ok(!response.hasHeader("Content-Range"));
      rejection = await sent;
      // A source that emits after its release
      source.emit("data", "late");
      source.emit("end");
      await response.status(503).send("reply");
    });
    deepStrictEqual(reply, { status: 503, body: "reply" });
    deepStrictEqual(rejection, reason);
  });

  test("[kCancel]() once the headers are committed cancels nothing", async () => {
    const source = silent();
    const reply = await serve(async (response) => {
      response.setHeader("Content-Length", 4);
      const sent = response.send(source);
      response.flushHeaders();
      response[kCancel](new Error("Cancelled"));
      ok(response.started);
      source.push("data");
      source.push(null);
      await sent;
    });
    deepStrictEqual(reply, { status: 200, body: "data" });
  });

  test("[kOperation]()", async () => {
    let allowed = true;
    const reply = await serve(async (response) => {
      response[kSeal](() => allowed);
      const operation = response[kOperation]() as IResponseOperation;
      ok(operation.active);
      // Not ended: no transfer
      operation.transfer();
      allowed = false;
      deepStrictEqual(response[kOperation](), null);
      ok(!operation.active);
      operation.transfer();
      deepStrictEqual(
        operation.run(() => response.setHeader("X-Revoked", "1")),
        response,
      );
      ok(!response.hasHeader("X-Revoked"));
      allowed = true;
      operation.run(() => response.write("data"));
      // Ended: its transfer goes on once its owner is revoked
      response.end();
      operation.transfer();
      allowed = false;
      ok(operation.active);
      operation.run(() => {
        response.addTrailers({ "X-Trailer": "1" });
      });
      ok(!response.destroyed);
      await sleep(10);
    });
    deepStrictEqual(reply, { status: 200, body: "data" });
  });

  test("the native methods once allowed", async () => {
    const reply = await serve(async (response) => {
      response[kSeal](() => true);
      const informational = Promise.all([
        new Promise<void>((resolve) => {
          response.writeContinue(resolve);
        }),
        new Promise<void>((resolve) => {
          response.writeProcessing(resolve);
        }),
        new Promise<void>((resolve) => {
          response.writeEarlyHints({ link: "</a.css>; rel=preload" }, resolve);
        }),
      ]);
      response.setHeaders(new Map([["X-Map", "1"]]));
      response.appendHeader("X-Map", "2");
      response.statusMessage = "Fine";
      response.cookies.add(new Cookie({ key: "a", value: "1" }));
      response.cookies.clear();
      response.writeHead(200, { Trailer: "X-Trailer" });
      response.addTrailers({ "X-Trailer": "1" });
      await new Promise<void>((resolve) => {
        response.end("done", resolve);
      });
      await informational;
      deepStrictEqual(
        [response.getHeader("X-Map"), response.statusMessage],
        [["1", "2"], "Fine"],
      );
    });
    deepStrictEqual(reply, { status: 200, body: "done" });
  });

  test("a response sealed without checks: only the framework mutates it", () => {
    const response = new BindenResponse(new IncomingMessage(new Socket()));
    response[kSeal]();
    response.status(404);
    response.statusCode = 404;
    deepStrictEqual(response.statusCode, 200);
    response[kFramework](() => {
      response.statusCode = 404;
    });
    deepStrictEqual(response.statusCode, 404);
  });
});
