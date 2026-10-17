import { Binden, type Context } from "../index.js";
import { PassThrough, Readable } from "node:stream";
import { capture, listen, within } from "./helpers.js";
import { converse, get } from "./connection.js";
import { suite, test } from "node:test";
import { deepStrictEqual } from "node:assert/strict";

/** How a send has settled: `resolved`, or the code (or the message) of its error */
function outcomeOf(promise: Promise<void>): Promise<unknown> {
  return promise.then(
    () => "resolved",
    (error: unknown) => {
      const { code, message } = error as { code?: unknown; message?: unknown };
      return code ?? message;
    },
  );
}

/** A source that has errored (a chunk that is not bytes), not destroyed (`autoDestroy: false`) */
function errored(): Readable {
  const source = new Readable({
    autoDestroy: false,
    read(): void {
      // Never read
    },
  });
  source.on("error", () => {
    // Its error is `errored`
  });
  source.push({});
  return source;
}

suite(
  "A send that fails once the head of its response is committed, while the response waits for the one before it on its connection",
  () => {
    for (const [what, committed, sourceOf, error] of [
      [
        "a source destroyed before the send",
        true,
        (): Readable => new PassThrough().destroy(),
        "ERR_STREAM_PREMATURE_CLOSE",
      ],
      [
        "a source that has errored before the send",
        true,
        errored,
        "ERR_INVALID_ARG_TYPE",
      ],
      [
        "a source that fails before its first chunk",
        true,
        (): Readable => {
          const source = new PassThrough();
          setImmediate(() => source.destroy(new Error("Failed")));
          return source;
        },
        "Failed",
      ],
      [
        "a source that fails once 2 of its 3 bytes are written (not flushed)",
        false,
        (): Readable => {
          const source = new PassThrough();
          source.write("ab");
          setTimeout(() => source.destroy(new Error("Failed")), 5);
          return source;
        },
        "Failed",
      ],
      [
        "a body longer than its `Content-Length`",
        true,
        (): Readable => Readable.from(["abcdef"]),
        "ERR_HTTP_CONTENT_LENGTH_MISMATCH",
      ],
      [
        "a source whose `resume()` throws",
        true,
        (): Readable => {
          const source = new (class extends Readable {
            // eslint-disable-next-line class-methods-use-this -- it never resumes
            public override resume(): this {
              throw new Error("Not resumed");
            }
          })({
            read(): void {
              // Never read
            },
          });
          source.pause();
          return source;
        },
        "Not resumed",
      ],
    ] as const) {
      test(`${what}${committed ? " (after `flushHeaders()`)" : ""}: its head is never sent, and the next response is not read as its body`, async () => {
        const failed = Promise.withResolvers<unknown[]>();
        const app = new Binden({ logger: capture().logger }).use(
          async (context: Context) => {
            const { pathname } = context.url;
            if (pathname === "/slow") {
              // Once the send of the response after it has failed
              await failed.promise;
              await context.text("slow");
              return;
            } else if (pathname === "/next") {
              await context.text("next");
              return;
            }
            const { response } = context;
            response.setHeader("Content-Length", 3);
            if (committed) {
              response.flushHeaders();
            }
            const outcome = await outcomeOf(context.send(sourceOf()));
            failed.resolve([outcome, response.socket === null]);
            // A work that catches the failure, and ends the response
            response.end();
          },
        );
        const listening = await listen(app);
        try {
          const { received, closed } = await converse(
            listening.port,
            `${get("/slow")}${get("/")}${get("/next")}`,
          );
          deepStrictEqual(
            [await within(failed.promise), closed],
            [[error, true], true],
          );
          // Only the response before it
          deepStrictEqual(
            [
              received.match(/HTTP\/1\.1 \d{3}/gu),
              received.endsWith("\r\n\r\nslow"),
            ],
            [["HTTP/1.1 200"], true],
          );
        } finally {
          await listening.close();
        }
      });
    }
  },
);
