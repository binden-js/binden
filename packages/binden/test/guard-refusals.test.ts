import { Binden, type Context } from "../index.js";
import {
  type IGuardMethods,
  type IStreamLikeMethods,
  emitterMethods,
  guard,
  hasClosed,
  releaseStreamLike,
  streamLikeOf,
} from "../src/stream-like.js";
import { capture, ioTurn, listen, send, within } from "./helpers.js";
import { suite, test } from "node:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { deepStrictEqual } from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Runs a fixture (`test/fixtures`) in a process of its own, without a handler
 * of the process, with these flags of Node.js: a crash (e.g. an unhandled
 * `error` event) is its exit code and output, not a failure of the test
 * runner
 */
function fixture(name: string, ...flags: string[]): Record<string, unknown> {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [
      ...flags,
      "--no-warnings",
      "--import",
      "tsx",
      join(import.meta.dirname, "fixtures", name),
    ],
    { encoding: "utf8", timeout: 40_000 },
  );
  return { status, stdout, stderr };
}

/** The sources of the stream-like cases: not streams, and of `readable-stream` 2, 3 and 4 */
const libraries = ["emitter", "v2", "v3", "v4"] as const;

/** The line of each source of a case */
function each(
  name: string,
  line: (library: (typeof libraries)[number]) => string,
  sources: readonly (typeof libraries)[number][] = libraries,
): string[] {
  return sources.map((library) => `${library} ${name} ${line(library)}`);
}

suite("A source that refuses the listener of `error` of its guard", () => {
  test("a Node.js `Readable`: it keeps the one of its send, which logs its late error, and is destroyed without the error of the send; one that refuses every one is left, paused", () => {
    // `/every` refuses every listener of `error` (also of the send, which
    // rejects with it), `/head` the one of its guard (released to `HEAD`):
    // neither is destroyed. The others refuse the one of their guard (the
    // second): a body longer than its `Content-Length` (not destroyed with
    // that error), sent whole (destroyed by `autoDestroy`, or by the
    // application later), cancelled at the deadline. Each destroy fails
    // 20 ms later, logged once.
    deepStrictEqual(fixture("guard-refusals.ts"), {
      status: 0,
      stdout:
        "/every 500 rejected:No listener of error #1 destroyed=false errored=null paused=true errors=0\n" +
        "/guard 500 rejected:ERR_HTTP_CONTENT_LENGTH_MISMATCH destroyed=true errored=Late failure (/guard) paused=false errors=1\n" +
        "/ended 200 resolved destroyed=true errored=Late failure (/ended) paused=false errors=1\n" +
        "/later 200 resolved destroyed=true errored=Late failure (/later) paused=false errors=1\n" +
        "/deadline 503 rejected:The request has been aborted (deadline) destroyed=true errored=Late failure (/deadline) paused=false errors=1\n" +
        "/head 200 resolved destroyed=false errored=null paused=true errors=0\n" +
        `${["/deadline", "/ended", "/guard", "/later"].map((path) => `Late failure (${path})`).join(", ")}\n` +
        // Once per source; the sources left: `/every` and `/head`
        "refused=6 left=2\n",
      stderr: "",
    });
  });

  test("its listener of `error` kept by the send does not keep the response", () => {
    // 100 Node.js `Readable`s and 100 stream-like sources, each with the
    // listener of its send, which logs its late error once
    deepStrictEqual(fixture("fallback-retention.ts", "--expose-gc"), {
      status: 0,
      stdout: "collected 100 100 200 200\n",
      stderr: "",
    });
  });
});

suite(
  "A stream-like source that refuses the listener of `error` of its guard",
  () => {
    test("keeps the one of its send, which logs a later error once, and is destroyed without the error of the send; one that refuses every one is left", () => {
      const lines = [
        // Sent whole, or failed
        ...each(
          "guard-end",
          (library) =>
            `200 resolved destroyed=${library === "v4" ? "undefined" : ""} listeners=0/0/1/0 late=1`,
        ),
        ...each(
          "guard-error",
          () =>
            "500 rejected:Its I/O has failed destroyed= listeners=0/0/1/0 late=1",
          ["emitter"],
        ),
        // Destroyed without the reason of the deadline: its destroy fails
        // later, logged once
        ...each(
          "guard-deadline",
          () =>
            "503 rejected:The request has been aborted (deadline) destroyed=undefined listeners=0/0/1/0 late=1",
        ),
        // Released to `HEAD`, refusing every listener of `error`: never
        // destroyed (its destroy would fail later), only left
        ...each(
          "every-head",
          () => "200 resolved destroyed= listeners=0/0/0/0 late=0",
          ["emitter"],
        ),
        // The guards refused (once per source), and the sources left
        "removals=0 refusals=10 left=1",
      ];
      deepStrictEqual(fixture("stream-like-refusals.ts"), {
        status: 0,
        stdout: `${lines.join("\n")}\n`,
        stderr: "",
      });
    });
  },
);

/** A stream-like source that is not a stream, whose calls are recorded */
class Recorded extends EventEmitter {
  public readonly calls: string[] = [];

  public pause(): this {
    this.calls.push("pause");
    return this;
  }

  public resume(): this {
    this.calls.push("resume");
    return this;
  }

  public destroy(): this {
    this.calls.push("destroy");
    return this;
  }
}

/** The methods of a stream-like source (see `streamLikeOf()`) */
function methodsOf(source: object): IStreamLikeMethods {
  return streamLikeOf(source) as IStreamLikeMethods;
}

suite("guard() of a source", () => {
  test("is installed only once its listener of `error` is in place: what its code throws is given to `refused` (also for the removal of a listener that it may have added), and a source that refuses it is not asked again", () => {
    const source = new EventEmitter();
    const calls: string[] = [];
    const refused: unknown[] = [];
    const methods: IGuardMethods = {
      on: (event: unknown) => {
        calls.push(`on ${String(event)}`);
        throw new Error("No listener");
      },
      remove: (event: unknown) => {
        calls.push(`remove ${String(event)}`);
        throw new Error("No removal");
      },
    };
    const report = (error: unknown): void => {
      refused.push(`report ${(error as Error).message}`);
    };
    const results = [
      guard(source, methods, report, false, (error: unknown) => {
        refused.push((error as Error).message);
      }),
      // Not asked again, nor by the methods of Node.js
      guard(source, emitterMethods, report),
    ];
    deepStrictEqual(
      [results, calls, refused, source.listenerCount("error")],
      [
        [false, false],
        ["on error", "remove error"],
        ["No listener", "No removal"],
        0,
      ],
    );
  });

  test("of a source guarded meanwhile (e.g. by a listener of its `newListener` that releases it): one guard", () => {
    const source = new EventEmitter();
    const reports: unknown[] = [];
    const report = (error: unknown): void => {
      reports.push((error as Error).message);
    };
    let nested: boolean | null = null;
    source.once("newListener", () => {
      nested = guard(source, emitterMethods, report);
    });
    const guarded = guard(source, emitterMethods, report);
    source.emit("error", new Error("Failed"));
    deepStrictEqual(
      [
        guarded,
        nested,
        reports,
        source.listenerCount("error"),
        source.listenerCount("close"),
      ],
      [true, true, ["Failed"], 1, 1],
    );
  });

  test("hasClosed(): a state that cannot be read (a getter that throws) does not tell", () => {
    const source = Object.defineProperty({}, "_readableState", {
      get(): never {
        throw new Error("No state");
      },
    });
    deepStrictEqual(hasClosed(source), false);
  });
});

suite("A stream-like source used without the framework", () => {
  for (const throws of [false, true]) {
    test(`released that refuses its guard, without a report of it: left, paused${throws ? " (a pause() that throws is reported)" : ""}`, () => {
      const source = new Recorded();
      Object.assign(source, {
        on(event: string, listener: () => void): Recorded {
          if (event === "error") {
            throw new Error("No listener");
          }
          EventEmitter.prototype.on.call(source, event, listener);
          return source;
        },
        ...(throws
          ? {
              pause: (): never => {
                throw new Error("pause() refused");
              },
            }
          : {}),
      });
      const reports: unknown[] = [];
      releaseStreamLike(source, methodsOf(source), (error: unknown) => {
        reports.push((error as Error).message);
      });
      deepStrictEqual(
        [source.calls, reports],
        throws
          ? [[], ["No listener", "pause() refused"]]
          : [["pause"], ["No listener"]],
      );
    });
  }
});

suite(
  "A Node.js `Readable` whose own `removeListener()` throws for `close`",
  () => {
    test("its listener of `close` that the send has left changes nothing once the send has settled", async () => {
      const source = new (class extends Readable {
        public override removeListener(
          ...args: Parameters<Readable["removeListener"]>
        ): this {
          if (args[0] === "close") {
            throw new Error("No removal of close");
          }
          return super.removeListener(...args);
        }
      })({
        read(): void {
          // Longer than its `Content-Length`: the send fails, then destroys
          // it, which closes it before its end
          this.push("too long");
        },
      });
      // A listener that `once()` would remove cannot be
      const closed = new Promise((resolve) => {
        source.on("close", resolve);
      });
      const captured = capture();
      const sent = Promise.withResolvers<unknown>();
      const listening = await listen(
        new Binden({ logger: captured.logger }).use(
          async (context: Context) => {
            context.response.setHeader("Content-Length", 2);
            sent.resolve(
              await context.send(source).then(
                () => "resolved",
                (error: unknown) => (error as { code?: unknown }).code,
              ),
            );
            throw new Error("Replied");
          },
        ),
      );
      try {
        const received = await send(listening.port);
        const outcome = await within(sent.promise);
        await within(closed);
        // Its guard leaves on the turn after its close
        await ioTurn();
        // The listener of the send that is left, and the one of the test;
        // the error of the send only (not again by its close)
        deepStrictEqual(
          [
            received.status,
            outcome,
            source.listenerCount("close"),
            captured.records
              .filter(({ level }) => (level as number) >= 50)
              .map(({ msg }) => msg),
          ],
          [
            500,
            "ERR_HTTP_CONTENT_LENGTH_MISMATCH",
            2,
            ["The request has failed"],
          ],
        );
      } finally {
        await listening.close();
      }
    });
  },
);
