import { type AddressInfo, connect } from "node:net";
import {
  Binden,
  BindenError,
  type Context,
  type IBindenOptions,
} from "../index.js";
import { EventEmitter, once } from "node:events";
import {
  type ICaptured,
  capture,
  ioTurn,
  listen,
  never,
  pollUntil,
  sleep,
  within,
} from "./helpers.js";
import { PassThrough, Readable, pipeline } from "node:stream";
import { createServer, get } from "node:http";
import { deepStrictEqual, ok } from "node:assert/strict";
import { suite, test } from "node:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { owners } from "../src/seal.js";

/** A listener, as an emitter has it */
type IListener = (...args: unknown[]) => unknown;

/** The context that `otel()` binds the listeners of an emitter to */
const contexts = new AsyncLocalStorage<string>();

/** A listener bound to the context of `otel()` */
function bindTo(listener: IListener): IListener {
  return function bound(this: unknown, ...args: unknown[]): unknown {
    return contexts.run("span", () => Reflect.apply(listener, this, args));
  };
}

/**
 * Binds the listeners of an emitter to a context, as `context.bind()` of
 * OpenTelemetry does (`AsyncLocalStorageContextManager`, for the requests
 * and responses of its `http` instrumentation): listener methods of its own
 * that wrap every listener, and that unwrap one to remove it
 */
function otel<T extends EventEmitter>(emitter: T): T {
  const patches = new Map<unknown, WeakMap<IListener, IListener>>();
  const state = { wrapping: false };
  const define = (name: string, value: IListener): void => {
    Object.defineProperty(emitter, name, {
      configurable: true,
      writable: true,
      value,
    });
  };
  for (const name of [
    "addListener",
    "on",
    "once",
    "prependListener",
    "prependOnceListener",
  ]) {
    const original = Reflect.get(emitter, name) as IListener;
    define(name, function bind(this: T, event, listener): unknown {
      if (state.wrapping) {
        return Reflect.apply(original, this, [event, listener]);
      }
      const bound = bindTo(listener as IListener);
      const listeners = patches.get(event) ?? new WeakMap();
      patches.set(event, listeners);
      listeners.set(listener as IListener, bound);
      state.wrapping = true;
      try {
        return Reflect.apply(original, this, [event, bound]);
      } finally {
        state.wrapping = false;
      }
    });
  }
  for (const name of ["removeListener", "off"]) {
    const original = Reflect.get(emitter, name) as IListener;
    define(name, function unbind(this: T, event, listener): unknown {
      const bound = patches.get(event)?.get(listener as IListener);
      return Reflect.apply(original, this, [event, bound ?? listener]);
    });
  }
  const removeAll = Reflect.get(emitter, "removeAllListeners") as IListener;
  define("removeAllListeners", function clear(this: T, ...args): unknown {
    if (args.length === 0) {
      patches.clear();
    } else {
      patches.delete(args[0]);
    }
    return Reflect.apply(removeAll, this, args);
  });
  return emitter;
}

/** Whether the error is the `503` of a deadline */
function isDeadline(error: unknown): boolean {
  return error instanceof BindenError && error.code === "deadline";
}

/** What a client has received on its connection, and whether it is closed */
interface IRaw {
  readonly raw: string;
  readonly closed: boolean;
}

/** Whether a complete response has come (framed by its length, or by its last chunk) */
function complete(raw: string): boolean {
  const end = raw.indexOf("\r\n\r\n");
  if (end === -1) {
    return false;
  }
  const length = /^Content-Length: (?<n>\d+)$/imu.exec(raw.slice(0, end))
    ?.groups?.n;
  return typeof length === "undefined"
    ? raw.endsWith("\r\n0\r\n\r\n")
    : raw.length >= end + 4 + Number(length);
}

/**
 * Sends a request on a new connection, then reads what comes until the
 * connection is closed, or for `ms` once a complete response has come (it
 * may take longer on a loaded machine: within 10 s), so that what would
 * follow it is seen (judged after a turn of the pending I/O; once the end of
 * the connection has been read, by its `close` itself)
 */
async function exchange(
  port: number,
  { method = "GET", body = "", ms = 300 } = {},
): Promise<IRaw> {
  const socket = connect(port, "127.0.0.1");
  await once(socket, "connect");
  const received = { raw: "", closed: false };
  const { promise: closing, resolve: close } = Promise.withResolvers<null>();
  socket.setEncoding("latin1").on("data", (chunk: string) => {
    received.raw += chunk;
  });
  socket.on("close", () => {
    received.closed = true;
    close(null);
  });
  socket.write(
    `${method} / HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
  );
  await pollUntil(() => received.closed || complete(received.raw)).catch(
    () => null,
  );
  const deadline = Date.now() + ms;
  while (!received.closed && Date.now() < deadline) {
    await sleep(5);
  }
  await ioTurn();
  if (socket.readableEnded) {
    // Its `close` follows
    await within(closing);
  }
  socket.destroy();
  return {
    raw: received.raw
      .replace(/\r\nDate: [^\r]*/u, "")
      .replace(/\r\nKeep-Alive: [^\r]*/u, ""),
    closed: received.closed,
  };
}

/** The status and the body of a complete response */
function replied({ raw }: IRaw): [number, string] {
  const end = raw.indexOf("\r\n\r\n");
  const status = Number(raw.slice(9, 12));
  const length = Number(/^Content-Length: (?<n>\d+)$/imu.exec(raw)?.groups?.n);
  const body = raw.slice(end + 4);
  if (Number.isNaN(length)) {
    // Chunked
    let decoded = "";
    let rest = body;
    for (;;) {
      const line = rest.indexOf("\r\n");
      const size = Number.parseInt(rest.slice(0, line), 16);
      if (!(size > 0)) {
        return [status, decoded];
      }
      decoded += rest.slice(line + 2, line + 2 + size);
      rest = rest.slice(line + 2 + size + 2);
    }
  }
  return [status, body.slice(0, length)];
}

/** Runs `fn` with a listening application (with a captured debug logger) */
async function withApp(
  options: IBindenOptions,
  setup: (app: Binden) => void,
  fn: (port: number, captured: ICaptured) => Promise<void>,
): Promise<void> {
  const captured = capture();
  const app = new Binden({ ...options, logger: captured.logger });
  setup(app);
  const listening = await listen(app);
  try {
    await fn(listening.port, captured);
  } finally {
    await listening.close();
  }
}

/** The reasons logged with a message */
function reasons(captured: ICaptured, message: string): unknown[] {
  return captured.records
    .filter(({ msg }) => msg === message)
    .map(({ reason }) => reason);
}

/** Whether the framework has attempted a reply (it must not, once destroyed) */
function attempted(captured: ICaptured): boolean {
  return captured.records.some(
    ({ msg }) =>
      msg === "The request has failed" ||
      msg === "The error reply has not been sent",
  );
}

/** The message of a pipe that the stack leaves to Node.js */
const left = "A pipe has been left to Node.js";

/** The message of a pipe of a revoked stack that is not proven dismantled */
const unproven =
  "A pipe left to Node.js by an abandoned work may still write. Destroying the socket";

/** Sets the state of a source as if it had emitted its `end` */
function saysEnded(source: PassThrough): void {
  const state = Reflect.get(source, "_readableState") as {
    endEmitted: boolean;
  };
  state.endEmitted = true;
}

/** Feeds a source from a timer of no request: its chunks, then its end */
function feed(source: PassThrough, chunks: readonly string[], ms = 5): void {
  owners.exit(() => {
    setTimeout(() => {
      for (const chunk of chunks) {
        source.write(chunk);
      }
      source.end();
    }, ms);
  });
}

suite(
  "A pipe of the stack whose source has listener methods of its own",
  () => {
    for (const name of [
      "on",
      "addListener",
      "once",
      "prependListener",
      "prependOnceListener",
      "removeListener",
      "off",
      "removeAllListeners",
    ]) {
      test(`(its own \`${name}()\`) is left to Node.js: as without binden`, async () => {
        await withApp(
          {},
          (app) => {
            app.use(async ({ response }: Context) => {
              response.type("text/plain");
              const source = new PassThrough();
              const inherited = Reflect.get(
                PassThrough.prototype,
                name,
              ) as IListener;
              Object.defineProperty(source, name, {
                configurable: true,
                writable: true,
                value(this: PassThrough, ...args: unknown[]): unknown {
                  return Reflect.apply(inherited, this, args);
                },
              });
              source.pipe(response);
              feed(source, ["REAL"]);
              await never();
            });
          },
          async (port, captured) => {
            const reply = await exchange(port);
            deepStrictEqual(replied(reply), [200, "REAL"]);
            deepStrictEqual(reasons(captured, left), [
              `the source has its own ${name}()`,
            ]);
          },
        );
      });
    }

    test("starts the response: a middleware that returns at once leaves it to its pipe", async () => {
      await withApp(
        {},
        (app) => {
          app.use(({ response }: Context) => {
            response.type("text/plain");
            const source = otel(new PassThrough());
            source.pipe(response);
            feed(source, ["REAL"]);
          });
        },
        async (port) => {
          deepStrictEqual(replied(await exchange(port)), [200, "REAL"]);
        },
      );
    });

    suite("bound by OpenTelemetry (its `http` instrumentation)", () => {
      /** An upstream server whose reply is a body of its own */
      const upstream = async (): Promise<{
        port: number;
        close(): Promise<void>;
      }> => {
        const server = createServer((_request, response) => {
          response.setHeader("Content-Type", "text/plain");
          response.end("UPSTREAM");
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        return {
          port: (server.address() as AddressInfo).port,
          close: async (): Promise<void> => {
            server.closeAllConnections();
            server.close();
            await once(server, "close");
          },
        };
      };

      for (const kind of ["echo", "proxy pipe", "proxy pipeline"]) {
        test(`${kind}: the reply of the stack`, async () => {
          const up = await upstream();
          try {
            await withApp(
              {},
              (app) => {
                app.use(async ({ request, response }: Context) => {
                  // As the instrumentation binds them
                  otel(request);
                  otel(response);
                  if (kind === "echo") {
                    request.pipe(response);
                    await once(response, "close");
                    return;
                  }
                  const source = await new Promise<Readable>((resolve) => {
                    get({ port: up.port, host: "127.0.0.1" }, (proxied) => {
                      resolve(otel(proxied));
                    });
                  });
                  if (kind === "proxy pipe") {
                    source.pipe(response);
                    await once(response, "close");
                  } else {
                    await new Promise((resolve) => {
                      pipeline(source, response, resolve);
                    });
                  }
                });
              },
              async (port, captured) => {
                const reply = await exchange(port, {
                  method: "POST",
                  body: "ECHO",
                });
                deepStrictEqual(replied(reply), [
                  200,
                  kind === "echo" ? "ECHO" : "UPSTREAM",
                ]);
                deepStrictEqual(reasons(captured, left), [
                  "the source has its own on()",
                ]);
              },
            );
          } finally {
            await up.close();
          }
        });
      }

      test("a deadline before any byte: the connection is closed, nothing replaces the reply", async () => {
        await withApp(
          { timeout: 20 },
          (app) => {
            app.use(async ({ response }: Context) => {
              otel(new PassThrough()).pipe(response);
              await never();
            });
          },
          async (port, captured) => {
            const reply = await exchange(port);
            deepStrictEqual(reply, { raw: "", closed: true });
            deepStrictEqual(reasons(captured, unproven), [
              "the source has its own on()",
            ]);
            ok(
              captured.records.some(
                ({ msg }) =>
                  msg ===
                  "The response has been destroyed: nothing replaces the reply",
              ),
            );
            ok(!attempted(captured), captured.output());
          },
        );
      });

      test("a deadline once its source has ended (`{ end: false }`): the connection is closed all the same", async () => {
        await withApp(
          { timeout: 30 },
          (app) => {
            app.use(async ({ response }: Context) => {
              const source = otel(new PassThrough());
              source.end();
              source.pipe(response, { end: false });
              await once(source, "end");
              await never();
            });
          },
          async (port, captured) => {
            deepStrictEqual(await exchange(port), { raw: "", closed: true });
            deepStrictEqual(reasons(captured, unproven), [
              "the source has its own on()",
            ]);
            ok(!attempted(captured), captured.output());
          },
        );
      });

      test("a deadline once its pipe has ended the response, which waits for the one before it: the reply is kept", async () => {
        await withApp(
          { timeout: 100 },
          (app) => {
            app.use(async (context: Context) => {
              const { request, response } = context;
              response.type("text/plain");
              if (request.url === "/first") {
                // Replies after the deadline of the request after it
                context.setTimeout(0);
                await sleep(250);
                await context.send("FIRST");
                return;
              }
              const source = otel(new PassThrough());
              source.pipe(response);
              feed(source, ["REAL"]);
              await once(source, "end");
              await never();
            });
          },
          async (port, captured) => {
            // Pipelined: the second response waits for the first one
            const socket = connect(port, "127.0.0.1");
            await once(socket, "connect");
            let raw = "";
            socket.setEncoding("latin1").on("data", (chunk: string) => {
              raw += chunk;
            });
            socket.write(
              "GET /first HTTP/1.1\r\nHost: localhost\r\n\r\nGET / HTTP/1.1\r\nHost: localhost\r\n\r\n",
            );
            await pollUntil(() => raw.endsWith("REAL\r\n0\r\n\r\n")).catch(
              () => null,
            );
            await sleep(20);
            await ioTurn();
            const { closed } = socket;
            socket.destroy();
            deepStrictEqual(
              [...raw.matchAll(/HTTP\/1\.1 (?<code>\d+)/gu)].map(
                ({ groups }) => groups?.code,
              ),
              ["200", "200"],
            );
            ok(raw.includes("FIRSTHTTP/1.1 200 OK"), raw);
            ok(raw.endsWith("\r\n\r\n4\r\nREAL\r\n0\r\n\r\n"), raw);
            ok(!closed);
            deepStrictEqual(reasons(captured, left), [
              "the source has its own on()",
            ]);
            await captured.waitFor(
              "The deadline has passed once the response was complete. It is sent after the responses before it",
            );
            deepStrictEqual(reasons(captured, unproven), []);
          },
        );
      });

      test("a failure of a pipe of the stack once its pipe has finished the response: the reply is kept", async () => {
        await withApp(
          {},
          (app) => {
            app.use(async ({ response }: Context) => {
              response.type("text/plain");
              const source = otel(new PassThrough());
              source.pipe(response);
              feed(source, ["REAL"]);
              await once(response, "finish");
              // Refused (and the stack fails): its source has listeners of
              // its listeners
              const refused = new PassThrough();
              refused.on("newListener", () => null);
              refused.pipe(response);
              await never();
            });
          },
          async (port, captured) => {
            const reply = await exchange(port);
            deepStrictEqual(replied(reply), [200, "REAL"]);
            ok(!reply.closed);
            deepStrictEqual(reasons(captured, left), [
              "the source has its own on()",
            ]);
            deepStrictEqual(reasons(captured, unproven), []);
          },
        );
      });

      test("`context.send()` of such a stream, which binden reads itself: the 503 of a deadline", async () => {
        await withApp(
          { timeout: 20 },
          (app) => {
            app.use(async (context: Context) => {
              await context.send(otel(new PassThrough()));
            });
          },
          async (port, captured) => {
            const reply = await exchange(port);
            deepStrictEqual(replied(reply)[0], 503);
            deepStrictEqual(reasons(captured, left), []);
          },
        );
      });

      test("whose `close` listeners the stack has removed: the connection is closed at the deadline", async () => {
        await withApp(
          { timeout: 20 },
          (app) => {
            app.use(async ({ response }: Context) => {
              otel(new PassThrough()).pipe(response);
              response.removeAllListeners("close");
              await never();
            });
          },
          async (port) => {
            deepStrictEqual(await exchange(port), { raw: "", closed: true });
          },
        );
      });

      for (const handler of ["deadline", "thrown"]) {
        test(`of an error handler (${handler === "deadline" ? "of a deadline" : "of a thrown error"}): refused, 500`, async () => {
          await withApp(
            {
              ...(handler === "deadline" ? { timeout: 20 } : {}),
              error_handler: async (context: Context): Promise<void> => {
                context.response.status(503);
                const source = otel(new PassThrough());
                source.pipe(context.response);
                feed(source, ["HANDLER"]);
                await never();
              },
            },
            (app) => {
              app.use(async () => {
                if (handler === "thrown") {
                  throw new BindenError(409);
                }
                await never();
              });
            },
            async (port, captured) => {
              const reply = await exchange(port);
              deepStrictEqual(replied(reply), [500, ""]);
              ok(!reply.raw.includes("HANDLER"));
              await captured.waitFor("The provided `error_handler` has failed");
              deepStrictEqual(reasons(captured, left), []);
            },
          );
        });
      }
    });

    suite(
      "once the stack is revoked, before anything replaces its reply",
      () => {
        for (const spoof of [
          "none",
          "endEmitted",
          "readableEnded",
          "emit",
        ] as const) {
          test(`own \`on()\` and \`removeListener()\` that leave the listener of the pipe (says it has ended: ${spoof}): the connection is closed, nothing of it is sent`, async () => {
            const shared = new PassThrough();
            await withApp(
              {
                timeout: 20,
                error_handler: async (
                  context: Context,
                  error,
                ): Promise<void> => {
                  if (isDeadline(error)) {
                    // The reply of the error handler, through the shared source
                    shared.write("OLD");
                    await context.status(503).send("handler");
                  }
                },
              },
              (app) => {
                app.use(async ({ response }: Context) => {
                  const extra = (): null => null;
                  const on = Reflect.get(
                    PassThrough.prototype,
                    "on",
                  ) as IListener;
                  const remove = Reflect.get(
                    EventEmitter.prototype,
                    "removeListener",
                  ) as IListener;
                  Object.assign(shared, {
                    on(this: PassThrough, event: string, listener: IListener) {
                      Reflect.apply(on, this, [event, listener]);
                      if (event === "data" && listener !== extra) {
                        Reflect.apply(on, this, [event, extra]);
                      }
                      return this;
                    },
                    removeListener(
                      this: PassThrough,
                      event: string,
                      listener: IListener,
                    ) {
                      return Reflect.apply(remove, this, [
                        event,
                        event === "data" ? extra : listener,
                      ]);
                    },
                  });
                  shared.pipe(response);
                  // At its revocation, before the pipe is dismantled: the
                  // source says that it has ended, then flows again
                  response.once("close", () => {
                    if (spoof === "endEmitted") {
                      saysEnded(shared);
                    } else if (spoof === "readableEnded") {
                      Object.defineProperty(shared, "readableEnded", {
                        configurable: true,
                        value: true,
                      });
                    } else if (spoof === "emit") {
                      shared.emit("end");
                    }
                    process.nextTick(() => shared.resume());
                  });
                  await never();
                });
              },
              async (port, captured) => {
                const reply = await exchange(port);
                // Fed after the deadline as well
                shared.write("LATE");
                deepStrictEqual(reply, { raw: "", closed: true });
                deepStrictEqual(reasons(captured, unproven), [
                  "the source has its own on()",
                ]);
                ok(!attempted(captured), captured.output());
              },
            );
          });
        }

        test("own `on()` that wraps the end of the pipe, and `removeListener()` that keeps it: the connection is closed, nothing of it ends a reply", async () => {
          const shared = new PassThrough();
          const state = { allow: false, handled: false };
          const on = Reflect.get(EventEmitter.prototype, "on") as IListener;
          const remove = Reflect.get(
            EventEmitter.prototype,
            "removeListener",
          ) as IListener;
          Object.assign(shared, {
            on(this: PassThrough, event: string, listener: IListener) {
              if (event !== "end") {
                return Reflect.apply(on, this, [event, listener]);
              }
              // As the wrapper of a `once()`: its call is suppressed until
              // allowed
              const wrapper = Object.assign(
                function wrapped(this: unknown, ...args: unknown[]): unknown {
                  return state.allow
                    ? Reflect.apply(listener, this, args)
                    : null;
                },
                { listener },
              );
              return Reflect.apply(on, this, [event, wrapper]);
            },
            removeListener(
              this: PassThrough,
              event: string,
              listener: IListener,
            ) {
              return event === "end"
                ? this
                : Reflect.apply(remove, this, [event, listener]);
            },
          });
          await withApp(
            {
              timeout: 20,
              error_handler: async (context: Context, error): Promise<void> => {
                if (isDeadline(error)) {
                  state.handled = true;
                  context.response.status(503);
                  // The end of the shared source, which the wrapper now lets
                  // through to the end of the pipe
                  state.allow = true;
                  shared.emit("end");
                  await context.send("handler");
                }
              },
            },
            (app) => {
              app.use(async ({ response }: Context) => {
                shared.pipe(response);
                response.once("close", () => {
                  // Its end, which the wrapper suppresses, and the state of
                  // a source that has ended
                  shared.emit("end");
                  saysEnded(shared);
                });
                await never();
              });
            },
            async (port, captured) => {
              deepStrictEqual(await exchange(port), { raw: "", closed: true });
              deepStrictEqual(reasons(captured, unproven), [
                "the source has its own on()",
              ]);
              ok(!state.handled);
              ok(!attempted(captured), captured.output());
            },
          );
        });

        test("by a pipe of the stack that fails: the connection is closed instead of the 500", async () => {
          await withApp(
            {},
            (app) => {
              app.use(async ({ response }: Context) => {
                otel(new PassThrough()).pipe(response);
                // Refused (and its work fails): a method of its own other than
                // a listener method
                const refused = new PassThrough();
                Object.defineProperty(refused, "emit", {
                  configurable: true,
                  writable: true,
                  value: Reflect.get(
                    PassThrough.prototype,
                    "emit",
                  ) as IListener,
                });
                refused.pipe(response);
                await never();
              });
            },
            async (port, captured) => {
              deepStrictEqual(await exchange(port), { raw: "", closed: true });
              deepStrictEqual(reasons(captured, unproven), [
                "the source has its own on()",
              ]);
              // Its failure, which nothing replies to
              const record = await captured.waitFor(
                "A pipe into the response has failed once it was destroyed",
              );
              deepStrictEqual(
                [record.level, (record.failure as { type: string }).type],
                [50, "TypeError"],
              );
              ok(!attempted(captured), captured.output());
            },
          );
        });

        test("by a pipe of the error handler that fails (its thrown error): the connection is closed instead of the 500", async () => {
          await withApp(
            {
              error_handler: async (context: Context): Promise<void> => {
                const refused = new PassThrough();
                refused.on("newListener", () => null);
                refused.pipe(context.response);
                await never();
              },
            },
            (app) => {
              app.use(({ response }: Context) => {
                otel(new PassThrough()).pipe(response);
                throw new BindenError(409);
              });
            },
            async (port, captured) => {
              deepStrictEqual(await exchange(port), { raw: "", closed: true });
              deepStrictEqual(reasons(captured, unproven), [
                "the source has its own on()",
              ]);
              await captured.waitFor(
                "The response has been destroyed: nothing replaces the reply",
              );
              ok(!attempted(captured), captured.output());
            },
          );
        });

        test("whose source has ended, and whose class does not unpipe it: the connection is closed", async () => {
          /** A class that keeps its pipes */
          class Kept extends PassThrough {
            public override unpipe(): this {
              return this;
            }
          }
          await withApp(
            { timeout: 30 },
            (app) => {
              app.use(async ({ response }: Context) => {
                const source = otel(new Kept());
                source.end();
                source.pipe(response, { end: false });
                await once(source, "end");
                await never();
              });
            },
            async (port, captured) => {
              deepStrictEqual(await exchange(port), { raw: "", closed: true });
              deepStrictEqual(reasons(captured, unproven), [
                "the source has its own on()",
              ]);
            },
          );
        });

        test("whose source has got an accessor of its own since (e.g. that says it has ended): the connection is closed", async () => {
          await withApp(
            { timeout: 20 },
            (app) => {
              app.use(async ({ response }: Context) => {
                const source = otel(new PassThrough());
                source.pipe(response);
                Object.defineProperty(source, "readableEnded", {
                  configurable: true,
                  get: (): boolean => true,
                });
                await never();
              });
            },
            async (port, captured) => {
              deepStrictEqual(await exchange(port), { raw: "", closed: true });
              deepStrictEqual(reasons(captured, unproven), [
                "the source has its own on()",
              ]);
            },
          );
        });

        test("whose unpipe throws (its own `removeListener()`): logged, and the connection is closed", async () => {
          await withApp(
            { timeout: 20 },
            (app) => {
              app.use(async ({ response }: Context) => {
                const source = otel(new PassThrough());
                source.pipe(response);
                Object.defineProperty(source, "removeListener", {
                  configurable: true,
                  writable: true,
                  value(): never {
                    throw new Error("The cleanup has failed");
                  },
                });
                // Unpiped by the framework only (not by its `close` listener)
                response.removeAllListeners("close");
                await never();
              });
            },
            async (port, captured) => {
              deepStrictEqual(await exchange(port), { raw: "", closed: true });
              await captured.waitFor(
                "The cleanup of a pipe left to Node.js has failed",
              );
            },
          );
        });

        test("a pipe that the revoked stack starts later is refused, not left to Node.js", async () => {
          const source = new PassThrough();
          await withApp(
            { timeout: 20 },
            (app) => {
              app.use(async ({ response }: Context) => {
                await sleep(40);
                otel(source).pipe(response);
                feed(source, ["LATE"]);
              });
            },
            async (port, captured) => {
              const reply = await exchange(port, { ms: 150 });
              deepStrictEqual(replied(reply)[0], 503);
              ok(!reply.raw.includes("LATE"), reply.raw);
              await captured.waitFor("A pipe of an abandoned work has failed");
              deepStrictEqual(reasons(captured, left), []);
            },
          );
        });
      },
    );
  },
);
