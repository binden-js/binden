import {
  Binden,
  BindenResponse,
  type Context,
  type IBindenOptions,
  shutdown,
} from "../index.js";
import { EventEmitter, errorMonitor } from "node:events";
import {
  type ICaptured,
  type IListening,
  capture,
  listen,
  never,
  pollUntil,
  send,
  sleep,
  within,
} from "./helpers.js";
import { deepStrictEqual, ok, throws } from "node:assert/strict";
import { kListen, kOwnership, kUnlisten, owners } from "../src/seal.js";
import { suite, test } from "node:test";
import { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { Socket } from "node:net";

/** A response without a connection: nothing is actually sent */
function detached(): BindenResponse {
  return new BindenResponse(new IncomingMessage(new Socket()));
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

/** The lines of the access log */
function completed(captured: ICaptured): unknown[] {
  return captured.records
    .filter(({ msg }) => msg === "The request has completed")
    .map(({ status }) => status);
}

suite("The observers of the framework on a response", () => {
  test("run after the listeners, once by default, as their work, out of the listener table", () => {
    const response = detached();
    const owner = { name: "a work" };
    const calls: unknown[] = [];
    const record = (name: string) =>
      function recorded(this: unknown, ...args: unknown[]): void {
        calls.push([
          name,
          this === response,
          owners.getStore() ?? null,
          ...args,
        ]);
      };
    owners.run(owner, () => {
      response[kListen]("x", record("once"));
    });
    const always = record("always");
    const dispose = response[kListen]("x", always, { once: false });
    response.on("x", record("listener"));
    ok(response.emit("x", 1));
    deepStrictEqual(calls.splice(0), [
      ["listener", true, null, 1],
      ["once", true, owner, 1],
      ["always", true, null, 1],
    ]);
    // Not in the listener table: the application does not remove them
    deepStrictEqual(response.listenerCount("x"), 1);
    response.removeAllListeners("x");
    response.removeListener("x", always);
    response.removeAllListeners();
    ok(response.emit("x", 2));
    deepStrictEqual(calls.splice(0), [["always", true, null, 2]]);
    dispose();
    // Removed already: nothing
    dispose();
    ok(!response.emit("x", 3));
    deepStrictEqual(calls, []);
  });

  test("are removed by `kUnlisten` (the last one of the listener)", () => {
    const response = detached();
    const calls: string[] = [];
    const observer = (): void => {
      calls.push("observer");
    };
    response[kListen]("y", observer, { once: false });
    response[kListen]("y", observer, { once: false });
    response[kListen]("y", () => {
      calls.push("other");
    });
    response[kUnlisten]("y", observer);
    // Neither an observer of the event, nor of another event
    response[kUnlisten]("y", () => null);
    response[kUnlisten]("z", observer);
    response.emit("y");
    deepStrictEqual(calls.splice(0), ["observer", "other"]);
    response[kUnlisten]("y", observer);
    response.emit("y");
    deepStrictEqual(calls, []);
  });

  test("once each, also when an observer emits its event again", () => {
    const response = detached();
    const calls: string[] = [];
    response[kListen]("w", () => {
      calls.push("first");
      response.emit("w");
    });
    response[kListen]("w", () => {
      calls.push("second");
    });
    response.emit("w");
    response.emit("w");
    deepStrictEqual(calls, ["first", "second"]);
  });

  test("all run when one throws, which is thrown then; a throwing listener is thrown once they have run", () => {
    const response = detached();
    const logged: unknown[] = [];
    response[kOwnership]({
      fail: () => false,
      guards: () => false,
      replier: () => null,
      native: () => false,
      debug: (message, error) => {
        logged.push([message, (error as Error).message]);
      },
      warn: () => null,
      note: () => null,
    });
    const calls: string[] = [];
    const thrown = new Error("An observer has failed");
    response[kListen]("t", () => {
      throw thrown;
    });
    response[kListen]("t", () => {
      calls.push("after");
    });
    throws(
      () => response.emit("t"),
      (error: unknown) => error === thrown,
    );
    deepStrictEqual(calls.splice(0), ["after"]);
    const listener = new Error("A listener has failed");
    response.on("u", () => {
      throw listener;
    });
    response[kListen]("u", () => {
      calls.push("observer");
    });
    response[kListen]("u", () => {
      throw thrown;
    });
    throws(
      () => response.emit("u"),
      (error: unknown) => error === listener,
    );
    deepStrictEqual(calls, ["observer"]);
    deepStrictEqual(logged, [
      ["An observer of the response has failed", "An observer has failed"],
    ]);
  });

  test("an `error` that they observe is not thrown without a listener (as when they were listeners)", () => {
    const response = detached();
    const seen: unknown[] = [];
    response.on(errorMonitor, (error: Error) => {
      seen.push(["monitor", error.message]);
    });
    response[kListen]("error", (error: Error) => {
      seen.push(["observer", error.message]);
    });
    ok(response.emit("error", new Error("first")));
    // Observed once: without a listener, thrown as by Node.js
    throws(() => response.emit("error", new Error("second")), {
      message: "second",
    });
    response.on("error", (error: Error) => {
      seen.push(["listener", error.message]);
    });
    response[kListen]("error", (error: Error) => {
      seen.push(["observer", error.message]);
    });
    ok(response.emit("error", new Error("third")));
    deepStrictEqual(seen, [
      ["monitor", "first"],
      ["observer", "first"],
      ["monitor", "second"],
      ["monitor", "third"],
      ["listener", "third"],
      ["observer", "third"],
    ]);
    // Of every emitter
    ok(response instanceof EventEmitter);
  });

  suite(
    "an `errorMonitor` listener that throws, without an `error` listener",
    () => {
      test("`send()` of a stream still rejects with the error, then the monitor is thrown", async () => {
        const response = detached();
        const source = new Readable({
          read(): void {
            // Pushes nothing
          },
        });
        const sent = response.send(source).then(
          () => "resolved",
          (error: unknown) => (error as Error).message,
        );
        const monitor = new Error("The monitor has failed");
        response.on(errorMonitor, () => {
          throw monitor;
        });
        throws(
          () => response.emit("error", new Error("The send has failed")),
          (error: unknown) => error === monitor,
        );
        deepStrictEqual(await within(sent), "The send has failed");
      });

      test("`flush()` still rejects with the error, then the monitor is thrown", async () => {
        const response = detached();
        const flushed = response.flush().then(
          () => "resolved",
          (error: unknown) => (error as Error).message,
        );
        const monitor = new Error("The monitor has failed");
        response.on(errorMonitor, () => {
          throw monitor;
        });
        throws(
          () => response.emit("error", new Error("The flush has failed")),
          (error: unknown) => error === monitor,
        );
        deepStrictEqual(await within(flushed), "The flush has failed");
      });

      test("an observer that fails as well is logged: the monitor is thrown", () => {
        const response = detached();
        const logged: unknown[] = [];
        response[kOwnership]({
          fail: () => false,
          guards: () => false,
          replier: () => null,
          native: () => false,
          debug: (message, error) => {
            logged.push([message, (error as Error).message]);
          },
          warn: () => null,
          note: () => null,
        });
        response[kListen]("error", () => {
          throw new Error("An observer has failed");
        });
        const monitor = new Error("The monitor has failed");
        response.on(errorMonitor, () => {
          throw monitor;
        });
        throws(
          () => response.emit("error", new Error("An error")),
          (error: unknown) => error === monitor,
        );
        deepStrictEqual(logged, [
          ["An observer of the response has failed", "An observer has failed"],
        ]);
      });

      test("without an observer, the error is thrown as by Node.js", () => {
        const response = detached();
        const seen: unknown[] = [];
        response.on(errorMonitor, (error: Error) => {
          seen.push(error.message);
        });
        throws(() => response.emit("error", new Error("unhandled")), {
          message: "unhandled",
        });
        deepStrictEqual(seen, ["unhandled"]);
      });
    },
  );

  for (const removed of ["close", "every event"]) {
    test(`the application removes the listeners of ${removed}: the cleanups, the access log and the shutdown still run`, async () => {
      const cleaned = Promise.withResolvers<unknown>();
      await withApp(
        { access_log: true },
        (app) => {
          app.use(async (context: Context) => {
            context.onCleanup(() => {
              cleaned.resolve(null);
            });
            const { response } = context;
            response.on("close", () => null);
            if (removed === "close") {
              response.removeAllListeners("close");
            } else {
              // Also those of Node.js: its `close` comes once the client has
              // closed the connection (as without binden)
              response.removeAllListeners();
            }
            await context.text("ok");
          });
        },
        async ({ port, server }, captured) => {
          const reply = await send(port);
          deepStrictEqual([reply.status, reply.body], [200, "ok"]);
          await within(cleaned.promise);
          await captured.waitFor("The request has completed");
          deepStrictEqual(completed(captured), [200]);
          // Its exchange is no longer waited for
          await within(shutdown(server, { timeout: 50, cleanup_timeout: 50 }));
        },
      );
    });
  }

  test("the application removes the listeners of `finish`: a send still settles", async () => {
    const outcome = Promise.withResolvers<unknown>();
    await withApp(
      {},
      (app) => {
        app.use(async (context: Context) => {
          const sent = context.response.send("sent");
          context.response.removeAllListeners("finish");
          await sent.then(
            () => {
              outcome.resolve("resolved");
            },
            (error: unknown) => {
              outcome.resolve((error as { code?: string }).code);
            },
          );
          await never();
        });
      },
      async ({ port }) => {
        const reply = await send(port);
        deepStrictEqual([reply.status, reply.body], [200, "sent"]);
        deepStrictEqual(await within(outcome.promise), "resolved");
      },
    );
  });

  test("the application removes the listeners of `drain`: a stream is still sent with backpressure", async () => {
    const size = 64 * 1024;
    const count = 64;
    await withApp(
      {},
      (app) => {
        app.use(async (context: Context) => {
          const timer = setInterval(() => {
            context.response.removeAllListeners("drain");
          }, 1);
          // Also when the send never settles: once the connection closes
          context.response.once("close", () => {
            clearInterval(timer);
          });
          try {
            await context.send(
              Readable.from(
                Array.from({ length: count }, () => Buffer.alloc(size, "a")),
              ),
            );
          } finally {
            clearInterval(timer);
          }
        });
      },
      async ({ port }) => {
        const reply = await send(port, { ms: 10_000 });
        deepStrictEqual([reply.status, reply.body.length], [200, size * count]);
      },
    );
  });

  test("an `emit()` wrapped by a middleware (an instrumentation): they run once", async () => {
    let cleaned = 0;
    await withApp(
      { access_log: true },
      (app) => {
        app.use(async (context: Context) => {
          const { response } = context;
          const emit = Reflect.get(response, "emit") as (
            ...args: unknown[]
          ) => boolean;
          response.emit = function wrapper(
            this: BindenResponse,
            ...args: unknown[]
          ): boolean {
            return Reflect.apply(emit, this, args);
          } as never;
          context.onCleanup(() => {
            cleaned += 1;
          });
          await context.text("ok");
        });
      },
      async ({ port }, captured) => {
        const reply = await send(port);
        deepStrictEqual([reply.status, reply.body], [200, "ok"]);
        await captured.waitFor("The request has completed");
        await sleep(20);
        deepStrictEqual([cleaned, completed(captured)], [1, [200]]);
      },
    );
  });

  test("a settled `flush()` or send leaves no observer: an `error` without a listener is thrown", async () => {
    const thrown: unknown[] = [];
    await withApp(
      {},
      (app) => {
        app.use(async (context: Context) => {
          const { response } = context;
          const check = (): void => {
            try {
              response.emit("error", new Error("Unobserved"));
              thrown.push(null);
            } catch (error: unknown) {
              thrown.push((error as Error).message);
            }
          };
          await response.flush();
          check();
          await response.send("sent");
          check();
        });
      },
      async ({ port }) => {
        const reply = await send(port);
        deepStrictEqual([reply.status, reply.body], [200, "sent"]);
        deepStrictEqual(thrown, ["Unobserved", "Unobserved"]);
      },
    );
  });

  test("an abandoned work sees its response closed early: they run at the real close only", async () => {
    const events: string[] = [];
    await withApp(
      {
        timeout: 20,
        error_handler: async (context: Context): Promise<void> => {
          await sleep(20);
          events.push("reply");
          await context.status(503).send("deadline");
        },
      },
      (app) => {
        app.use(async (context: Context) => {
          context.response.on("close", () => {
            events.push("early close");
          });
          context.onCleanup(() => {
            events.push("cleanup");
          });
          await never();
        });
      },
      async ({ port }) => {
        const reply = await send(port);
        deepStrictEqual([reply.status, reply.body], [503, "deadline"]);
        await pollUntil(() => events.length >= 3).catch(() => null);
        deepStrictEqual(events, ["early close", "reply", "cleanup"]);
      },
    );
  });
});
