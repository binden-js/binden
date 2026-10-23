import { Binden, type Context } from "../index.js";
import { PassThrough, Readable } from "node:stream";
import { capture, ioTurn, listen, pollUntil, within } from "./helpers.js";
import { deepStrictEqual, ok } from "node:assert/strict";
import { suite, test } from "node:test";
import { connect } from "node:net";
import { once } from "node:events";

/**
 * Writes raw requests on one connection: what it receives until the server
 * closes it, or until it has received what passes `expected` (then whether
 * the connection is still open, after a turn of the pending I/O, and once its
 * end has been read, after its `close` itself). Never a silence, which a
 * stall of the process would make look longer than it is
 */
async function exchange(
  port: number,
  data: string,
  expected: (received: string) => boolean = (): boolean => false,
): Promise<{ received: string; closed: boolean }> {
  const socket = connect(port, "127.0.0.1");
  await once(socket, "connect");
  const state = { received: "", closed: false };
  const { promise: closing, resolve: close } = Promise.withResolvers<null>();
  socket
    .setEncoding("latin1")
    .on("data", (chunk: string) => {
      state.received += chunk;
    })
    .on("error", () => {
      // Closed by the server: `close` follows
    })
    .on("close", () => {
      state.closed = true;
      close(null);
    });
  socket.write(data);
  try {
    // Else what has come within 10 s, which the assertions show
    await pollUntil(() => state.closed || expected(state.received)).catch(
      () => null,
    );
    await ioTurn();
    if (socket.readableEnded) {
      // Its `close` follows
      await within(closing);
    }
  } finally {
    socket.destroy();
  }
  return {
    received: state.received.replace(
      /^(?:Date|Keep-Alive): [^\r]*\r\n/gimu,
      "",
    ),
    closed: state.closed,
  };
}

/** How a send has settled: `resolved`, or the code (or the message) of its error */
function outcomeOf(promise: Promise<void>): Promise<unknown> {
  return promise.then(
    () => "resolved",
    (error: unknown) => {
      const { code, message } = error as { code?: unknown; message: string };
      return code ?? message;
    },
  );
}

/** A source that has been destroyed (and has closed) before its send */
async function destroyed(): Promise<Readable> {
  const source = new Readable({
    read(): void {
      // Nothing to read
    },
  });
  source.destroy();
  await once(source, "close");
  return source;
}

/** The next request on the connection, which must never be read as a body */
const next = "GET /next HTTP/1.1\r\nHost: localhost\r\n\r\n";

/** The head that `flushHeaders()` commits: it promises 3 bytes */
const head =
  "HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: keep-alive\r\n\r\n";

suite(
  "A send of a Readable that fails once the headers are committed (by `flushHeaders()`), before any byte of its body",
  () => {
    for (const [what, sourceOf, error] of [
      [
        "a first chunk longer than its `Content-Length`",
        (): Readable => new PassThrough().end("0123456789"),
        "ERR_HTTP_CONTENT_LENGTH_MISMATCH",
      ],
      [
        "an empty body (shorter than its `Content-Length`)",
        (): Readable => Readable.from([]),
        "ERR_HTTP_CONTENT_LENGTH_MISMATCH",
      ],
      [
        "a source that fails before its first chunk",
        (): Readable =>
          new Readable({
            read(): void {
              this.destroy(new Error("Failed"));
            },
          }),
        "Failed",
      ],
      [
        "a source destroyed with an error that its `_destroy()` swallows (it emits its `close` only)",
        (): Readable =>
          new Readable({
            read(): void {
              this.destroy(new Error("Swallowed"));
            },
            destroy(_error, callback): void {
              callback(null);
            },
          }),
        "Swallowed",
      ],
      [
        "a source destroyed before the send",
        destroyed,
        "ERR_STREAM_PREMATURE_CLOSE",
      ],
      [
        "the request of the response (an echo), longer than its `Content-Length`",
        null,
        "ERR_HTTP_CONTENT_LENGTH_MISMATCH",
      ],
    ] as const) {
      test(`${what}: the send rejects, and the response is closed (the next request of the connection is not read as its body)`, async () => {
        const outcome = Promise.withResolvers<unknown[]>();
        const app = new Binden({ logger: capture().logger }).use(
          async (context: Context) => {
            if (context.url.pathname === "/next") {
              await context.text("next");
              return;
            }
            const { response } = context;
            response.setHeader("Content-Length", 3);
            response.flushHeaders();
            const source =
              sourceOf === null ? context.request : await sourceOf();
            const failure = await outcomeOf(context.send(source));
            outcome.resolve([failure, response.destroyed]);
            // A work that catches the failure, and ends the response
            response.end();
          },
        );
        const listening = await listen(app);
        try {
          const { received, closed } = await exchange(
            listening.port,
            sourceOf === null
              ? `POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\n0123456789${next}`
              : `GET / HTTP/1.1\r\nHost: localhost\r\n\r\n${next}`,
          );
          deepStrictEqual(
            [await within(outcome.promise), received, closed],
            [[error, true], head, true],
          );
        } finally {
          await listening.close();
        }
      });
    }

    test("before the headers are committed, a source destroyed before the send rejects, and its error is replied (500)", async () => {
      const outcome = Promise.withResolvers<unknown[]>();
      const app = new Binden({ logger: capture().logger }).use(
        async (context: Context) => {
          if (context.url.pathname === "/next") {
            await context.text("next");
            return;
          }
          const { response } = context;
          response.setHeader("Content-Length", 3);
          const failure = await outcomeOf(context.send(await destroyed()));
          outcome.resolve([failure, response.started, response.destroyed]);
          throw new Error("Replied");
        },
      );
      const listening = await listen(app);
      try {
        const { received, closed } = await exchange(
          listening.port,
          `GET / HTTP/1.1\r\nHost: localhost\r\n\r\n${next}`,
          // The next response, complete
          (data) => data.endsWith("\r\n\r\nnext"),
        );
        deepStrictEqual(await within(outcome.promise), [
          "ERR_STREAM_PREMATURE_CLOSE",
          false,
          false,
        ]);
        // The 500, then the next response on the same connection
        ok(
          received.startsWith("HTTP/1.1 500 Internal Server Error\r\n"),
          received,
        );
        ok(received.endsWith("\r\n\r\nnext"), received);
        ok(!closed);
      } finally {
        await listening.close();
      }
    });
  },
);
