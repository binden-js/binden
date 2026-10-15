import { Agent, type IncomingMessage, request } from "node:http";
import {
  Binden,
  BindenAbortError,
  BindenError,
  type Context,
  type IFunctionMiddleware,
  ct_json,
  ct_text,
} from "binden";
import { type IServer, Recorder, listen, never, within } from "./helpers.js";
import { deepStrictEqual, ok } from "node:assert/strict";
import { suite, test } from "node:test";
import { BodyParser } from "../index.js";
import { gzipSync } from "node:zlib";
import { once } from "node:events";

/** How the parser has settled */
type IOutcome = { error: unknown } | { ok: true };

/** Runs a parser, and tells when it has started and how it has settled */
function watch(
  parser: BodyParser,
  before: (context: Context) => Promise<void> | void = (): void => {
    // Nothing
  },
): {
  middleware: IFunctionMiddleware;
  started: Promise<Context>;
  settled: Promise<IOutcome>;
} {
  const { promise: started, resolve: start } = Promise.withResolvers<Context>();
  const { promise: settled, resolve: settle } =
    Promise.withResolvers<IOutcome>();
  const middleware = async (context: Context): Promise<void> => {
    await before(context);
    start(context);
    try {
      await parser.run(context);
      settle({ ok: true });
    } catch (error: unknown) {
      settle({ error });
      throw error;
    }
  };
  return { middleware, started, settled };
}

/** Sends the headers and the first chunk of a body, without ending it */
function upload(
  server: IServer,
  headers: Record<string, number | string>,
  chunk: Buffer | string,
): { req: ReturnType<typeof request>; response: Promise<IncomingMessage> } {
  const req = request({
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
  req.write(chunk);
  return { req, response };
}

/** The error of a settled parser */
function failure(outcome: IOutcome): unknown {
  ok("error" in outcome, "The parser has not failed");
  return outcome.error;
}

/** Whether an error is the `400 Bad Request` of an aborted request */
function isAborted(error: unknown): boolean {
  return (
    error instanceof BindenError &&
    error.status === 400 &&
    error.code === "aborted"
  );
}

suite("BodyParser (aborted requests)", () => {
  test(
    "a client that goes away during the upload",
    { timeout: 10_000 },
    async () => {
      for (const [headers, body] of [
        [
          { "Content-Encoding": "gzip" },
          gzipSync("Hello World".repeat(10_000)),
        ],
        [{}, Buffer.alloc(64 * 1024, 0x61)],
      ] as const) {
        const watched = watch(new BodyParser());
        const logger = new Recorder();
        const server = await listen(
          new Binden({ logger }).use(watched.middleware),
        );
        try {
          const { req } = upload(
            server,
            {
              "Content-Type": ct_text,
              "Content-Length": body.length,
              ...headers,
            },
            body.subarray(0, body.length / 2),
          );
          await within(watched.started);
          req.destroy();
          ok(isAborted(failure(await within(watched.settled))));
          ok(logger.messages("debug").includes("The request has been aborted"));
          deepStrictEqual(logger.messages("error"), []);
        } finally {
          await server.close();
        }
      }
    },
  );

  test(
    "a client that goes away once the response has finished",
    { timeout: 10_000 },
    async () => {
      const parser = new BodyParser();
      const { promise: settled, resolve: settle } =
        Promise.withResolvers<IOutcome>();
      const logger = new Recorder();
      const server = await listen(
        new Binden({ logger }).use(async (context: Context) => {
          // Not awaited: the response finishes while the body is read
          parser.run(context).then(
            () => {
              settle({ ok: true });
            },
            (error: unknown) => {
              settle({ error });
            },
          );
          await context.send("early");
        }),
      );
      try {
        const { req, response } = upload(
          server,
          { "Content-Type": ct_text, "Content-Length": 1000 },
          "x".repeat(10),
        );
        const received = await within(response);
        received.resume();
        await within(once(received, "end"));
        req.destroy();
        ok(isAborted(failure(await within(settled))));
        deepStrictEqual(logger.messages("error"), []);
      } finally {
        await server.close();
      }
    },
  );

  test(
    "a parser that starts once the response has finished and its client has gone away",
    { timeout: 10_000 },
    async () => {
      const parser = new BodyParser();
      const { promise: settled, resolve: settle } =
        Promise.withResolvers<IOutcome>();
      const server = await listen(
        new Binden().use(async (context: Context) => {
          const { socket } = context.request;
          const gone = once(socket, "close");
          await context.send("early");
          await gone;
          // Only now, once the response has finished
          await parser.run(context).then(
            () => {
              settle({ ok: true });
            },
            (error: unknown) => {
              settle({ error });
            },
          );
        }),
      );
      try {
        // The headers only
        const { req, response } = upload(
          server,
          { "Content-Type": ct_text, "Content-Length": 1000 },
          "",
        );
        const received = await within(response);
        received.resume();
        await within(once(received, "end"));
        req.destroy();
        const error = failure(await within(settled));
        ok(error instanceof BindenError);
        deepStrictEqual(
          [error.status, error.message],
          [500, "The body has been discarded once the response finished"],
        );
      } finally {
        await server.close();
      }
    },
  );

  test(
    "a body received whole is read, also when its connection then closes",
    { timeout: 10_000 },
    async () => {
      const parser = new BodyParser();
      const { promise: settled, resolve: settle } =
        Promise.withResolvers<IOutcome>();
      const { promise: closed, resolve: close } =
        Promise.withResolvers<Context["request"]>();
      const server = await listen(
        new Binden().use(async (context: Context) => {
          const { request: incoming } = context;
          parser.run(context).then(
            () => {
              settle({ ok: true });
            },
            (error: unknown) => {
              settle({ error });
            },
          );
          // As if the rest of the body had been received, and were still on
          // its way to the parser when the connection closes
          incoming.complete = true;
          incoming.socket.once("close", () => {
            close(incoming);
          });
          await context.send("early");
        }),
      );
      try {
        const { req, response } = upload(
          server,
          { "Content-Type": ct_text, "Content-Length": 10 },
          "first",
        );
        const received = await within(response);
        received.resume();
        await within(once(received, "end"));
        req.destroy();
        const incoming = await within(closed);
        incoming.push("-last");
        incoming.push(null);
        deepStrictEqual(await within(settled), { ok: true });
        deepStrictEqual(incoming.body, "first-last");
      } finally {
        await server.close();
      }
    },
  );

  test("a connection that is kept alive keeps no listener of the parser", async () => {
    const parser = new BodyParser();
    const counts: number[] = [];
    const server = await listen(
      new Binden().use(async (context: Context) => {
        await parser.run(context);
        counts.push(context.request.socket.listenerCount("close"));
        await context.send(String(context.request.body));
      }),
    );
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      for (let index = 0; index < 3; index += 1) {
        const sent = request({
          port: server.port,
          method: "POST",
          agent,
          headers: { "Content-Type": ct_text },
        });
        sent.end("body");
        const [received] = (await within(once(sent, "response"))) as [
          IncomingMessage,
        ];
        received.resume();
        await within(once(received, "end"));
        deepStrictEqual(sent.reusedSocket, index > 0);
      }
      deepStrictEqual(new Set(counts).size, 1);
    } finally {
      agent.destroy();
      await server.close();
    }
  });

  test("a deadline during the upload", { timeout: 10_000 }, async () => {
    const watched = watch(new BodyParser());
    const server = await listen(
      new Binden({ timeout: 100 }).use(watched.middleware),
    );
    try {
      const { req, response } = upload(
        server,
        { "Content-Type": ct_text, "Content-Length": 1000 },
        "a",
      );
      const reply = await within(response);
      reply.resume();
      deepStrictEqual(
        [reply.statusCode, reply.headers.connection],
        [503, "close"],
      );
      const error = failure(await within(watched.settled));
      ok(error instanceof BindenAbortError);
      deepStrictEqual(error.reason, "deadline");
      req.destroy();
    } finally {
      await server.close();
    }
  });

  test(
    "a `verify` that never settles is abandoned at the deadline",
    { timeout: 10_000 },
    async () => {
      const watched = watch(new BodyParser({ verify: never }));
      const server = await listen(
        new Binden({ timeout: 100 }).use(watched.middleware),
      );
      try {
        const { req, response } = upload(
          server,
          { "Content-Type": ct_json, "Content-Length": 2 },
          "[]",
        );
        req.end();
        const reply = await within(response);
        reply.resume();
        deepStrictEqual(reply.statusCode, 503);
        const error = failure(await within(watched.settled));
        ok(error instanceof BindenAbortError);
        deepStrictEqual(error.reason, "deadline");
      } finally {
        await server.close();
      }
    },
  );

  test(
    "a `parse` that never settles is abandoned once the client has gone away",
    { timeout: 10_000 },
    async () => {
      const { promise: parsing, resolve } = Promise.withResolvers<null>();
      const parse = (): Promise<never> => {
        resolve(null);
        return never();
      };
      const watched = watch(new BodyParser({ parse }));
      const server = await listen(new Binden().use(watched.middleware));
      try {
        const { req } = upload(
          server,
          { "Content-Type": ct_json, "Content-Length": 2 },
          "[]",
        );
        req.end();
        await within(parsing);
        req.destroy();
        ok(isAborted(failure(await within(watched.settled))));
      } finally {
        await server.close();
      }
    },
  );

  test(
    "a request that has been aborted before the parser runs",
    { timeout: 10_000 },
    async () => {
      // Waits for the deadline, then runs the parser
      const watched = watch(new BodyParser(), async (context) => {
        await once(context.signal, "abort");
      });
      const server = await listen(
        new Binden({ timeout: 50 }).use(watched.middleware),
      );
      try {
        const { req, response } = upload(
          server,
          { "Content-Type": ct_text, "Content-Length": 2 },
          "ab",
        );
        req.end();
        (await within(response)).resume();
        const error = failure(await within(watched.settled));
        ok(error instanceof BindenAbortError);
        deepStrictEqual(error.reason, "deadline");
      } finally {
        await server.close();
      }
    },
  );

  test(
    "a request that has been destroyed before the parser runs",
    { timeout: 10_000 },
    async () => {
      const watched = watch(new BodyParser(), (context) => {
        context.request.destroy();
      });
      const server = await listen(new Binden().use(watched.middleware));
      try {
        const { req } = upload(
          server,
          { "Content-Type": ct_text, "Content-Length": 2 },
          "ab",
        );
        req.on("error", () => {
          // The server has closed the connection
        });
        req.end();
        const error = failure(await within(watched.settled));
        ok(isAborted(error));
        deepStrictEqual((error as Error).cause, null);
      } finally {
        await server.close();
      }
    },
  );

  test(
    "a request stream that fails while the client waits",
    { timeout: 10_000 },
    async () => {
      const streamError = new Error("A failure of the stream");
      const watched = watch(new BodyParser(), (context) => {
        setTimeout(() => {
          context.request.emit("error", streamError);
        }, 20);
      });
      const server = await listen(new Binden().use(watched.middleware));
      try {
        const { req, response } = upload(
          server,
          { "Content-Type": ct_text, "Content-Length": 1000 },
          "a",
        );
        const reply = await within(response);
        reply.resume();
        deepStrictEqual(
          [reply.statusCode, reply.headers.connection],
          [400, "close"],
        );
        const error = failure(await within(watched.settled));
        ok(isAborted(error));
        deepStrictEqual((error as Error).cause, streamError);
        req.destroy();
      } finally {
        await server.close();
      }
    },
  );
});

suite("BodyParser (once the response has finished)", () => {
  const discarded = "The body has been discarded once the response finished";

  test(
    "a parser that starts once the response has finished refuses the body",
    { timeout: 10_000 },
    async () => {
      for (const [type, payload] of [
        [ct_json, '{"a":1}'],
        [ct_text, "hello"],
        ["application/octet-stream", "hello"],
      ] as const) {
        const watched = watch(
          new BodyParser({ raw: true }),
          async (context) => {
            if (!context.response.writableFinished) {
              await once(context.response, "finish");
            }
          },
        );
        const logger = new Recorder();
        const server = await listen(
          new Binden({ logger }).use(async (context: Context) => {
            // Without `done`: the next middleware runs
            await context.response.status(202).send("accepted");
          }, watched.middleware),
        );
        try {
          // The body once the client has the reply
          const { req, response } = upload(
            server,
            { "Content-Type": type, "Content-Length": payload.length },
            "",
          );
          const received = await within(response);
          received.resume();
          await within(once(received, "end"));
          req.end(payload);
          const error = failure(await within(watched.settled));
          ok(error instanceof BindenError);
          deepStrictEqual([error.status, error.message], [500, discarded]);
          ok(logger.messages("error").includes(discarded));
        } finally {
          await server.close();
        }
      }
    },
  );

  test(
    "a parser that starts once the response has ended, but not finished, reads the body",
    {
      // Windows takes a whole write while its send buffer has room: the
      // response may finish before the client reads it
      skip: process.platform === "win32",
      timeout: 10_000,
    },
    async () => {
      // Larger than what the connection buffers: the response cannot finish
      // before the client reads it
      const large = Buffer.alloc(32 * 1024 * 1024, 0x61);
      const states: boolean[] = [];
      const watched = watch(new BodyParser(), (context) => {
        const { response } = context;
        states.push(response.writableEnded, response.writableFinished);
      });
      const server = await listen(
        new Binden().use((context: Context) => {
          context.response.end(large);
        }, watched.middleware),
      );
      try {
        const { req, response } = upload(
          server,
          { "Content-Type": ct_text, "Content-Length": 5 },
          "",
        );
        const context = await within(watched.started);
        req.end("hello");
        deepStrictEqual(await within(watched.settled), { ok: true });
        deepStrictEqual(
          [states, context.request.body],
          [[true, false], "hello"],
        );
        const received = await within(response);
        received.resume();
        await within(once(received, "end"));
      } finally {
        await server.close();
      }
    },
  );
});
