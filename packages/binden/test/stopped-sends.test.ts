import { Binden, type Context, releasedFailure } from "../index.js";
import { capture, ioTurn, listen, within } from "./helpers.js";
import { converse, get } from "./connection.js";
import { suite, test } from "node:test";
import type { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";
import { deepStrictEqual } from "node:assert/strict";

const require = createRequire(import.meta.url);

/** A `PassThrough` of `readable-stream` 4 (a stream-like source) */
type IPassThrough = new (options?: object) => EventEmitter & {
  destroy(error?: Error): unknown;
};

const { PassThrough: StreamLike } = require("readable-stream-v4") as {
  PassThrough: IPassThrough;
};

/** The source shared by both responses, and how it fails */
interface IShared {
  readonly source: EventEmitter;
  fail(error: Error): void;
}

/**
 * Sends one source to two responses: `/ended`, which the application ends
 * while its send listens (it waits for the response before it on its
 * connection, `/slow`, so that it has not finished), and `/live`, whose send
 * the source then fails (`first`: whose send listens first). Resolves with
 * the bodies of `/ended` and `/live`, how their sends have settled, and the
 * late errors that have been logged
 */
async function shared(
  sharing: IShared,
  first: "ended" | "live",
): Promise<[string[], Record<string, string>, unknown[]]> {
  const failure = new Error("The shared source has failed");
  const captured = capture();
  const outcomes: Record<string, string> = {};
  const started = {
    ended: Promise.withResolvers<null>(),
    live: Promise.withResolvers<null>(),
  };
  const slow = Promise.withResolvers<null>();
  const app = new Binden({
    logger: captured.logger,
    log_error_details: true,
  }).use(async (context: Context) => {
    const { pathname } = context.url;
    if (pathname === "/slow") {
      await slow.promise;
      await context.text("slow");
      return;
    }
    // @ts-expect-error -- a stream-like source, or a Readable
    const sent = context.send(sharing.source).then(
      () => "resolved",
      (error: unknown) => `rejected:${(error as Error).message}`,
    );
    if (pathname === "/ended") {
      context.response.end("complete");
      started.ended.resolve(null);
      outcomes.ended = await sent;
    } else {
      started.live.resolve(null);
      outcomes.live = await sent;
      context.response.status(500).end("failed");
    }
  });
  const listening = await listen(app);
  try {
    const conversations: Promise<{ received: string }>[] = [];
    for (const name of first === "ended"
      ? ["ended", "live"]
      : ["live", "ended"]) {
      conversations.push(
        name === "ended"
          ? converse(listening.port, `${get("/slow")}${get("/ended")}`, {
              complete: (received) => received.endsWith("\r\n\r\ncomplete"),
            })
          : converse(listening.port, get("/live"), {
              complete: (received) => received.endsWith("\r\n\r\nfailed"),
            }),
      );
      await within(started[name as "ended" | "live"].promise);
    }
    sharing.fail(failure);
    // Once the error has reached every listener of the source
    await ioTurn();
    slow.resolve(null);
    const received = await Promise.all(conversations);
    if (first === "live") {
      received.reverse();
    }
    // The report of a stopped send comes on a later turn
    await ioTurn();
    const bodies = received.map(
      ({ received: text }) =>
        /\r\n\r\n(?<body>\w+)$/u.exec(text)?.groups?.body ?? "",
    );
    const late = captured.records
      .filter(({ msg }) => msg === releasedFailure)
      .map(({ failure: logged }) => (logged as { message?: unknown }).message);
    return [bodies, outcomes, late];
  } finally {
    await listening.close();
  }
}

suite(
  "A source sent to a response that another writer has ended and to a live one",
  () => {
    for (const [kind, of] of [
      [
        "a Node.js `Readable` that emits its error",
        (): IShared => {
          const source = new PassThrough();
          return {
            source,
            fail: (error): void => {
              source.destroy(error);
            },
          };
        },
      ],
      [
        "a Node.js `Readable` destroyed with an error that its `_destroy()` swallows (its `close` with its `errored`)",
        (): IShared => {
          const source = new PassThrough({
            destroy(_error, callback): void {
              callback(null);
            },
          });
          return {
            source,
            fail: (error): void => {
              source.destroy(error);
            },
          };
        },
      ],
      [
        "a stream-like source (`readable-stream` 4) that emits its error",
        (): IShared => {
          const source = new StreamLike();
          return {
            source,
            fail: (error): void => {
              source.destroy(error);
            },
          };
        },
      ],
    ] as const) {
      for (const first of ["ended", "live"] as const) {
        test(`(${kind}) does not log the error that rejects the live send as a late error of the stopped one, whichever listens first (${first}): the ended response is complete`, async () => {
          deepStrictEqual(await shared(of(), first), [
            ["complete", "failed"],
            {
              ended: "resolved",
              live: "rejected:The shared source has failed",
            },
            [],
          ]);
        });
      }
    }
  },
);
