import { Binden, type Context } from "../index.js";
import { converse, get } from "./connection.js";
import { deepStrictEqual, ok } from "node:assert/strict";
import { suite, test } from "node:test";
import { join } from "node:path";
import { listen } from "./helpers.js";

/** A file that `sendFile()` sends */
const file = join(import.meta.dirname, "..", "package.json");

/** The message of the refusal of an informational status */
const informational = (status: number): string =>
  `Status code ${String(status)} is informational (use writeEarlyHints())`;

/**
 * Replies a request by `reply`, then the pipelined request that follows it
 * with `next`: what the client receives (without the `Date` of each
 * response) until the connection closes
 */
async function received(
  reply: (context: Context) => Promise<void>,
): Promise<string> {
  const app = new Binden().use(async (context: Context) => {
    if (context.url.pathname === "/next") {
      await context.send("next");
      return;
    }
    await reply(context);
  });
  const listening = await listen(app);
  try {
    const { received: text } = await converse(
      listening.port,
      `${get("/")}GET /next HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
    );
    return text.replaceAll(/Date: [^\r]*\r\n/gu, "");
  } finally {
    await listening.close();
  }
}

/** How a work replies once its `sendFile()` has rejected (see `received()`) */
const replies: Record<
  string,
  (context: Context, error: Error) => Promise<void>
> = {
  "end()": async ({ response }) => {
    response.statusCode = 500;
    response.end("err");
    return Promise.resolve();
  },
  "send()": async (context) => {
    context.response.statusCode = 500;
    await context.send("err");
  },
  // The error handler of binden replies
  "a rejection": async (_, error) => Promise.reject(error),
};

/** The code (or else the message) of what a promise rejects with (`null` once it resolves) */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => {
      const { code, message } = error as { code?: unknown; message: string };
      return code ?? message;
    },
  );
}

suite(
  "sendFile() refuses an informational status before it sets anything, as send() (H29-3)",
  () => {
    for (const [name, reply] of Object.entries(replies)) {
      test(`the reply that follows (by ${name}) is framed as if the file had never been sent`, async () => {
        for (const status of [100, 103, 199]) {
          /** The rejections of the sends of the file, by the first request */
          let rejected: unknown = null;
          let read = 0;
          let headers: unknown = null;
          const options = {
            get etag(): boolean {
              read += 1;
              return true;
            },
          };
          const ours = await received(async (context) => {
            const { response } = context;
            response.setHeader("X-Before", "1");
            response.statusCode = status;
            const error = await response.sendFile(file, options).then(
              () => null,
              (failure: unknown) => failure,
            );
            rejected = (error as Error | null)?.message;
            headers = { ...response.getHeaders() };
            await reply(context, error as Error);
          });
          deepStrictEqual(
            [rejected, read, headers],
            [informational(status), 0, { "x-before": "1" }],
            `${name} ${String(status)}`,
          );
          // The same reply without the file
          const expected = await received(async (context) => {
            context.response.setHeader("X-Before", "1");
            await reply(context, new TypeError(informational(status)));
          });
          ok(expected.endsWith("\r\n\r\nnext"), `${name} ${String(status)}`);
          deepStrictEqual(ours, expected, `${name} ${String(status)}`);
        }
      });
    }

    test("an object status is converted once, then refused before the file is opened", async () => {
      let conversions = 0;
      let outcome: unknown = null;
      await received(async ({ response }) => {
        response.statusCode = {
          [Symbol.toPrimitive](): number {
            conversions += 1;
            return 103;
          },
        } as never;
        outcome = await rejection(response.sendFile(file));
        deepStrictEqual(response.statusCode, 103);
        response.statusCode = 500;
        response.end();
      });
      deepStrictEqual([outcome, conversions], [informational(103), 1]);
    });
  },
);

suite(
  "A sendFile() that fails once it has set the headers of the file restores the response as it was before it (H29-3)",
  () => {
    test("a status that becomes informational while the file is opened: the reply that follows has none of the headers of the file, nor a length set before it", async () => {
      let outcome: unknown = null;
      let headers: unknown = null;
      let status: unknown = null;
      const ours = await received(async ({ response }) => {
        response.setHeader("X-Before", "1");
        response.setHeader("Content-Length", 10);
        const sent = response.sendFile(file);
        response.statusCode = 103;
        outcome = await rejection(sent);
        headers = { ...response.getHeaders() };
        status = response.statusCode;
        response.statusCode = 500;
        response.end("err");
      });
      deepStrictEqual(
        [outcome, headers, status],
        [informational(103), { "x-before": "1" }, 200],
      );
      // Without the length set before it, which Node.js remembers (the
      // reply is chunked)
      const expected = await received(async ({ response }) => {
        response.setHeader("X-Before", "1");
        response.setHeader("Content-Length", 10);
        response.removeHeader("Content-Length");
        response.statusCode = 500;
        response.end("err");
        return Promise.resolve();
      });
      ok(expected.endsWith("\r\n\r\nnext"));
      deepStrictEqual(ours, expected);
    });

    test("a head that Node.js refuses (its reason phrase): the reply of the error has none of the headers of the file", async () => {
      let outcome: unknown = null;
      let headers: unknown = null;
      await received(async ({ response }) => {
        response.setHeader("X-Before", "1");
        response.statusMessage = "bad\r\nx: y";
        outcome = await rejection(response.sendFile(file));
        headers = { ...response.getHeaders() };
        response.statusMessage = "";
        response.statusCode = 500;
        response.end();
      });
      deepStrictEqual(
        [outcome, headers],
        ["ERR_INVALID_CHAR", { "x-before": "1" }],
      );
    });

    test("a failure before the headers of the file are set (a path that is not a regular file) leaves the response as it is, also what has been set meanwhile", async () => {
      let outcome: unknown = null;
      let headers: unknown = null;
      await received(async ({ response }) => {
        response.setHeader("X-Before", "1");
        // A directory: refused once it is opened (or as it is opened, by
        // the system), before anything of it is set
        const sent = response.sendFile(import.meta.dirname);
        response.setHeader("X-During", "1");
        outcome = await rejection(sent);
        headers = { ...response.getHeaders() };
        response.statusCode = 500;
        response.end();
      });
      ok(outcome !== null);
      deepStrictEqual(headers, { "x-before": "1", "x-during": "1" });
    });

    test("once the head is committed, a sendFile() that fails changes nothing more: it rejects with the error of Node.js", async () => {
      let outcome: unknown = null;
      const text = await received(async ({ response }) => {
        response.setHeader("Content-Length", 0);
        response.flushHeaders();
        outcome = await response.sendFile(file).then(
          () => null,
          (error: unknown) => (error as Error).message,
        );
        response.end();
      });
      deepStrictEqual(
        outcome,
        "Cannot set headers after they are sent to the client",
      );
      ok(text.endsWith("\r\n\r\nnext"));
    });
  },
);
