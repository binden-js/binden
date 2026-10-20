import { Binden, BindenResponse, type Context } from "../index.js";
import { HOST, ioTurn, listen, pollUntil, within } from "./helpers.js";
import {
  type ISourceReport,
  type IStreamLikeLogs,
  type IStreamLikeMethods,
  readStreamLike,
  releaseStreamLike,
  streamLikeOf,
} from "../src/stream-like.js";
import { IncomingMessage, request } from "node:http";
import { suite, test } from "node:test";
import { EventEmitter } from "node:events";
import { Socket } from "node:net";
import { deepStrictEqual } from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** A stream-like source of its own */
class Source extends EventEmitter {
  public pause(): this {
    return this;
  }

  public resume(): this {
    return this;
  }
}

/** A source whose `destroy()` throws `thrown` */
function throwing(thrown: unknown): Source {
  return Object.assign(new Source(), {
    destroy(): never {
      throw thrown;
    },
  });
}

/** The methods of a stream-like source (see `streamLikeOf()`) */
function methodsOf(source: object): IStreamLikeMethods {
  return streamLikeOf(source) as IStreamLikeMethods;
}

/** What a release has given its report (`late`) and its logs */
interface IRecorded {
  readonly late: unknown[];
  readonly released: unknown[];
  readonly report: ISourceReport;
  readonly logs: IStreamLikeLogs;
}

/** The message of an error, any other value as it is */
function messageOf(error: unknown): unknown {
  return error instanceof Error ? error.message : error;
}

/** Records the late errors and the logs of a release */
function record(): IRecorded {
  const late: unknown[] = [];
  const released: unknown[] = [];
  return {
    late,
    released,
    report: (error): void => {
      late.push(messageOf(error));
    },
    logs: {
      released: (error): void => {
        released.push(messageOf(error));
      },
      removed: (error): void => {
        released.push(`removal: ${String(messageOf(error))}`);
      },
    },
  };
}

/** The error that a readable is destroyed with */
function failureOf(readable: NodeJS.ReadableStream): Promise<unknown> {
  return within(
    new Promise((resolve) => {
      readable.once("error", resolve);
    }),
  );
}

/** An object thrown by code of a source, whose `stack` getter throws (as Node.js reads it once destroyed with it) */
function unstackable(): Error {
  const error = new Error("Unstackable");
  Object.defineProperty(error, "stack", {
    get(): never {
      throw new Error("Its stack cannot be read");
    },
  });
  return error;
}

/**
 * Runs a fixture (`test/fixtures`) in a process of its own, without a handler
 * of the process: a crash (e.g. an unhandled `error` event) is its exit code
 * and output, not a failure of the test runner
 */
function fixture(name: string): Record<string, unknown> {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--import",
      "tsx",
      join(import.meta.dirname, "fixtures", name),
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  return { status, stdout, stderr };
}

suite("A stream-like source whose destroy() throws", () => {
  test("once its resume() has failed the send: the readable fails with that error, and the throw of its destroy is logged", async () => {
    const recorded = record();
    const source = Object.assign(throwing(new Error("Release failed")), {
      resume(): never {
        throw new Error("Resume failed");
      },
    });
    const readable = readStreamLike(
      source,
      methodsOf(source),
      () => new Error("Cancelled"),
      recorded.report,
      () => null,
      recorded.logs,
    );
    readable.resume();
    deepStrictEqual(messageOf(await failureOf(readable)), "Resume failed");
    await ioTurn();
    deepStrictEqual(
      [recorded.released, recorded.late],
      [["Release failed"], []],
    );
  });

  test("once cancelled, without its guard (the listener of the send kept): the readable fails with the reason, and the throw is logged", async () => {
    const recorded = record();
    const source = throwing(null);
    let errors = 0;
    source.on("newListener", (event: string) => {
      if (event === "error") {
        errors += 1;
        if (errors === 2) {
          throw new Error("Guard refused");
        }
      }
    });
    const readable = readStreamLike(
      source,
      methodsOf(source),
      () => new Error("Cancelled"),
      recorded.report,
      () => null,
      recorded.logs,
    );
    const failure = failureOf(readable);
    readable.destroy(new Error("Cancelled"));
    deepStrictEqual(messageOf(await failure), "Cancelled");
    deepStrictEqual(
      [recorded.released, recorded.late],
      [["Guard refused", null], []],
    );
  });

  test("released (to HEAD): what it throws is logged, and the release goes on; so does a pause() that throws, without destroy()", () => {
    const recorded = record();
    const pausing = Object.assign(new Source(), {
      pause(): never {
        throw new Error("Pause failed");
      },
    });
    for (const source of [
      throwing(new Error("Release failed")),
      throwing(null),
      pausing,
    ]) {
      releaseStreamLike(
        source,
        methodsOf(source),
        recorded.report,
        () => null,
        recorded.logs,
      );
    }
    deepStrictEqual(
      [recorded.released, recorded.late],
      [["Release failed", null, "Pause failed"], []],
    );
  });

  test("not sent (to HEAD, or for 103): HEAD gets its reply and the send resolves, the send for 103 rejects with its TypeError", async () => {
    const outcomes: unknown[] = [];
    const app = new Binden().use(async (context: Context) => {
      if (context.url.pathname === "/103") {
        context.status(103);
      }
      outcomes.push(
        await context.send(throwing(null)).then(
          () => "resolved",
          (error: unknown) => (error as Error).name,
        ),
      );
    });
    const listening = await listen(app);
    try {
      const statuses: number[] = [];
      for (const [method, path] of [
        ["HEAD", "/"],
        ["GET", "/103"],
      ] as const) {
        const response = await within(
          new Promise<IncomingMessage>((resolve, reject) => {
            request(
              { agent: false, host: HOST, port: listening.port, method, path },
              resolve,
            )
              .once("error", reject)
              .end();
          }),
        );
        response.resume();
        statuses.push(response.statusCode ?? 0);
      }
      await pollUntil(() => outcomes.length === 2);
      // The rejection for 103 caught: nothing replied
      deepStrictEqual(
        [statuses, outcomes],
        [
          [200, 404],
          ["resolved", "TypeError"],
        ],
      );
    } finally {
      await listening.close();
    }
  });

  test("released for 103 without the framework: the send rejects with its TypeError, not with what its destroy() throws", async () => {
    const response = new BindenResponse(new IncomingMessage(new Socket()));
    const outcome = await response
      .status(103)
      .send(throwing(new Error("Release failed")))
      .then(
        () => "resolved",
        (error: unknown) => (error as Error).name,
      );
    deepStrictEqual(outcome, "TypeError");
  });
});

suite(
  "Code of a stream-like source that throws a value that Node.js cannot take as an error (its stack getter throws)",
  () => {
    test("while its listeners are added: the readable fails with an Error that carries it as its cause, and the listeners of the send are released", async () => {
      const recorded = record();
      const thrown = unstackable();
      const source = Object.assign(new Source(), {
        destroy: (): null => null,
        on(event: string, listener: () => void): Source {
          if (event === "end") {
            throw thrown;
          }
          EventEmitter.prototype.on.call(source, event, listener);
          return source;
        },
      });
      const readable = readStreamLike(
        source,
        methodsOf(source),
        () => new Error("Cancelled"),
        recorded.report,
        () => null,
        recorded.logs,
      );
      const failure = (await failureOf(readable)) as Error;
      await ioTurn();
      // Its guard stays (its state cannot tell that it has closed)
      deepStrictEqual(
        [
          failure.message,
          failure.cause === thrown,
          ["data", "end", "error", "close"].map((event) =>
            source.listenerCount(event),
          ),
        ],
        ["A stream has failed", true, [0, 0, 1, 1]],
      );
      source.emit("error", new Error("Later"));
      // Reported on a later turn
      await ioTurn();
      deepStrictEqual([recorded.late, recorded.released], [["Later"], []]);
    });

    test("in its pause() once the readable is full, or as its error: the readable fails with an Error that carries it as its cause, and nothing is thrown into its events", async () => {
      for (const how of ["pause", "error"] as const) {
        const recorded = record();
        const thrown = unstackable();
        const source = Object.assign(new Source(), {
          destroy: (): null => null,
          pause(): never {
            throw thrown;
          },
        });
        const readable = readStreamLike(
          source,
          methodsOf(source),
          () => new Error("Cancelled"),
          recorded.report,
          () => null,
          recorded.logs,
        );
        const failure = failureOf(readable);
        if (how === "pause") {
          // More than the readable takes: it pauses the source
          source.emit("data", Buffer.alloc(1 << 20));
        } else {
          source.emit("error", thrown);
        }
        const error = (await failure) as Error;
        await ioTurn();
        deepStrictEqual(
          [error.message, error.cause === thrown, recorded.late],
          ["A stream has failed", true, []],
          how,
        );
      }
    });

    test("sent, once its listeners are added or in its pause(): the send rejects, and a later error of the source does not crash the process", () => {
      deepStrictEqual(fixture("unstackable-sources.ts"), {
        status: 0,
        stdout:
          "/setup 500 rejected:original threw= late=Later\n" +
          "/pause 200 rejected:original threw= late=Later\n",
        stderr: "",
      });
    });
  },
);
