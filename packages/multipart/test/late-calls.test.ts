import { Binden, BindenError, type Context } from "binden";
import {
  type ITestServer,
  body,
  listen,
  part,
  type,
  within,
} from "./helpers.js";
import { type IncomingMessage, request } from "node:http";
import { deepStrictEqual, ok } from "node:assert/strict";
import { getEventListeners, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { suite, test } from "node:test";
import { Multipart } from "../index.js";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
 * A function (a getter, a setter or a method) that throws a new error of its
 * own, kept in `errors`
 */
function failing(errors: OwnError[], name: string): () => never {
  return (): never => {
    const error = new OwnError(`${name} of the context`);
    errors.push(error);
    throw error;
  };
}

/** The getter of a method (see `ducked()`) */
function method(call: () => unknown): () => unknown {
  return () => call;
}

/**
 * Serves a parser that runs on a context that only looks like the one of the
 * request (made by `duck`), then replies `parsed`: how it settles, while
 * `Error.prepareStackTrace` records the errors whose stacks V8 formats
 */
async function serveDucked(
  parser: Multipart,
  duck: (context: Context) => Context,
): Promise<{
  server: ITestServer;
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
  const server = await listen(
    new Binden().use(async (context: Context) => {
      const parsing = parser.run(duck(context));
      start(context);
      try {
        await parsing;
        settle({ ok: true });
      } catch (error: unknown) {
        settle({ error, formatted: formatted.has(error as object) });
        throw error;
      }
      await context.send("parsed");
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
  server: ITestServer,
  chunk: string,
  length = chunk.length,
): { req: ReturnType<typeof request>; response: Promise<IncomingMessage> } {
  const req = request(server.url, {
    method: "POST",
    agent: false,
    headers: { "Content-Type": type, "Content-Length": length },
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

/** A form of a field and a file */
const form = body(
  part('name="a"', "1"),
  part('name="f"; filename="f.txt"', "abcdefgh", ["Content-Type: text/plain"]),
);

suite("Multipart (late calls of a context)", () => {
  test("a context whose getters throw from their second read: each is read once", async () => {
    for (const [parser, length, expected] of [
      [new Multipart(), form.length, 200],
      [new Multipart({ limit: 4 }), form.length, 413],
      [
        new Multipart({ config: { limits: { fileSize: 2 } } }),
        form.length,
        413,
      ],
    ] as const) {
      const reads = new Map<string, number>();
      const served = await serveDucked(parser, (context) =>
        ducked(
          context,
          Object.fromEntries(
            ["request", "response", "signal", "log", "onCleanup"].map((key) => [
              key,
              (): unknown => {
                const count = (reads.get(key) ?? 0) + 1;
                reads.set(key, count);
                if (count > 1) {
                  throw new OwnError(`${key} read again`);
                }
                return Reflect.get(context, key, context);
              },
            ]),
          ),
        ),
      );
      try {
        const { req, response } = upload(served.server, form, length);
        const context = await within(served.started);
        req.end();
        deepStrictEqual(await status(response), expected);
        const settled = await within(served.settled);
        if (expected === 200) {
          deepStrictEqual(settled, { ok: true });
          ok(context.request.body instanceof FormData);
          deepStrictEqual(context.request.body.get("a"), "1");
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

  test("a response whose setHeader() throws once a file is over its limit: its error is the rejection, formatted, and the request is unpiped", async () => {
    const errors: OwnError[] = [];
    const served = await serveDucked(
      new Multipart({ config: { limits: { fileSize: 2 } } }),
      (context) =>
        ducked(context, {
          response: () =>
            ducked(context.response, {
              setHeader: method(failing(errors, "setHeader")),
            }),
        }),
    );
    try {
      const { req, response } = upload(served.server, form, form.length + 10);
      const context = await within(served.started);
      const settled = await within(served.settled);
      deepStrictEqual(
        [settled, context.request.readableFlowing],
        [{ error: errors[0], formatted: true }, false],
      );
      req.destroy();
      await status(response).catch(() => 0);
    } finally {
      served.restore();
      await served.server.close();
    }
  });

  test("a signal whose reason throws once it is aborted, then a setHeader() and a logger that throw: the first failure is the rejection", async () => {
    const errors: OwnError[] = [];
    const controller = new AbortController();
    const logger = {
      fatal: (): null => null,
      error: (): null => null,
      warn: (): null => null,
      info: (): null => null,
      debug: failing(errors, "debug"),
      trace: (): null => null,
      child: (): unknown => logger,
    };
    const served = await serveDucked(new Multipart(), (context) =>
      ducked(context, {
        signal: () =>
          ducked(controller.signal, { reason: failing(errors, "reason") }),
        response: () =>
          ducked(context.response, {
            setHeader: method(failing(errors, "setHeader")),
          }),
        log: () => logger,
      }),
    );
    try {
      const { req, response } = upload(served.server, "--", form.length);
      await within(served.started);
      controller.abort();
      const settled = await within(served.settled);
      deepStrictEqual(
        [settled, errors.map(({ message }) => message)],
        [
          { error: errors[0], formatted: true },
          [
            "reason of the context",
            "setHeader of the context",
            "debug of the context",
          ],
        ],
      );
      req.destroy();
      await status(response).catch(() => 0);
    } finally {
      served.restore();
      await served.server.close();
    }
  });

  test("a request whose `body` cannot be set, or whose methods throw as the parse starts: the rejection, formatted, and no listener is left", async () => {
    for (const name of ["body", "pipe"]) {
      const errors: OwnError[] = [];
      const controller = new AbortController();
      const served = await serveDucked(new Multipart(), (context) =>
        ducked(context, {
          signal: () => controller.signal,
          request: (): unknown => {
            if (name === "body") {
              return new Proxy(ducked(context.request, {}), {
                set: failing(errors, "body"),
              });
            }
            return ducked(context.request, {
              pipe: method(failing(errors, "pipe")),
            });
          },
        }),
      );
      try {
        const { req, response } = upload(served.server, form);
        await within(served.started);
        req.end();
        deepStrictEqual(await within(served.settled), {
          error: errors[0],
          formatted: true,
        });
        deepStrictEqual(
          getEventListeners(controller.signal, "abort").length,
          0,
        );
        deepStrictEqual(await status(response), 500);
      } finally {
        served.restore();
        await served.server.close();
      }
    }
  });

  test("the disk storage: a context whose onCleanup is read with an error is refused with it, one whose onCleanup() throws with a 500", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "binden-late-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    for (const name of ["read", "call"]) {
      const errors: OwnError[] = [];
      const served = await serveDucked(
        new Multipart({ storage: { dir } }),
        (context) =>
          ducked(context, {
            onCleanup:
              name === "read"
                ? failing(errors, "onCleanup")
                : method(failing(errors, "onCleanup")),
          }),
      );
      try {
        const { req, response } = upload(served.server, form);
        await within(served.started);
        req.end();
        const settled = await within(served.settled);
        if (name === "read") {
          deepStrictEqual(settled, { error: errors[0], formatted: true });
        } else {
          ok("error" in settled && settled.error instanceof BindenError);
          deepStrictEqual(
            [settled.error.status, settled.error.cause],
            [500, errors[0]],
          );
        }
        deepStrictEqual(await status(response), 500);
      } finally {
        served.restore();
        await served.server.close();
      }
    }
  });

  test("a file_filter that throws a value whose check throws (a revoked proxy): the rejection, never a pending parse", async () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const thrown = proxy as Error;
    const served = await serveDucked(
      new Multipart({
        file_filter: (): never => {
          throw thrown;
        },
      }),
      (context) => context,
    );
    try {
      const { req, response } = upload(served.server, form);
      await within(served.started);
      req.end();
      const settled = await within(served.settled);
      ok("error" in settled && settled.error instanceof TypeError);
      deepStrictEqual(
        [settled.error.message, settled.formatted],
        [
          "Cannot perform 'getPrototypeOf' on a proxy that has been revoked",
          true,
        ],
      );
      deepStrictEqual(await status(response), 500);
    } finally {
      served.restore();
      await served.server.close();
    }
  });
});
