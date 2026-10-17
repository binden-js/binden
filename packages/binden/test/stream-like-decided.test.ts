import {
  Binden,
  type Context,
  type IStreamLike,
  releasedFailure,
} from "../index.js";
import { capture, listen, send, within } from "./helpers.js";
import { deepStrictEqual, ok } from "node:assert/strict";
import { suite, test } from "node:test";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Long enough never to expire on a loaded machine: it only guards against a hang */
const deadline = 10_000;

/** A stream-like source (not a Node.js `Readable`) */
type ISource = EventEmitter & IStreamLike;

/** A `Readable` of `readable-stream` */
type IReadable = new (options: {
  objectMode: boolean;
  read(this: { push(chunk: unknown): boolean }): void;
}) => ISource;

/** The code of an error */
function codeOf(error: unknown): unknown {
  return (error as { code?: unknown }).code;
}

/** The stream-like sources whose only chunk is an object, which a response cannot send */
const sources: readonly (readonly [string, () => ISource])[] = [
  ...(["3", "4"] as const).map(
    (version) =>
      [
        `a Readable of readable-stream ${version}`,
        (): ISource => {
          const { Readable } = require(`readable-stream-v${version}`) as {
            Readable: IReadable;
          };
          return new Readable({
            objectMode: true,
            read(): void {
              this.push({ chunk: "not bytes" });
              this.push(null);
            },
          });
        },
      ] as const,
  ),
  [
    "an emitter whose destroy emits its error and its close on the next turn",
    (): ISource => {
      const source = new EventEmitter();
      let resumed = false;
      return Object.assign(source, {
        pause(): void {
          // Its only chunk comes once
        },
        resume(): void {
          if (!resumed) {
            resumed = true;
            queueMicrotask(() => {
              source.emit("data", { chunk: "not bytes" });
            });
          }
        },
        destroy(error?: Error): void {
          setImmediate(() => {
            source.emit("error", error);
            source.emit("close");
          });
        },
      });
    },
  ],
];

suite("A send of a stream-like source whose chunk is not bytes", () => {
  for (const [name, create] of sources) {
    test(`(${name}) rejects with that error, which is replied, and destroys the source with it: its guard does not log it again`, async () => {
      const captured = capture();
      const source = create();
      const emitted = Promise.withResolvers<unknown>();
      // Once its guard is removed (on the turn after its close)
      const unguarded = Promise.withResolvers<null>();
      source.on("error", emitted.resolve);
      source.on("close", () => {
        setImmediate(() => {
          unguarded.resolve(null);
        });
      });
      const outcome = Promise.withResolvers<unknown>();
      const app = new Binden({ logger: captured.logger }).use(
        async (context: Context) => {
          await context.send(source).then(
            () => {
              outcome.resolve(null);
            },
            (error: unknown) => {
              outcome.resolve(error);
              throw error;
            },
          );
        },
      );
      const listening = await listen(app);
      try {
        const { status } = await send(listening.port, { ms: deadline });
        const failure = await within(outcome.promise, deadline);
        deepStrictEqual(
          [status, codeOf(failure)],
          [500, "ERR_INVALID_ARG_TYPE"],
        );
        // The source is destroyed with it, and emits it
        ok((await within(emitted.promise, deadline)) === failure);
        await within(unguarded.promise, deadline);
        deepStrictEqual(
          captured.records.filter(({ msg }) => msg === releasedFailure),
          [],
        );
      } finally {
        await listening.close();
      }
    });
  }
});
