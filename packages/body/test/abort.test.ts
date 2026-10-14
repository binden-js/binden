import { deepStrictEqual, ok } from "node:assert/strict";
import { once } from "node:events";
import { type IncomingMessage, request } from "node:http";
import { suite, test } from "node:test";
import { gzipSync } from "node:zlib";
import {
  Binden,
  BindenAbortError,
  BindenError,
  type Context,
  type IFunctionMiddleware,
  ct_json,
  ct_text,
} from "binden";

import { BodyParser } from "../index.js";
import { type IServer, Recorder, listen, never, within } from "./helpers.js";

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
