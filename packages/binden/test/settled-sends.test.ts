import { type ITestServer, listen } from "./http.js";
import { afterEach, suite, test } from "node:test";
import { deepStrictEqual, ok } from "node:assert/strict";
import { BindenResponse } from "../index.js";
import { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { Socket } from "node:net";
import { join } from "node:path";
import { kCancel } from "../src/seal.js";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { within } from "./helpers.js";

/** The listeners that a source has of its `data`, `end`, `error` and `close` */
function counts(source: Readable): number[] {
  return ["data", "end", "error", "close"].map((event) =>
    source.listenerCount(event),
  );
}

/** The next turn: once the guard of a source that has closed is removed */
function nextTurn(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/** The settled value of a promise: `null` once resolved, or its error */
function settle(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

/** A response of no connection */
function detached(): BindenResponse {
  return new BindenResponse(new IncomingMessage(new Socket()));
}

/** A source that is never read to its end, whose calls of its own methods are counted */
class Counted extends Readable {
  public readonly calls: string[] = [];

  public constructor() {
    super({
      read(): void {
        // Its next chunk never comes
      },
    });
  }

  public override destroy(error?: Error): this {
    this.calls.push("destroy");
    return super.destroy(error);
  }

  public override resume(): this {
    this.calls.push("resume");
    return super.resume();
  }
}

suite("A settled send of a Readable", () => {
  const servers: ITestServer[] = [];

  /** Replies one request with the handler (on a server of its own) */
  const reply = async (
    handler: (response: BindenResponse) => Promise<unknown>,
  ): Promise<number> => {
    const app = await listen();
    servers.push(app);
    const handled = app.handle(async (_request, response) => handler(response));
    const { status } = await app.request();
    deepStrictEqual(await handled, null);
    return status;
  };

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (app) => app.close()));
  });

  test("sent in full leaves none of its listeners on a source that the application keeps (its guard until the turn after its close)", async () => {
    const source = Readable.from(["abc"]);
    let settled: number[] = [];
    const status = await reply(async (response) => {
      await response.send(source);
      settled = counts(source);
    });
    deepStrictEqual(status, 200);
    if (!source.closed) {
      await once(source, "close");
    }
    await nextTurn();
    // Of `data` and `end`: none once it has settled
    deepStrictEqual(
      [settled.slice(0, 2), counts(source)],
      [
        [0, 0],
        [0, 0, 0, 0],
      ],
    );
  });

  test("of a source that has ended and closed before leaves none of its listeners (its end and its close never come)", async () => {
    const source = Readable.from([]);
    source.resume();
    await once(source, "close");
    const status = await reply(async (response) => {
      await response.send(source);
    });
    deepStrictEqual(status, 200);
    await nextTurn();
    deepStrictEqual(counts(source), [0, 0, 0, 0]);
  });

  test("cancelled: a later close of the response does not touch the source, which has none of its listeners", async () => {
    const response = detached();
    const source = new Counted();
    const reason = new Error("Cancelled");
    const sent = settle(response.send(source));
    response[kCancel](reason);
    deepStrictEqual(await within(sent), reason);
    // Released by the cancellation
    ok(source.destroyed);
    const calls = source.calls.length;
    // E.g. the client goes away
    response.emit("close");
    await nextTurn();
    deepStrictEqual(
      [source.calls.slice(calls), counts(source).slice(0, 2)],
      [[], [0, 0]],
    );
  });

  test("failed once its first chunk is written: a later drain of the response does not resume the source", async () => {
    const response = detached();
    const source = new Counted();
    // More than the response takes before it is full
    source.push(Buffer.alloc(64 * 1024, 0x61));
    const failure = new Error("Failed");
    const sent = settle(response.send(source));
    await within(once(source, "pause"));
    ok(response.headersSent);
    source.destroy(failure);
    deepStrictEqual(await within(sent), failure);
    const calls = source.calls.length;
    response.emit("drain");
    response.emit("close");
    await nextTurn();
    deepStrictEqual(
      [source.calls.slice(calls), counts(source).slice(0, 2)],
      [[], [0, 0]],
    );
  });

  test("of a source still read once another writer has ended the response releases it", async () => {
    // Its next chunk never comes: the response closes before the send
    // settles, or else the settlement releases it
    const source = new Counted();
    source.push("first");
    const status = await reply(async (response) => {
      // As a compression that replaces the response with an empty `406`
      // when the first chunk commits the headers
      response.write = (): boolean => {
        response.writeHead(406, { "Content-Length": 0 }).end();
        return true;
      };
      await response.send(source);
    });
    deepStrictEqual([status, source.destroyed], [406, true]);
  });

  test("of a source destroyed by the application before rejects at once: only its guard listens, until the turn after its close", async () => {
    const closed = Readable.from(["abc"]);
    closed.destroy();
    await once(closed, "close");
    // Its destroy completes later
    let complete = (): void => {
      // Until it is destroyed
    };
    const closing = new Readable({
      read(): void {
        // Nothing to read
      },
      destroy(error, callback): void {
        complete = (): void => {
          callback(error);
        };
      },
    });
    closing.destroy();
    const outcomes: unknown[] = [];
    for (const source of [closed, closing]) {
      const status = await reply(async (response) => {
        const error = await within(settle(response.send(source)), 1000);
        outcomes.push((error as { code?: unknown }).code);
        await response.status(500).send();
      });
      deepStrictEqual(status, 500);
    }
    await nextTurn();
    deepStrictEqual(
      [outcomes, counts(closed), counts(closing)],
      [
        ["ERR_STREAM_PREMATURE_CLOSE", "ERR_STREAM_PREMATURE_CLOSE"],
        [0, 0, 0, 0],
        [0, 0, 1, 1],
      ],
    );
    complete();
    await once(closing, "close");
    await nextTurn();
    deepStrictEqual(counts(closing), [0, 0, 0, 0]);
  });

  test("failed by an error that does not destroy the source releases it", async () => {
    const source = new Counted();
    let error: unknown = null;
    const failure = new Error("Failed");
    const status = await reply(async (response) => {
      setTimeout(() => {
        source.emit("error", failure);
      }, 10);
      error = await settle(response.send(source));
      ok(!response.started);
      await response.status(500).send();
    });
    deepStrictEqual([status, error, source.destroyed], [500, failure, true]);
  });

  test("once it has failed, a listener that the source keeps beyond its removal (its own once()) changes nothing: the error is replied", async () => {
    const kept: (() => void)[] = [];
    const source = new Counted();
    Object.assign(source, {
      once(event: string, listener: () => void): Counted {
        if (event === "end") {
          kept.push(listener);
          return source;
        }
        return Readable.prototype.once.call(source, event, listener) as Counted;
      },
    });
    const failure = new Error("Failed");
    let error: unknown = null;
    const status = await reply(async (response) => {
      setTimeout(() => {
        source.emit("error", failure);
      }, 10);
      error = await settle(response.send(source));
      // Its end, which the send no longer waits for
      for (const listener of kept) {
        listener();
      }
      ok(!response.started);
      await response.status(500).send();
    });
    deepStrictEqual([status, error, kept.length], [500, failure, 1]);
  });

  test("the late errors of the destroy of a source (destroyed by the application before the send, or by autoDestroy once it has ended), without a listener of the application, are logged and do not crash the process", () => {
    const { status, stdout, stderr } = spawnSync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        join(import.meta.dirname, "fixtures", "native-late-errors.ts"),
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    deepStrictEqual(
      { status, stdout, stderr },
      {
        status: 0,
        stdout:
          "500 200 200\nERR_STREAM_PREMATURE_CLOSE resolved resolved\n" +
          "Failed later (/active), Failed later (/destroyed), Failed later (/ended)\n" +
          "0000 0000 0000\n",
        stderr: "",
      },
    );
  });
});
