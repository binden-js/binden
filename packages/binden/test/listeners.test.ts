import {
  Binden,
  BindenError,
  BindenResponse,
  type Context,
  type IBindenOptions,
} from "../index.js";
import {
  EventEmitter,
  once as eventOnce,
  getEventListeners,
} from "node:events";
import {
  type IListening,
  listen,
  never,
  send,
  sleep,
  within,
} from "./helpers.js";
import { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough, Readable } from "node:stream";
import { deepStrictEqual, ok, throws } from "node:assert/strict";
import { kFramework, kSeal, owners } from "../src/seal.js";
import { onPipeFailure, openWindow } from "../src/listeners.js";
import { suite, test } from "node:test";
import { Exchange } from "../src/exchange.js";
import { Socket } from "node:net";
import { listen as listenHttp } from "./http.js";

/** A response without a connection: nothing is actually sent */
function detached(): BindenResponse {
  return new BindenResponse(new IncomingMessage(new Socket()));
}

/** Runs `fn` with a listening application */
async function withApp(
  options: IBindenOptions,
  setup: (app: Binden) => void,
  fn: (listening: IListening) => Promise<void>,
): Promise<void> {
  const app = new Binden(options);
  setup(app);
  const listening = await listen(app);
  try {
    await fn(listening);
  } finally {
    await listening.close();
  }
}

/** A promise with its `resolve()` */
function gate(): { promise: Promise<void>; open(): void } {
  const { promise, resolve } = Promise.withResolvers<never>();
  return { promise, open: resolve as () => void };
}

/** Whether the error is the `503` of a deadline */
function isDeadline(error: unknown): boolean {
  return error instanceof BindenError && error.code === "deadline";
}

suite("Listeners and callbacks of the response", () => {
  test("keep the semantics of Node.js", () => {
    const response = detached();
    const calls: unknown[][] = [];
    const record = (name: string) =>
      function recorded(this: unknown, ...args: unknown[]): void {
        calls.push([name, this === response, ...args]);
      };
    const a = record("a");
    const b = record("b");
    const c = record("c");
    const added: unknown[] = [];
    response.on("newListener", (event: string, listener: unknown) => {
      if (event === "x") {
        added.push(listener);
      }
    });
    response.on("x", a).addListener("x", b).prependListener("x", c);
    deepStrictEqual(response.listeners("x"), [c, a, b]);
    deepStrictEqual(added, [a, b, c]);
    // As Node.js: the listeners themselves (not their binding)
    deepStrictEqual(response.rawListeners("x"), [c, a, b]);
    response.emit("x", 1, 2);
    deepStrictEqual(calls.splice(0), [
      ["c", true, 1, 2],
      ["a", true, 1, 2],
      ["b", true, 1, 2],
    ]);
    response.off("x", a).removeListener("x", c);
    deepStrictEqual(response.listeners("x"), [b]);
    response.removeAllListeners("x");
    deepStrictEqual(response.listenerCount("x"), 0);

    // Once each, also when its event is emitted again while it runs
    function once(this: unknown, ...args: unknown[]): void {
      calls.push(["once", this === response, ...args]);
      response.emit("y", "again");
    }
    response.once("y", once).prependOnceListener("y", c);
    deepStrictEqual(response.listeners("y"), [c, once]);
    response.emit("y", 3);
    response.emit("y", 4);
    deepStrictEqual(calls.splice(0), [
      ["c", true, 3],
      ["once", true, 3],
    ]);
    deepStrictEqual(response.listenerCount("y"), 0);
    // Once, also when an earlier listener emits its event again
    let depth = 0;
    response.prependListener("w", () => {
      depth += 1;
      if (depth === 1) {
        response.emit("w", "nested");
      }
    });
    response.once("w", a);
    response.emit("w", "outer");
    deepStrictEqual(calls.splice(0), [["a", true, "nested"]]);
    // Removed before it runs
    response.once("z", a);
    response.removeListener("z", a);
    response.emit("z");
    deepStrictEqual(calls, []);
    // A listener that throws, or one that is not a function
    response.on("throws", () => {
      throw new Error("Thrown");
    });
    throws(() => response.emit("throws"), new Error("Thrown"));
    throws(() => response.on("x", null as never), {
      code: "ERR_INVALID_ARG_TYPE",
    });
  });

  test("run as the work that has added them, without the rights of the framework", () => {
    const response = detached();
    const owner = { name: "owner" };
    const other = { name: "other" };
    const seen: unknown[] = [];
    const listener = (): void => {
      seen.push(owners.getStore());
      response.setHeader("X-Listener", "1");
    };
    owners.run(owner, () => {
      response.on("x", listener).once("y", listener);
    });
    response.on("z", listener);
    // Sealed: only the work of `owner` may change it
    response[kSeal]((current) => current === owner);
    owners.run(other, () => {
      response[kFramework](() => {
        response.emit("x");
        response.emit("y");
        response.emit("z");
      });
    });
    deepStrictEqual(
      seen.map((store) => store ?? null),
      [owner, owner, null],
    );
    // The listeners of `owner` have set it, not the one of the other work
    deepStrictEqual(response.getHeader("X-Listener"), "1");
    owners.run(owner, () => {
      response.removeHeader("X-Listener");
    });
    owners.run(other, () => {
      response[kFramework](() => response.emit("z"));
    });
    ok(!response.hasHeader("X-Listener"));
  });

  test("its methods may be wrapped on a response, as those of Node.js (e.g. by an instrumentation)", () => {
    const names = [
      "on",
      "addListener",
      "once",
      "prependListener",
      "prependOnceListener",
      "emit",
      "rawListeners",
    ] as const;
    const owner = { name: "owner" };
    const seen: unknown[] = [];
    for (const response of [
      detached(),
      new ServerResponse(new IncomingMessage(new Socket())),
    ]) {
      const wrapped: string[] = [];
      for (const name of names) {
        const original = Reflect.get(response, name) as (
          ...args: unknown[]
        ) => unknown;
        // An assignment in strict code (a module): it throws when refused
        response[name] = function wrapper(
          this: ServerResponse,
          ...args: unknown[]
        ): unknown {
          wrapped.push(name);
          return Reflect.apply(original, this, args);
        } as never;
        ok(Object.hasOwn(response, name));
      }
      owners.run(owner, () => {
        response.on("x", () => {
          seen.push(owners.getStore() ?? null);
        });
      });
      response.emit("x");
      deepStrictEqual(response.rawListeners("x").length, 1);
      deepStrictEqual(wrapped, ["on", "emit", "rawListeners"]);
    }
    // Still bound to its adder by the method of the response
    deepStrictEqual(seen, [owner, null]);
  });

  test("the failure of a pipe goes to the handler that the exchange of its work has set first", () => {
    const token = { name: "token" };
    const other = { name: "a work of no exchange" };
    let issued = true;
    let later = false;
    const issuer = {
      issued: (candidate: object): boolean =>
        (candidate === token && issued) || (candidate === other && later),
    };
    const calls: unknown[] = [];
    onPipeFailure(token, issuer, (error, source) => {
      calls.push([error, source]);
      return true;
    });
    // Set once: never replaced
    onPipeFailure(token, issuer, () => {
      calls.push("replaced");
      return true;
    });
    // Not issued by the exchange (yet): not set
    onPipeFailure(other, issuer, () => {
      calls.push("other");
      return true;
    });
    const thrown = new Error("Thrown");
    const fails = (): never => {
      throw thrown;
    };
    /** Emits the `end` of a source to a listener added by a work in its window */
    const end = (owner: object): unknown => {
      const source = new PassThrough();
      ok(openWindow(source));
      owners.run(owner, () => {
        source.once("end", fails);
      });
      try {
        source.emit("end");
        return source;
      } catch (error: unknown) {
        return error;
      }
    };
    const source = end(token);
    deepStrictEqual(calls, [[thrown, source]]);
    later = true;
    ok(end(other) === thrown);
    // Its exchange no longer knows the token: thrown
    issued = false;
    ok(end(token) === thrown);
    deepStrictEqual(calls.length, 1);
  });

  test("the failure of a pipe of a work whose exchange has no framework is thrown", () => {
    const response = detached();
    const token = Exchange.for(response.req, response).token();
    const source = new PassThrough();
    ok(openWindow(source));
    const thrown = new Error("Thrown");
    owners.run(token, () => {
      source.once("end", () => {
        throw thrown;
      });
    });
    throws(
      () => source.emit("end"),
      (error: unknown) => error === thrown,
    );
  });

  test("the callback of a write runs as the work that has written", () => {
    const response = detached();
    const owner = { name: "owner" };
    const seen: unknown[] = [];
    owners.run(owner, () => {
      response.write("chunk", () => {
        seen.push(owners.getStore());
      });
    });
    // Queued until the response has a socket: called later, as whoever
    // flushes it then
    const { outputData } = response as unknown as {
      outputData: { callback(): void }[];
    };
    deepStrictEqual(outputData.length, 1);
    owners.run({ name: "other" }, () => {
      response[kFramework](() => {
        outputData[0]?.callback();
      });
    });
    deepStrictEqual(seen, [owner]);
  });

  test("a `drain` listener of the abandoned work cannot end the reply", async () => {
    await withApp(
      {
        timeout: 20,
        error_handler: async (context: Context): Promise<void> => {
          await sleep(40);
          // As a compression that emits the `drain` of its compressor
          context.response.emit("drain");
          await context.status(503).send("handler");
        },
      },
      (app) => {
        app.use(async (context: Context) => {
          context.response.once("drain", () => {
            context.response.end("OLD");
          });
          await never();
        });
      },
      async ({ port }) => {
        const reply = await send(port);
        deepStrictEqual([reply.status, reply.body], [503, "handler"]);
      },
    );
  });
});

suite("A stream piped into the response", () => {
  test("writes as the work that has piped it, whatever work feeds it", async () => {
    const source = new PassThrough();
    await withApp(
      {
        timeout: 20,
        error_handler: async (context: Context, error): Promise<void> => {
          if (!isDeadline(error)) {
            return;
          }
          context.response.status(503).setHeader("Content-Type", "text/plain");
          source.pipe(context.response);
          await new Promise<void>((resolve) => {
            context.response.once("finish", resolve);
          });
        },
      },
      (app) => {
        app.use(async (context: Context) => {
          // Fed by a timer of the abandoned work (once the deadline has
          // passed), which also writes itself
          await sleep(40);
          const timer = setInterval(() => {
            context.response.write("OLD");
            source.write("abc");
          }, 10);
          setTimeout(() => {
            clearInterval(timer);
            context.response.end("OLD");
            source.end("end");
          }, 50);
          await never();
        });
      },
      async ({ port }) => {
        const reply = await send(port);
        deepStrictEqual(reply.status, 503);
        ok(/^(?:abc)+end$/u.test(reply.body), reply.body);
      },
    );
  });

  test("piped by the abandoned work, writes nothing, whatever work feeds it", async () => {
    const source = new PassThrough();
    const piped = gate();
    await withApp(
      {
        timeout: 20,
        error_handler: async (context: Context): Promise<void> => {
          await piped.promise;
          // Fed by the work that replies
          source.write("OLD");
          source.end("OLD");
          await sleep(20);
          await context.status(503).send("handler");
        },
      },
      (app) => {
        app.use(async (context: Context) => {
          await sleep(40);
          source.pipe(context.response);
          piped.open();
          await never();
        });
      },
      async ({ port }) => {
        const reply = await send(port);
        deepStrictEqual([reply.status, reply.body], [503, "handler"]);
      },
    );
  });

  test("its listeners are those of Node.js", async () => {
    const response = detached();
    const source = Readable.from(["a"]);
    source.pipe(response);
    // The listeners that the pipe has added, adopted
    deepStrictEqual(source.listenerCount("data"), 1);
    deepStrictEqual(source.listenerCount("end"), 1);
    source.unpipe(response);
    deepStrictEqual(source.listenerCount("data"), 0);
    deepStrictEqual(source.listenerCount("end"), 0);
    // Of a source that has ended: its end is already scheduled
    const ended = new PassThrough();
    ended.end();
    ended.resume();
    await new Promise((resolve) => {
      ended.once("end", resolve);
    });
    ended.pipe(detached());
    deepStrictEqual(ended.listenerCount("data"), 1);
    // Not a stream (e.g. emitted by the application)
    response.emit("pipe", null);
    response.emit("pipe", new EventEmitter());
    ok(response.started);
  });
});

/** A listener that records its calls */
type IRecorded = (this: unknown, ...args: unknown[]) => void;

/**
 * What a sequence of operations on the listeners of a response does (the
 * one of R1's review), by identity: its listeners by name, a wrapper of one
 * as `wrapper(name)`, and the receiver of each call
 */
async function scenario(response: ServerResponse): Promise<unknown[]> {
  const out: unknown[] = [];
  const other = new EventEmitter();
  const names = new Map<unknown, string>();
  const receiver = (self: unknown): string => {
    if (self === response) {
      return "response";
    }
    return self === other ? "other" : typeof self;
  };
  const record = (name: string): IRecorded => {
    function recorded(this: unknown, ...args: unknown[]): void {
      out.push([name, receiver(this), ...args]);
    }
    names.set(recorded, name);
    return recorded;
  };
  const id = (fn: unknown): string => {
    const name = names.get(fn);
    if (typeof name !== "undefined") {
      return name;
    }
    const inner = (fn as { listener?: unknown }).listener;
    return names.has(inner) ? `wrapper(${String(names.get(inner))})` : "other";
  };
  const a = record("a");
  const b = record("b");
  const c = record("c");
  response.on("removeListener", (event: unknown, listener: unknown) => {
    if (typeof event === "string" && event.startsWith("t")) {
      out.push(["removeListener", event, id(listener)]);
    }
  });
  response.on("newListener", (event: unknown, listener: unknown) => {
    if (typeof event === "string" && event.startsWith("t")) {
      out.push(["newListener", event, id(listener)]);
    }
  });
  out.push([
    "returns",
    response.on("t1", a) === response,
    response.once("t1", b) === response,
    response.prependOnceListener("t1", c) === response,
  ]);
  out.push(["listeners", response.listeners("t1").map(id)]);
  out.push(["raw", response.rawListeners("t1").map(id)]);
  out.push([
    "count",
    response.listenerCount("t1"),
    response.listenerCount("t1", a),
    response.listenerCount("t1", b),
  ]);
  out.push(["emit", response.emit("t1", 1), response.emit("t1", 2)]);
  // The same listener twice, removed once (the last added)
  response.on("t2", a).once("t2", a).removeListener("t2", a);
  out.push(["t2", response.rawListeners("t2").map(id)]);
  response.emit("t2", "x");
  // The wrapper of a `once()` called directly runs once, removed
  response.once("t3", b);
  (response.rawListeners("t3")[0] as IRecorded)("direct");
  out.push(["t3", response.listenerCount("t3")]);
  response.emit("t3", "no");
  // A raw listener added to another emitter (e.g. by a proxy)
  response.on("t4", a).prependListener("t4", c).once("t4", b);
  for (const raw of response.rawListeners("t4") as IRecorded[]) {
    other.on("t4", raw);
  }
  other.emit("t4", "copied");
  out.push(["t4", other.listenerCount("t4"), response.listenerCount("t4")]);
  response.on("t5", a).once("t5", b).removeAllListeners("t5");
  out.push(["t5", response.listenerCount("t5")]);
  setImmediate(() => response.emit("t6", "v6"));
  out.push(["events.once", await eventOnce(response, "t6")]);
  out.push(["getEventListeners", getEventListeners(response, "t1").map(id)]);
  // A listener that throws: the next ones do not run
  response.on("t8", () => {
    throw new Error("Thrown");
  });
  response.on("t8", a);
  try {
    response.emit("t8");
  } catch (error: unknown) {
    out.push(["t8", (error as Error).message]);
  }
  // Removed while the event is emitted (Node.js emits to a copy)
  const removed = record("removed");
  response.on("t10", (): void => {
    response.removeListener("t10", removed);
  });
  response.once("t10", removed);
  response.emit("t10", "r1");
  response.emit("t10", "r2");
  // A wrapper of `once()` that adds itself again
  let count = 0;
  const again = (): void => {
    count += 1;
    out.push(["again", count]);
    if (count < 3) {
      response.once("t11", again);
    }
  };
  names.set(again, "again");
  response.once("t11", again);
  for (let index = 0; index < 4; index += 1) {
    response.emit("t11");
  }
  // Removed by the listener itself, once added by `prependOnceListener()`
  response.prependOnceListener("t14", a).off("t14", a);
  out.push(["t14", response.emit("t14")]);
  return out;
}

suite("Listeners and callbacks compared with a native response", () => {
  test("their identities, receivers and events are those of Node.js", async () => {
    const native = await scenario(
      new ServerResponse(new IncomingMessage(new Socket())),
    );
    const binden = await scenario(detached());
    deepStrictEqual(binden, native);
    // The scenario covers the wrappers of `once()`
    ok(JSON.stringify(native).includes("wrapper(b)"));
  });

  test("the callbacks of `write()` and `end()` get the receiver that Node.js gives them", async () => {
    const receivers = async (
      Response: typeof BindenResponse,
    ): Promise<string[]> => {
      const server = await listenHttp({ Response, plain: true });
      try {
        const seen: string[] = [];
        const handled = server.handle(
          (request, response) =>
            new Promise<void>((resolve) => {
              const kind = (self: unknown): string => {
                if (self === response) {
                  return "response";
                } else if (self === request.socket) {
                  return "socket";
                }
                return typeof self === "undefined"
                  ? "undefined"
                  : `other ${Object.prototype.toString.call(self)}`;
              };
              function written(this: unknown): void {
                seen.push(`write ${kind(this)}`);
              }
              function encoded(this: unknown): void {
                seen.push(`write(encoding) ${kind(this)}`);
              }
              function ended(this: unknown): void {
                seen.push(`end ${kind(this)}`);
                resolve();
              }
              response.write("a", written);
              response.write("b", "latin1", encoded);
              response.end("c", ended);
            }),
        );
        await server.request();
        await handled;
        return seen.sort();
      } finally {
        await server.close();
      }
    };
    const native = await receivers(ServerResponse as typeof BindenResponse);
    deepStrictEqual(await receivers(BindenResponse), native);
    deepStrictEqual(native.length, 3);
  });

  test("a listener added to a piped source gets the source, as with Node.js", async () => {
    const receiverOf = async (response: ServerResponse): Promise<boolean> => {
      const source = new PassThrough();
      const { promise, resolve } = Promise.withResolvers<boolean>();
      function received(this: unknown): void {
        resolve(this === source);
      }
      response.prependListener("pipe", (piped: EventEmitter) => {
        piped.on("data", received);
      });
      source.pipe(response);
      source.write("x");
      return within(promise);
    };
    deepStrictEqual(
      [
        await receiverOf(new ServerResponse(new IncomingMessage(new Socket()))),
        await receiverOf(detached()),
      ],
      [true, true],
    );
  });
});
