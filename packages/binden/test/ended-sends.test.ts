import { Binden, type Context, releasedFailure } from "../index.js";
import { type ICaptured, capture, listen, within } from "./helpers.js";
import { PassThrough, Readable } from "node:stream";
import { converse, get } from "./connection.js";
import { deepStrictEqual, ok } from "node:assert/strict";
import { suite, test } from "node:test";

/** A body larger than the buffers of a connection on any platform */
const large = 16 << 20;

/** How a send has settled: `resolved`, or what it has rejected with */
function outcomeOf(promise: Promise<void>): Promise<unknown> {
  return promise.then(
    () => "resolved",
    (error: unknown) => error,
  );
}

/** The code (or else the message) of each late error of a source logged so far */
function reported(captured: ICaptured): unknown[] {
  return captured.records
    .filter(({ msg }) => msg === releasedFailure)
    .map(({ failure }) => {
      const { code, message } = failure as {
        code?: unknown;
        message?: unknown;
      };
      return code ?? message;
    });
}

/** Whether the reply of `/next` has been received in full (the last one) */
function nextReceived(received: string): boolean {
  return received.endsWith("\r\n\r\nnext");
}

/**
 * The first response of what has been received: the length of its body (of
 * its chunks, or of its `Content-Length`), whether that body is `body`, and
 * whether the reply of `/next` follows it (and nothing else)
 */
function first(received: string, body: string): [number, boolean, boolean] {
  const end = received.indexOf("\r\n\r\n");
  const head = received.slice(0, end).toLowerCase();
  let at = end + 4;
  let content = "";
  if (head.includes("\r\ntransfer-encoding: chunked")) {
    let size = Number.NaN;
    while (size !== 0) {
      const line = received.indexOf("\r\n", at);
      size = Number.parseInt(received.slice(at, line), 16);
      if (Number.isNaN(size) || line === -1) {
        return [content.length, false, false];
      }
      content += received.slice(line + 2, line + 2 + size);
      // The chunk, then its line end (the last chunk: the end of the trailers)
      at = line + 2 + size + 2;
    }
  } else {
    const length = Number(
      /\r\ncontent-length: (?<length>\d+)/u.exec(head)?.groups?.length,
    );
    content = received.slice(at, at + length);
    at += length;
  }
  const rest = received.slice(at);
  return [
    content.length,
    content === body,
    rest.startsWith("HTTP/1.1 200 OK\r\n") && nextReceived(rest),
  ];
}

/**
 * Runs `scenario` as the middleware of `/`, and `/next` replies `next`: the
 * client writes `text` (once `hold` resolves, it reads), and gets what it
 * receives, how the send of the scenario has settled, and the logger
 */
async function run(
  scenario: (context: Context) => Promise<unknown>,
  text: string,
  {
    hold,
    complete = nextReceived,
    slow,
  }: {
    readonly hold?: Promise<unknown> | undefined;
    readonly complete?: ((received: string) => boolean) | undefined;
    /** What `/slow` waits for before it replies `slow` */
    readonly slow?: Promise<unknown> | undefined;
  } = {},
): Promise<[string, boolean, unknown, ICaptured]> {
  const captured = capture();
  const outcome = Promise.withResolvers<unknown>();
  const app = new Binden({
    logger: captured.logger,
    log_error_details: true,
  }).use(async (context: Context) => {
    if (context.url.pathname === "/next") {
      await context.text("next");
    } else if (context.url.pathname === "/slow") {
      await slow;
      await context.text("slow");
    } else {
      outcome.resolve(await scenario(context));
    }
  });
  const listening = await listen(app);
  try {
    const { received, closed } = await converse(listening.port, text, {
      complete,
      hold,
    });
    return [received, closed, await within(outcome.promise), captured];
  } finally {
    await listening.close();
  }
}

suite("A send whose response another writer has ended", () => {
  for (const pipelined of [false, true]) {
    test(`while its paused source waits for the drain, then the source fails: the reply is complete${pipelined ? ", and the next response is sent" : ""}`, async () => {
      const failed = Promise.withResolvers<null>();
      const [received, closed, outcome, captured] = await run(
        async (context) => {
          const { response } = context;
          response.setHeader("Content-Type", "text/plain");
          // Needs a drain: the source waits for it
          response.write(Buffer.alloc(large, 0x61));
          const source = new Readable({
            read(): void {
              // Never read
            },
          });
          source.pause();
          const sent = outcomeOf(context.send(source));
          response.end("END");
          source.destroy(new Error("The source has failed"));
          // Once its error is emitted
          await new Promise(setImmediate);
          failed.resolve(null);
          return sent;
        },
        pipelined ? `${get("/")}${get("/next")}` : get("/"),
        {
          hold: failed.promise,
          complete: pipelined
            ? nextReceived
            : (text): boolean => text.endsWith("\r\n0\r\n\r\n"),
        },
      );
      deepStrictEqual(
        [
          first(received, `${"a".repeat(large)}END`),
          closed,
          outcome,
          reported(captured),
        ],
        [
          [large + 3, true, pipelined],
          false,
          "resolved",
          ["The source has failed"],
        ],
      );
    });
  }

  for (const [how, failing, logged] of [
    [
      "fails",
      (source: Readable): void => {
        source.destroy(new Error("The source has failed"));
      },
      ["The source has failed"],
    ],
    [
      "closes",
      (source: Readable): void => {
        source.destroy();
      },
      [],
    ],
    [
      "is destroyed with an error that its `_destroy()` swallows (no `error`)",
      (source: Readable): void => {
        source.destroy(new Error("Swallowed"));
      },
      ["Swallowed"],
    ],
  ] as const) {
    for (const queued of [false, true]) {
      test(`before its first chunk, with a complete reply, then its source ${how}${queued ? ", while the response waits for the one before it" : ""}: the reply and the next response are sent`, async () => {
        const failed = Promise.withResolvers<null>();
        const [received, closed, outcome, captured] = await run(
          async (context) => {
            const { response } = context;
            const source = new PassThrough({
              destroy(error, callback): void {
                callback(how.startsWith("is destroyed") ? null : error);
              },
            });
            const sent = outcomeOf(context.send(source));
            response.end("BBBB");
            failing(source);
            // Once its failure is emitted, the response before it replies
            await new Promise(setImmediate);
            failed.resolve(null);
            return sent;
          },
          queued
            ? `${get("/slow")}${get("/")}${get("/next")}`
            : `${get("/")}${get("/next")}`,
          { slow: failed.promise },
        );
        const bodies = received.match(/\r\n\r\n(?:slow|BBBB|next)/gu);
        deepStrictEqual(
          [bodies, closed, outcome, reported(captured)],
          [
            [
              ...(queued ? ["\r\n\r\nslow"] : []),
              "\r\n\r\nBBBB",
              "\r\n\r\nnext",
            ],
            false,
            "resolved",
            logged,
          ],
        );
      });
    }
  }

  for (const failure of [new Error("The source has failed"), null]) {
    test(`with a complete reply too large to be flushed at once, then its source ${failure === null ? "closes" : "fails"}: the reply and the next response are sent`, async () => {
      const failed = Promise.withResolvers<null>();
      const [received, closed, outcome] = await run(
        async (context) => {
          const { response } = context;
          const source = new PassThrough();
          const sent = outcomeOf(context.send(source));
          response.setHeader("Content-Length", large);
          response.end(Buffer.alloc(large, 0x61));
          if (failure === null) {
            source.destroy();
          } else {
            source.destroy(failure);
          }
          await new Promise(setImmediate);
          failed.resolve(null);
          return sent;
        },
        `${get("/")}${get("/next")}`,
        { hold: failed.promise },
      );
      deepStrictEqual(
        [first(received, "a".repeat(large)), closed, outcome],
        [[large, true, true], false, "resolved"],
      );
    });
  }

  test("once its source has been paused by its backpressure, then the source fails: the reply and the next response are sent", async () => {
    const failed = Promise.withResolvers<null>();
    const [received, closed, outcome, captured] = await run(
      async (context) => {
        const { response } = context;
        response.setHeader("Content-Type", "text/plain");
        let pushed = false;
        let paused = false;
        const source = new (class extends Readable {
          public override pause(): this {
            super.pause();
            if (!paused) {
              paused = true;
              // As the work, once the send has paused it
              queueMicrotask(() => {
                response.end();
                this.destroy(new Error("The source has failed"));
                setImmediate(() => {
                  failed.resolve(null);
                });
              });
            }
            return this;
          }
        })({
          read(): void {
            if (!pushed) {
              pushed = true;
              this.push(Buffer.alloc(large, 0x61));
            }
          },
        });
        return outcomeOf(context.send(source));
      },
      `${get("/")}${get("/next")}`,
      { hold: failed.promise },
    );
    deepStrictEqual(
      [first(received, "a".repeat(large)), closed, outcome, reported(captured)],
      [[large, true, true], false, "resolved", ["The source has failed"]],
    );
  });

  test("before its source ends, short of the `Content-Length` that the send has read: the reply and the next response are sent, and nothing is logged", async () => {
    const [received, closed, outcome, captured] = await run(
      async (context) => {
        const { response } = context;
        response.setHeader("Content-Length", 3);
        const source = new PassThrough();
        const sent = outcomeOf(context.send(source));
        response.end("abc");
        source.end();
        return sent;
      },
      `${get("/")}${get("/next")}`,
    );
    deepStrictEqual(
      [
        received.match(/\r\n\r\n(?:abc|next)/gu),
        closed,
        outcome,
        reported(captured),
      ],
      [["\r\n\r\nabc", "\r\n\r\nnext"], false, "resolved", []],
    );
  });

  test("whose source then errors without being destroyed (`autoDestroy: false`): the source is released at once, and its error logged once", async () => {
    const source = new Readable({
      autoDestroy: false,
      read(): void {
        // Pushed below
      },
    });
    const failed = Promise.withResolvers<null>();
    const [received, closed, outcome, captured] = await run(
      async (context) => {
        const { response } = context;
        const sent = outcomeOf(context.send(source));
        response.setHeader("Content-Length", large);
        response.end(Buffer.alloc(large, 0x61));
        // Not bytes: it errors, but is not destroyed
        source.push({});
        await new Promise(setImmediate);
        // Released at once, before the response has finished where its client
        // does not read yet (Windows takes the whole write while its send
        // buffer has room: its response may have finished already)
        const released = source.destroyed;
        failed.resolve(null);
        return [await sent, released];
      },
      `${get("/")}${get("/next")}`,
      { hold: failed.promise },
    );
    deepStrictEqual(
      [first(received, "a".repeat(large)), closed, outcome, reported(captured)],
      [
        [large, true, true],
        false,
        ["resolved", true],
        ["ERR_INVALID_ARG_TYPE"],
      ],
    );
  });

  test("whose source then fails once released (its chunk comes after the end): its error is logged once", async () => {
    const [received, closed, outcome, captured] = await run(
      async (context) => {
        const { response } = context;
        const source = new Readable({
          read(): void {
            // Pushed below
          },
          destroy(_error, callback): void {
            callback(new Error("Its release has failed"));
          },
        });
        const sent = outcomeOf(context.send(source));
        response.end("ended");
        // Read once the response has ended: released
        source.push("late");
        return sent;
      },
      `${get("/")}${get("/next")}`,
    );
    // Logged by its guard only (the send hears it too)
    await new Promise(setImmediate);
    deepStrictEqual(
      [
        received.match(/\r\n\r\n(?:ended|late|next)/gu),
        closed,
        outcome,
        reported(captured),
      ],
      [
        ["\r\n\r\nended", "\r\n\r\nnext"],
        false,
        "resolved",
        ["Its release has failed"],
      ],
    );
  });

  for (const errored of [false, true]) {
    test(`before a source that code of the source finds destroyed${errored ? " and errored" : ""}: the send settles as the response${errored ? ", and the error of the source is logged once" : ""}`, async () => {
      const [received, closed, outcome, captured] = await run(
        async (context) => {
          const { response } = context;
          const source = new Readable({
            autoDestroy: false,
            read(): void {
              // Never read
            },
          });
          if (errored) {
            source.on("error", () => {
              // Its error is `errored`
            });
            // Not bytes: it errors, but is not destroyed
            source.push({});
          }
          // A getter of its own that ends the response once `send()` has
          // checked it
          Object.defineProperty(source, "destroyed", {
            get(): boolean {
              response.end("ended");
              return true;
            },
          });
          return outcomeOf(context.send(source));
        },
        `${get("/")}${get("/next")}`,
      );
      deepStrictEqual(
        [
          received.match(/\r\n\r\n(?:ended|next)/gu),
          closed,
          outcome,
          reported(captured),
        ],
        [
          ["\r\n\r\nended", "\r\n\r\nnext"],
          false,
          "resolved",
          errored ? ["ERR_INVALID_ARG_TYPE"] : [],
        ],
      );
    });
  }
});

suite("A send that has ended its response", () => {
  test("with its whole body, whose source then fails to be destroyed (`autoDestroy`): the reply and the next response are sent", async () => {
    const failed = Promise.withResolvers<null>();
    const [received, closed, outcome, captured] = await run(
      async (context) => {
        const { response } = context;
        let pushed = false;
        const source = new Readable({
          read(): void {
            if (!pushed) {
              pushed = true;
              this.push(Buffer.alloc(large, 0x61));
            }
            this.push(null);
          },
          destroy(_error, callback): void {
            callback(new Error("Its destroy has failed"));
          },
        });
        source.on("error", () => {
          // Once the send has heard it
          setImmediate(() => {
            failed.resolve(null);
          });
        });
        response.setHeader("Content-Length", large);
        return outcomeOf(context.send(source));
      },
      `${get("/")}${get("/next")}`,
      { hold: failed.promise },
    );
    deepStrictEqual(
      [first(received, "a".repeat(large)), closed, outcome, reported(captured)],
      [[large, true, true], false, "resolved", ["Its destroy has failed"]],
    );
  });
});

suite(
  "A Readable that has errored before the send, without being destroyed",
  () => {
    /** A source that has errored (a chunk that is not bytes), which `autoDestroy: false` keeps */
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

    test("rejects at once with its error, which is replied", async () => {
      const source = errored();
      deepStrictEqual(source.destroyed, false);
      const [received, closed, outcome] = await run(
        async (context) => {
          const error = await outcomeOf(context.send(source));
          return [
            (error as { code?: unknown }).code,
            error === source.errored,
            context.response.started,
          ];
        },
        `${get("/")}${get("/next")}`,
      );
      // The middleware has not replied: 404
      ok(received.startsWith("HTTP/1.1 404 Not Found\r\n"), received);
      deepStrictEqual(
        [closed, outcome, source.destroyed],
        [false, ["ERR_INVALID_ARG_TYPE", true, false], false],
      );
    });

    test("closes a response whose headers are committed", async () => {
      const [received, closed, outcome] = await run(
        async (context) => {
          const { response } = context;
          response.setHeader("Content-Length", 3);
          response.flushHeaders();
          const error = await outcomeOf(context.send(errored()));
          return [(error as { code?: unknown }).code, response.destroyed];
        },
        `${get("/")}${get("/next")}`,
      );
      deepStrictEqual(
        [received.includes("next"), closed, outcome],
        [false, true, ["ERR_INVALID_ARG_TYPE", true]],
      );
    });

    test("destroyed with an error before the send: rejects at once with that error", async () => {
      const failure = new Error("Destroyed before");
      const source = new Readable({
        read(): void {
          // Never read
        },
      });
      source.on("error", () => {
        // Its error is `errored`
      });
      source.destroy(failure);
      const [, , outcome] = await run(
        (context) => outcomeOf(context.send(source)),
        `${get("/")}${get("/next")}`,
      );
      deepStrictEqual(outcome, failure);
    });
  },
);
