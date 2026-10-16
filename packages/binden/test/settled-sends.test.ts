import { type ITestServer, listen } from "./http.js";
import { afterEach, suite, test } from "node:test";
import { BindenResponse } from "../index.js";
import { Readable } from "node:stream";
import { deepStrictEqual } from "node:assert/strict";
import { join } from "node:path";
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

  test("the late error of the destroy of a source destroyed by the application before the send, without a listener of the application, is logged and does not crash the process", () => {
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
          "500\nERR_STREAM_PREMATURE_CLOSE\nFailed later (/destroyed)\n0000\n",
        stderr: "",
      },
    );
  });
});
