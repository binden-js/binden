import { Binden, type Context } from "../index.js";
import {
  type IGuardMethods,
  type IStreamLikeMethods,
  decided,
  emitterMethods,
  forwarder,
  guard,
  hasClosed,
  readStreamLike,
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

/**
 * Whether the guard of a source of a library leaves once it has closed: only
 * a `Readable` of `readable-stream` 4, whose state tells it (`closeEmitted`).
 * The others keep theirs (as long as they live, holding nothing but the
 * report of a late error): they may emit an error after their close.
 */
function closes(library: string): boolean {
  return library === "v4";
}

/** What the fixture of the stream-like sources has printed (run once) */
let printed: Record<string, unknown> | null = null;

/**
 * What the fixture of the stream-like sources has printed for these cases,
 * with its exit code and its errors (`counts`: its last line, the counts of
 * every case)
 */
function streamLikes(
  cases: readonly string[],
  counts = false,
): Record<string, unknown> {
  printed ??= fixture("stream-like-refusals.ts");
  const lines = String(printed.stdout).split("\n");
  return {
    status: printed.status,
    lines: [
      ...lines.filter((line) => cases.includes(line.split(" ")[1] ?? "")),
      ...(counts ? lines.slice(-2) : []),
    ],
    stderr: printed.stderr,
  };
}

suite("A source that refuses the listener of `error` of its guard", () => {
  test("a Node.js `Readable`: it keeps the one of its send, which logs its late error, and is destroyed without the error of the send; one that refuses every one is left untouched", () => {
    // `/every` refuses every listener of `error` (also of the send, which
    // rejects with it), `/head` the one of its guard (released to `HEAD`):
    // neither is destroyed. The others refuse the one of their guard (the
    // second): a body longer than its `Content-Length` (not destroyed with
    // that error), sent whole (destroyed by `autoDestroy`, or by the
    // application later), cancelled at the deadline, or failed by an error
    // that its own `on()` emits once the send listens (`/emitted`, heard by
    // the listener of the send, which stays). Each destroy fails 20 ms
    // later, logged once.
    deepStrictEqual(fixture("guard-refusals.ts"), {
      status: 0,
      stdout:
        "/every 500 rejected:No listener of error #1 destroyed=false errored=null paused=false errors=0\n" +
        "/guard 500 rejected:ERR_HTTP_CONTENT_LENGTH_MISMATCH destroyed=true errored=Late failure (/guard) paused=false errors=1\n" +
        "/ended 200 resolved destroyed=true errored=Late failure (/ended) paused=false errors=1\n" +
        "/later 200 resolved destroyed=true errored=Late failure (/later) paused=false errors=1\n" +
        "/deadline 503 rejected:The request has been aborted (deadline) destroyed=true errored=Late failure (/deadline) paused=false errors=1\n" +
        "/head 200 resolved destroyed=false errored=null paused=false errors=0\n" +
        "/emitted 500 rejected:Emitted at once destroyed=true errored=Late failure (/emitted) paused=false errors=1\n" +
        `${["/deadline", "/emitted", "/ended", "/guard", "/later"].map((path) => `Late failure (${path})`).join(", ")}\n` +
        // Once per source; the sources left: `/every` and `/head`
        "refused=7 left=2\n",
      stderr: "",
    });
  });

  test("its listener of `error` kept by the send does not keep the response, nor does a guard", () => {
    // 100 Node.js `Readable`s and 100 stream-like sources, each with the
    // listener of its send, and 100 Node.js `Readable`s with their guard,
    // each of which logs its late error once (200 guards refused)
    deepStrictEqual(fixture("fallback-retention.ts", "--expose-gc"), {
      status: 0,
      stdout: "collected 100 100 100 300 200\n",
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
        // Released once it has failed: destroyed without its error
        ...each(
          "guard-error",
          () =>
            "500 rejected:Its I/O has failed destroyed=undefined listeners=0/0/1/0 late=1",
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
        // Failed by an error that its own `on()` emits once the send
        // listens: the listener of the send, which has heard it, stays
        ...each(
          "guard-emitted",
          () =>
            "500 rejected:Its I/O has failed at once destroyed=undefined listeners=0/0/1/0 late=1",
          ["emitter"],
        ),
      ];
      deepStrictEqual(
        streamLikes([
          "guard-end",
          "guard-error",
          "guard-deadline",
          "every-head",
          "guard-emitted",
        ]),
        { status: 0, lines, stderr: "" },
      );
    });
  },
);

suite("Code of a stream-like source that throws while send() reads it", () => {
  test("its `on()` (also a listener of its `newListener`), its `removeListener()`, its `pause()`, its `resume()` (a falsy value), or its state (failed without being destroyed): nothing crashes, nothing of the send is left, and the send settles as for a Node.js `Readable`", () => {
    const lines = [
      // Rejected with what has been thrown, and destroyed with it (not
      // logged): only its guard stays (its listener of `error`, without its
      // listener of `close`, which it refuses), as long as it lives
      ...each(
        "newListener-close",
        () =>
          "500 rejected:newListener(close) refused destroyed=newListener(close) refused listeners=0/0/1/0 late=0",
      ),
      ...["end", "data"].flatMap((event) =>
        each(
          `newListener-${event}`,
          (library) =>
            `500 rejected:newListener(${event}) refused destroyed=newListener(${event}) refused listeners=0/0/${closes(library) ? "0/0" : "1/1"} late=0`,
        ),
      ),
      // Every listener of `error` refused: never destroyed (its destroy
      // would fail later), only left
      ...each(
        "every",
        () =>
          "500 rejected:No listener of error #1 destroyed= listeners=0/0/0/0 late=0",
      ),
      // A removal that throws is logged: the listener left stays harmless
      // (that of `error` logs a later error once). Of `readable-stream` 4:
      // closed by `autoDestroy`, its guard has left, its listener of `close`
      // removed on its own once the removal of the other one has thrown
      ...each(
        "removeListener-error",
        (library) =>
          `200 resolved destroyed=${library === "v4" ? "undefined" : ""} listeners=0/0/2/${library === "v4" ? 0 : 1} late=1`,
      ),
      // Of `readable-stream` 4: closed by `autoDestroy`, its guard has left
      ...each(
        "removeListener-end",
        () => "200 resolved destroyed= listeners=0/1/1/1 late=0",
        ["emitter", "v2", "v3"],
      ),
      "v4 removeListener-end 200 resolved destroyed=undefined listeners=0/1/0/0 late=0",
      ...each(
        "removeListener-all",
        (library) =>
          `200 resolved destroyed=${library === "v4" ? "undefined" : ""} listeners=1/1/2/2 late=1`,
      ),
      // Its `pause()` throws once the response is full: the response,
      // committed, is closed; destroyed with that error, or paused (which
      // throws again, logged) without `destroy()`. The emitters keep their
      // guards: their state cannot tell that they have closed
      "emitter pause 0 rejected:pause() refused destroyed=pause() refused listeners=0/0/1/1 late=0",
      "emitter pause-undestroyable 0 rejected:pause() refused #1 destroyed= listeners=0/0/1/1 late=0",
      // A string thrown by its own `on()`: logged once (by its guard, as its
      // destroy emits it), not by the readable that the send rejects with
      "emitter on-string 500 rejected:Thrown destroyed=Thrown listeners=0/0/1/1 late=0",
      // A falsy `errored` is no error: sent
      "emitter errored-false 200 resolved destroyed= listeners=0/0/1/1 late=0",
      // Failed without being destroyed: rejected at once with its error, and
      // released with it (not logged)
      "emitter errored 500 rejected:Errored before destroyed=Errored before listeners=0/0/1/1 late=0",
      'v4 errored-v4 500 rejected:ERR_INVALID_ARG_TYPE destroyed=The "chunk" argument must be of type string or an instance of Buffer or Uint8Array. Received type number (42) listeners=0/0/1/0 late=0',
      "emitter errored-state 500 rejected:Errored before destroyed=Errored before listeners=0/0/1/1 late=0",
      // A falsy value, which Node.js drops as an error: a premature close
      ...["null", "undefined"].map(
        (value) =>
          `emitter resume-${value} 500 rejected:ERR_STREAM_PREMATURE_CLOSE destroyed=Premature close listeners=0/0/1/1 late=0`,
      ),
      // Of every case: the removals that have thrown (each of the guard of
      // `readable-stream` 4 on its own), the guards refused (once per
      // source), the sources left, and the strings logged
      "removals=27 refusals=15 left=5 strings=1",
    ];
    deepStrictEqual(
      streamLikes(
        [
          "newListener-close",
          "newListener-end",
          "newListener-data",
          "every",
          "removeListener-error",
          "removeListener-end",
          "removeListener-all",
          "pause",
          "pause-undestroyable",
          "on-string",
          "errored-false",
          "errored",
          "errored-v4",
          "errored-state",
          "resume-null",
          "resume-undefined",
        ],
        true,
      ),
      { status: 0, lines: [...lines, ""], stderr: "" },
    );
  });
});

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

  test("of a source guarded meanwhile (e.g. by a listener of its `newListener` that releases it): one guard", async () => {
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
    // Reported on a later turn
    await ioTurn();
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

  test("forwarder(): forwards to its target until it is detached, then reports a late error as a guard does: not a decided one, nor one that the guard of the source reports", async () => {
    const source = new EventEmitter();
    const forwarded: unknown[] = [];
    const reports: unknown[] = [];
    const forward = forwarder((error: unknown) => {
      forwarded.push(error);
    });
    forward.listener("Heard");
    forward.detach(source, (error: unknown) => {
      reports.push(error);
    });
    const failure = new Error("Decided");
    decided(failure);
    forward.listener(failure);
    forward.listener("Late");
    guard(source, emitterMethods, () => null);
    forward.listener("Guarded");
    // Reported on a later turn
    await ioTurn();
    deepStrictEqual([forwarded, reports], [["Heard"], ["Late"]]);
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
  test("whose own `on()` emits an `error` at once: it settles, and no other listener is added", async () => {
    const source = new Recorded();
    const failure = new Error("Emitted at once");
    const added: string[] = [];
    Object.assign(source, {
      on(event: string, listener: () => void): Recorded {
        added.push(event);
        EventEmitter.prototype.on.call(source, event, listener);
        if (event === "error" && added.length === 1) {
          source.emit("error", failure);
        }
        return source;
      },
    });
    const readable = readStreamLike(
      source,
      methodsOf(source),
      () => new Error("Cancelled"),
      () => null,
    );
    const [error] = (await within(
      new Promise<unknown[]>((resolve) => {
        readable.once("error", (...args: unknown[]) => {
          resolve(args);
        });
      }),
    )) as [unknown];
    // Its guard, after the listener of the send; released once it has
    // failed (destroyed without its error)
    deepStrictEqual(
      [error, added, source.calls],
      [failure, ["error", "error", "close"], ["destroy"]],
    );
  });

  test("released that refuses its guard: left untouched (neither paused nor destroyed), the refusal reported", () => {
    const source = new Recorded();
    Object.assign(source, {
      on(event: string, listener: () => void): Recorded {
        if (event === "error") {
          throw new Error("No listener");
        }
        EventEmitter.prototype.on.call(source, event, listener);
        return source;
      },
    });
    const reports: unknown[] = [];
    releaseStreamLike(source, methodsOf(source), (error: unknown) => {
      reports.push((error as Error).message);
    });
    deepStrictEqual([source.calls, reports], [[], ["No listener"]]);
  });
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
