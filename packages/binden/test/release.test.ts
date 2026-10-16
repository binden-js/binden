import { Binden, type Context } from "../index.js";
import { capture, listen, send, sleep, within } from "./helpers.js";
import { suite, test } from "node:test";
import { Readable } from "node:stream";
import { deepStrictEqual } from "node:assert/strict";

suite("A Node.js `Readable` that a response does not send", () => {
  test("released by many sends (to `HEAD`, with 204 or 103): one guard, which logs its late error, and no warning", async () => {
    const captured = capture();
    const warnings: string[] = [];
    const warned = (warning: Error): void => {
      warnings.push(warning.name);
    };
    process.on("warning", warned);
    // Its destroy fails once every send has released it
    const failing = Promise.withResolvers<null>();
    const source = new Readable({
      read(): void {
        // Nothing to read
      },
      destroy(_error, callback): void {
        failing.promise.then(
          () => {
            callback(new Error("The source has failed to close"));
          },
          () => null,
        );
      },
    });
    const outcomes: unknown[] = [];
    const app = new Binden({
      logger: captured.logger,
      log_error_details: true,
    }).use(async (context: Context) => {
      const { pathname } = context.url;
      if (pathname === "/no-content") {
        context.status(204);
      } else if (pathname === "/informational") {
        context.status(103);
      }
      outcomes.push(
        await context.response.send(source).then(
          () => "resolved",
          (error: unknown) => (error as Error).name,
        ),
      );
    });
    const listening = await listen(app);
    try {
      const statuses: number[] = [];
      for (let index = 0; index < 21; index += 1) {
        const [method, path] = (
          [
            ["HEAD", "/"],
            ["GET", "/no-content"],
            ["GET", "/informational"],
          ] as const
        )[index % 3] as readonly [string, string];
        statuses.push((await send(listening.port, { method, path })).status);
      }
      // The send of a 103 rejects, and the middleware replies nothing
      deepStrictEqual(
        statuses,
        Array.from({ length: 7 }, () => [200, 204, 404]).flat(),
      );
      deepStrictEqual(
        outcomes,
        Array.from({ length: 7 }, () => [
          "resolved",
          "resolved",
          "TypeError",
        ]).flat(),
      );
      // Released once, by `Readable.prototype.destroy()`: its guard is the
      // only listener that the sends have left on it
      deepStrictEqual(
        [
          source.destroyed,
          source.readableFlowing,
          source.listenerCount("error"),
          source.listenerCount("close"),
        ],
        [true, null, 1, 1],
      );
      failing.resolve(null);
      const record = await captured.waitFor(
        "A stream-like source has failed once released",
      );
      deepStrictEqual(
        [record.level, (record.failure as { message: string }).message],
        [20, "The source has failed to close"],
      );
      // Removed on the turn after its `close`
      await within(
        (async (): Promise<void> => {
          while (source.listenerCount("error") > 0) {
            await sleep(5);
          }
        })(),
      );
      deepStrictEqual(source.listenerCount("close"), 0);
      deepStrictEqual(
        captured.records.filter(
          ({ msg }) => msg === "A stream-like source has failed once released",
        ).length,
        1,
      );
      deepStrictEqual(warnings, []);
    } finally {
      process.off("warning", warned);
      await listening.close();
    }
  });
});
