import { Binden, BindenError, type Context, ct_json, ct_text } from "binden";
import { type IServer, Recorder, listen, within } from "./helpers.js";
import { type IncomingMessage, request } from "node:http";
import { deepStrictEqual, ok } from "node:assert/strict";
import { suite, test } from "node:test";
import { BodyParser } from "../index.js";
import { once } from "node:events";

/** An error of the application's own (e.g. of a getter, or of a method) */
class OwnError extends Error {}

/** How a parse has settled: its error, and whether it was formatted once `run()` rejected */
type ISettled =
  | { readonly error: unknown; readonly formatted: boolean }
  | { readonly ok: true };

/** The getters that replace properties of a proxy (see `ducked()`) */
type IReplaced = Readonly<Record<string, () => unknown>>;

/**
 * A proxy that only looks like `target`: it reads the properties of the
 * target (its methods bound to it) and sets them on it, but for the getters
 * of `replaced`, which may succeed first and throw later
 */
function ducked<T extends object>(target: T, replaced: IReplaced): T {
  return new Proxy(target, {
    get(object, key): unknown {
      if (typeof key === "string" && Object.hasOwn(replaced, key)) {
        return replaced[key]();
      }
      const value: unknown = Reflect.get(object, key, object);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(object)
        : value;
    },
    set(object, key, value): boolean {
      return Reflect.set(object, key, value, object);
    },
  });
}

/**
 * A proxy of `target` (and of each object that it gives, e.g. the request of
 * a context) whose every use throws an error of its own (kept in `errors`)
 * once `armed()` is true: its methods are bound to their objects
 */
function deep<T extends object>(
  target: T,
  errors: OwnError[],
  armed: () => boolean,
): T {
  const proxies = new WeakMap<object, object>();
  const fail = (): never => {
    const error = new OwnError("A late use of the context");
    errors.push(error);
    throw error;
  };
  const handler: ProxyHandler<object> = {
    get(object, key): unknown {
      if (armed()) {
        return fail();
      }
      const value: unknown = Reflect.get(object, key, object);
      if (typeof value === "function") {
        return (value as (...args: unknown[]) => unknown).bind(object);
      } else if (typeof value !== "object" || value === null) {
        return value;
      }
      const proxy = proxies.get(value) ?? new Proxy(value, handler);
      proxies.set(value, proxy);
      return proxy;
    },
    set(object, key, value): boolean {
      return armed() ? fail() : Reflect.set(object, key, value, object);
    },
  };
  return new Proxy(target, handler) as T;
}

/**
 * A function (a getter, or a method) that throws a new error of its own,
 * kept in `errors`, from its call `from` on
 */
function failing(errors: OwnError[], name: string, from = 1): () => unknown {
  let calls = 0;
  return (): unknown => {
    calls += 1;
    if (calls >= from) {
      const error = new OwnError(`${name} of the context`);
      errors.push(error);
      throw error;
    }
    return null;
  };
}

/** The getter of a method (see `ducked()`) */
function method(call: () => unknown): () => unknown {
  return () => call;
}

/**
 * Serves a parser that runs on a context that only looks like the one of the
 * request (made by `duck`): how it settles, while `Error.prepareStackTrace`
 * records the errors whose stacks V8 formats. With `early`, the reply is sent
 * first (the parse is not awaited).
 */
async function serveDucked(
  parser: BodyParser,
  duck: (context: Context) => Context,
  early = false,
): Promise<{
  server: IServer;
  started: Promise<Context>;
  settled: Promise<ISettled>;
  restore(): void;
}> {
  const formatted = new WeakSet<object>();
  const previous: unknown = Reflect.get(Error, "prepareStackTrace");
  Reflect.set(Error, "prepareStackTrace", (error: Error): string => {
    formatted.add(error);
    return `${error.name}: ${error.message}`;
  });
  const { promise: started, resolve: start } = Promise.withResolvers<Context>();
  const { promise: settled, resolve: settle } =
    Promise.withResolvers<ISettled>();
  const run = (context: Context): Promise<void> =>
    parser.run(duck(context)).then(
      () => {
        settle({ ok: true });
      },
      (error: unknown) => {
        settle({ error, formatted: formatted.has(error as object) });
        throw error;
      },
    );
  const server = await listen(
    new Binden({ logger: new Recorder() }).use(async (context: Context) => {
      start(context);
      if (early) {
        run(context).catch(() => {
          // Settled above
        });
        await context.send("early");
      } else {
        await run(context);
        await context.send("parsed");
      }
    }),
  );
  return {
    server,
    started,
    settled,
    restore: (): void => {
      Reflect.set(Error, "prepareStackTrace", previous);
    },
  };
}

/** Sends the headers and the first chunk of a body, without ending it */
function upload(
  server: IServer,
  headers: Record<string, number | string>,
  chunk: string,
): { req: ReturnType<typeof request>; response: Promise<IncomingMessage> } {
  const req = request({
    host: "127.0.0.1",
    port: server.port,
    method: "POST",
    agent: false,
    headers,
  });
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    req.once("response", resolve).once("error", reject);
  });
  // Observed by the tests that expect it
  response.catch(() => {
    // The request may be aborted on purpose
  });
  req.on("error", () => {
    // The server may close the connection before the body is sent
  });
  req.write(chunk);
  return { req, response };
}

/** The status of the reply to a request */
async function status(response: Promise<IncomingMessage>): Promise<number> {
  const received = await within(response);
  received.resume();
  await within(once(received, "end"));
  return received.statusCode ?? 0;
}

suite("BodyParser (late calls of a context)", () => {
  test("a context whose getters throw from their second read: each is read once", async () => {
    for (const [parser, headers, chunks, expected] of [
      [new BodyParser(), { "Content-Type": ct_json }, ['{"a":', "1}"], 200],
      // Refused before the body is read, and while it is read
      [
        new BodyParser({ limit: 4 }),
        { "Content-Type": ct_text, "Content-Length": 10 },
        ["abcdefghij"],
        413,
      ],
      [
        new BodyParser({ limit: 4 }),
        { "Content-Type": ct_text },
        ["ab", "cdefgh"],
        413,
      ],
    ] as const) {
      const reads = new Map<string, number>();
      const served = await serveDucked(parser, (context) => {
        const replaced = Object.fromEntries(
          ["request", "response", "signal", "log", "setHeader"].map((key) => [
            key,
            (): unknown => {
              const count = (reads.get(key) ?? 0) + 1;
              reads.set(key, count);
              if (count > 1) {
                throw new OwnError(`${key} read again`);
              }
              const value: unknown = Reflect.get(context, key, context);
              return typeof value === "function"
                ? (value as () => unknown).bind(context)
                : value;
            },
          ]),
        );
        return ducked(context, replaced);
      });
      try {
        const { req, response } = upload(served.server, headers, chunks[0]);
        const context = await within(served.started);
        req.end(chunks[1]);
        deepStrictEqual(await status(response), expected);
        const settled = await within(served.settled);
        if (expected === 200) {
          deepStrictEqual(settled, { ok: true });
          deepStrictEqual(context.request.body, { a: 1 });
        } else {
          ok("error" in settled && settled.error instanceof BindenError);
          deepStrictEqual(settled.error.status, 413);
        }
        ok([...reads.values()].every((count) => count === 1));
      } finally {
        served.restore();
        await served.server.close();
      }
    }
  });

  test("a context whose every use throws once run() has returned (also of its request, response, signal and logger): the first error is the rejection, formatted, never an uncaught one", async () => {
    const errors: OwnError[] = [];
    let armed = false;
    const served = await serveDucked(
      new BodyParser({ limit: 4 }),
      (context) => {
        setImmediate(() => {
          armed = true;
        });
        return deep(context, errors, () => armed);
      },
    );
    try {
      const { req, response } = upload(
        served.server,
        { "Content-Type": ct_text },
        "ab",
      );
      await within(served.started);
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      req.write("cdefgh");
      const settled = await within(served.settled);
      ok(errors.length > 0);
      deepStrictEqual(settled, { error: errors[0], formatted: true });
      req.end();
      deepStrictEqual(await status(response), 500);
    } finally {
      served.restore();
      await served.server.close();
    }
  });

  test("a response whose setHeader() throws once a chunked body is over the limit: its error is the rejection, formatted, and the request is unpiped", async () => {
    const errors: OwnError[] = [];
    let listeners = 0;
    const served = await serveDucked(
      new BodyParser({ limit: 4 }),
      (context) => {
        listeners = context.request.socket.listenerCount("close");
        return ducked(context, {
          response: () =>
            ducked(context.response, {
              setHeader: method(failing(errors, "setHeader")),
            }),
        });
      },
    );
    try {
      const { req, response } = upload(
        served.server,
        { "Content-Type": ct_text },
        "ab",
      );
      const context = await within(served.started);
      const { socket } = context.request;
      req.write("cdefgh");
      const settled = await within(served.settled);
      deepStrictEqual(settled, { error: errors[0], formatted: true });
      deepStrictEqual(
        [context.request.readableFlowing, socket.listenerCount("close")],
        [false, listeners],
      );
      req.end();
      deepStrictEqual(await status(response), 500);
    } finally {
      served.restore();
      await served.server.close();
    }
  });

  test("a signal whose reason throws once it is aborted, then a setHeader() that throws: the first failure is the rejection", async () => {
    const errors: OwnError[] = [];
    const controller = new AbortController();
    const served = await serveDucked(new BodyParser(), (context) =>
      ducked(context, {
        signal: () =>
          ducked(controller.signal, { reason: failing(errors, "reason") }),
        response: () =>
          ducked(context.response, {
            setHeader: method(failing(errors, "setHeader")),
          }),
      }),
    );
    try {
      const { req, response } = upload(
        served.server,
        { "Content-Type": ct_text, "Content-Length": 10 },
        "ab",
      );
      await within(served.started);
      controller.abort();
      const settled = await within(served.settled);
      deepStrictEqual(
        [settled, errors.map(({ message }) => message)],
        [
          { error: errors[0], formatted: true },
          ["reason of the context", "setHeader of the context"],
        ],
      );
      req.end("cdefghij");
      deepStrictEqual(await status(response), 500);
    } finally {
      served.restore();
      await served.server.close();
    }
  });

  test("a cleanup that throws once the body is read (e.g. a signal whose removeEventListener() throws), also the one of `verify`: the rejection", async () => {
    for (const from of [1, 2]) {
      const errors: OwnError[] = [];
      const controller = new AbortController();
      let verified = 0;
      const verify = (): void => {
        verified += 1;
      };
      const served = await serveDucked(
        new BodyParser(from === 1 ? {} : { verify }),
        (context) =>
          ducked(context, {
            signal: () =>
              ducked(controller.signal, {
                removeEventListener: method(
                  failing(errors, "removeEventListener", from),
                ),
              }),
          }),
      );
      try {
        const { req, response } = upload(
          served.server,
          { "Content-Type": ct_text },
          "ab",
        );
        const context = await within(served.started);
        req.end("cd");
        const settled = await within(served.settled);
        deepStrictEqual(
          [settled, verified, typeof context.request.body],
          [{ error: errors[0], formatted: true }, from - 1, "undefined"],
        );
        deepStrictEqual(await status(response), 500);
      } finally {
        served.restore();
        await served.server.close();
      }
    }
  });

  test("a logger that throws once the body is read (e.g. as `verify` refuses it): the rejection, formatted", async () => {
    const errors: OwnError[] = [];
    const debug = failing(errors, "debug");
    const logger = {
      fatal: (): null => null,
      error: (): null => null,
      warn: (): null => null,
      info: (): null => null,
      debug,
      trace: (): null => null,
      child: (): unknown => logger,
    };
    const served = await serveDucked(
      new BodyParser({
        verify: (): never => {
          throw new BindenError(401);
        },
      }),
      (context) =>
        ducked(context, {
          log: () => logger,
        }),
    );
    try {
      const { req, response } = upload(
        served.server,
        { "Content-Type": ct_text },
        "ab",
      );
      req.end();
      deepStrictEqual(await within(served.settled), {
        error: errors[0],
        formatted: true,
      });
      deepStrictEqual(await status(response), 500);
    } finally {
      served.restore();
      await served.server.close();
    }
  });

  test("a request whose `complete` throws once its client goes away after the reply: the rejection", async () => {
    const errors: OwnError[] = [];
    const served = await serveDucked(
      new BodyParser(),
      (context) =>
        ducked(context, {
          request: () =>
            ducked(context.request, {
              complete: failing(errors, "complete"),
            }),
        }),
      true,
    );
    try {
      const { req, response } = upload(
        served.server,
        { "Content-Type": ct_text, "Content-Length": 1000 },
        "x".repeat(10),
      );
      deepStrictEqual(await status(response), 200);
      req.destroy();
      deepStrictEqual(await within(served.settled), {
        error: errors[0],
        formatted: true,
      });
    } finally {
      served.restore();
      await served.server.close();
    }
  });
});
