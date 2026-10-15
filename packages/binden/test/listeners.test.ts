import {
  Binden,
  BindenError,
  BindenResponse,
  type Context,
  type IBindenOptions,
} from "../index.js";
import { type IListening, listen, never, send, sleep } from "./helpers.js";
import { PassThrough, Readable } from "node:stream";
import { deepStrictEqual, ok, throws } from "node:assert/strict";
import { kFramework, kSeal, owners } from "../src/seal.js";
import { suite, test } from "node:test";
import { EventEmitter } from "node:events";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";

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
    ok(
      response
        .rawListeners("x")
        .every((raw, index) => raw !== [c, a, b][index]),
    );
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
