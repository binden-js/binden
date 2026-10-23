import { Binden, type Context } from "../index.js";
import { capture, listen, send } from "./helpers.js";
import { suite, test } from "node:test";
import { EventEmitter } from "node:events";
import { deepStrictEqual } from "node:assert/strict";

suite(
  "A stream-like source that emits a chunk that the readable of its send cannot take",
  () => {
    test("(a view of an `ArrayBuffer` that has been detached): rejects with what its `push()` throws, never thrown into the `data` of the source, which is destroyed with it (R2)", async () => {
      const { logger } = capture();
      const emits: string[] = [];
      const outcomes: string[] = [];
      const destroys: unknown[] = [];
      const app = new Binden({ logger }).use(async (context: Context) => {
        const source = Object.assign(new EventEmitter(), {
          pause(): void {
            // Never full
          },
          resume(): void {
            // Emits by the test
          },
          destroy(error?: Error): void {
            destroys.push(error);
          },
        });
        setImmediate(() => {
          const chunk = new Uint8Array(4);
          chunk.buffer.transfer();
          try {
            source.emit("data", chunk);
            emits.push("returned");
          } catch (error: unknown) {
            emits.push(`threw ${(error as Error).name}`);
          }
          source.emit("end");
        });
        await context.send(source).catch((error: unknown) => {
          const { name } = error as Error;
          outcomes.push(name);
          return context.response.status(500).send("failed");
        });
      });
      const listening = await listen(app);
      try {
        const { status, body } = await send(listening.port);
        deepStrictEqual(
          [
            status,
            body,
            emits,
            outcomes,
            destroys.map((error) => typeof error),
          ],
          [500, "failed", ["returned"], ["TypeError"], ["object"]],
        );
      } finally {
        await listening.close();
      }
    });
  },
);
