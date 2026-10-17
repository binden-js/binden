import { Binden, type Context } from "../index.js";
import { HOST, ioTurn, listen, pollUntil, within } from "./helpers.js";
import {
  type IStreamLikeMethods,
  readStreamLike,
  streamLikeOf,
} from "../src/stream-like.js";
import { suite, test } from "node:test";
import { EventEmitter } from "node:events";
import { connect } from "node:net";
import { createRequire } from "node:module";
import { deepStrictEqual } from "node:assert/strict";

const require = createRequire(import.meta.url);

/** `undefined`, which the linter does not let the tests write */
const none = ({} as { value?: undefined }).value;

/** A stream-like source of its own without `destroy()`, whose calls are recorded */
class Pausable extends EventEmitter {
  public readonly calls: unknown[][] = [];

  public pause(): this {
    this.calls.push(["pause"]);
    return this;
  }

  public resume(): this {
    return this;
  }
}

/** A stream-like source of its own whose calls are recorded */
class Recorded extends Pausable {
  public destroy(...args: unknown[]): this {
    this.calls.push(["destroy", ...args]);
    return this;
  }
}

/** The methods of a stream-like source (see `streamLikeOf()`) */
function methodsOf(source: object): IStreamLikeMethods {
  return streamLikeOf(source) as IStreamLikeMethods;
}

/** The readable of a stream-like source, flowing, and how it ends: `ended`, or its error */
function read(
  source: object,
  logs: unknown[] = [],
): [NodeJS.ReadableStream, Promise<unknown>] {
  const readable = readStreamLike(
    source,
    methodsOf(source),
    () => new Error("Cancelled"),
    (error) => logs.push(error),
    () => null,
    {
      released: (error) => logs.push(error),
      removed: (error) => logs.push(error),
    },
  );
  const outcome = within(
    new Promise((resolve) => {
      readable.once("end", () => {
        resolve("ended");
      });
      readable.once("error", resolve);
    }),
  );
  readable.resume();
  return [readable, outcome];
}

/** The code of an error */
function codeOf(error: unknown): unknown {
  return (error as { code?: unknown }).code;
}

suite(
  "A data event of a stream-like source that is neither a string nor bytes",
  () => {
    for (const [name, chunk] of [
      ["null", null],
      ["undefined", none],
      ["a number", 42],
      ["an object", { not: "bytes" }],
      ["an ArrayBuffer", new ArrayBuffer(3)],
    ] as const) {
      test(`(${name}) fails the readable with a TypeError, never as its end, and destroys the source with it`, async () => {
        const source = new Recorded();
        const [, outcome] = read(source);
        source.emit("data", "first");
        source.emit("data", chunk);
        source.emit("data", "never read");
        source.emit("end");
        const failure = await outcome;
        await ioTurn();
        // Only its guard listens
        deepStrictEqual(
          [
            failure instanceof TypeError,
            codeOf(failure),
            source.calls,
            source.eventNames(),
          ],
          [
            true,
            "ERR_INVALID_ARG_TYPE",
            [["destroy", failure]],
            ["error", "close"],
          ],
        );
      });
    }

    test("strings and bytes (a Buffer, any typed array, a DataView) are sent", async () => {
      const source = new Recorded();
      const [readable, outcome] = read(source);
      const chunks: Buffer[] = [];
      readable.on("data", (chunk: Buffer) => chunks.push(chunk));
      source.emit("data", "a");
      source.emit("data", Buffer.from("b"));
      source.emit("data", new Uint8Array([0x63]));
      source.emit("data", new Uint16Array([0x6464]));
      source.emit("data", new DataView(new Uint8Array([0x65]).buffer));
      source.emit("end");
      deepStrictEqual(
        [await outcome, Buffer.concat(chunks).toString()],
        ["ended", "abcdde"],
      );
    });

    test("sent: the response is cut, never framed complete, and the next request of the connection is not answered", async () => {
      const outcomes: unknown[] = [];
      const app = new Binden()
        .use("/next", (context: Context) => context.send("next"))
        .use(async (context: Context) => {
          const source = new Recorded();
          setImmediate(() => {
            source.emit("data", "abc");
            source.emit("data", null);
            setImmediate(() => {
              source.emit("data", "def");
              source.emit("end");
            });
          });
          outcomes.push(
            await context.send(source).then(
              () => "resolved",
              (error: unknown) => codeOf(error),
            ),
          );
        });
      const listening = await listen(app);
      try {
        const socket = connect(listening.port, HOST);
        let received = "";
        socket.setEncoding("latin1").on("data", (chunk: string) => {
          received += chunk;
        });
        socket.on("error", () => null);
        socket.write(
          "GET / HTTP/1.1\r\nHost: a\r\n\r\nGET /next HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n",
        );
        await within(
          new Promise((resolve) => {
            socket.once("close", resolve);
          }),
        );
        await pollUntil(() => outcomes.length === 1);
        deepStrictEqual(
          [
            outcomes,
            received.endsWith("\r\n3\r\nabc\r\n"),
            received.includes("next"),
          ],
          [["ERR_INVALID_ARG_TYPE"], true, false],
        );
      } finally {
        await listening.close();
      }
    });
  },
);

suite(
  "A stream-like source that emits an error while it is sent, without being destroyed",
  () => {
    test("is released: destroyed without its error, or paused without destroy()", async () => {
      const failure = new Error("I/O failure");
      const destroyable = new Recorded();
      const pausable = new Pausable();
      const outcomes: unknown[] = [];
      for (const source of [destroyable, pausable]) {
        const [, outcome] = read(source);
        source.emit("error", failure);
        outcomes.push(await outcome);
      }
      deepStrictEqual(
        [outcomes, destroyable.calls, pausable.calls],
        [[failure, failure], [["destroy"]], [["pause"]]],
      );
    });

    test("of readable-stream 4 without autoDestroy: destroyed once the send rejects with its error", async () => {
      const { Readable } = require("readable-stream-v4") as {
        Readable: new (options: {
          autoDestroy: boolean;
          read(): void;
        }) => EventEmitter & {
          destroyed: boolean;
          pause(): unknown;
          resume(): unknown;
          push(chunk: string): boolean;
        };
      };
      const outcomes: unknown[] = [];
      const sources: { destroyed: boolean }[] = [];
      const app = new Binden().use(async (context: Context) => {
        const source = new Readable({
          autoDestroy: false,
          read(): void {
            // Nothing to read
          },
        });
        sources.push(source);
        // The application listens
        source.on("error", () => null);
        setImmediate(() => {
          source.push("abc");
          source.emit("error", new Error("I/O failure"));
        });
        outcomes.push(
          await context.send(source).then(
            () => "resolved",
            (error: unknown) => (error as Error).message,
          ),
        );
      });
      const listening = await listen(app);
      try {
        const socket = connect(listening.port, HOST);
        socket.on("error", () => null).resume();
        socket.write("GET / HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n");
        await within(
          new Promise((resolve) => {
            socket.once("close", resolve);
          }),
        );
        await pollUntil(() => outcomes.length === 1);
        deepStrictEqual(
          [outcomes, sources.map(({ destroyed }) => destroyed)],
          [["I/O failure"], [true]],
        );
      } finally {
        await listening.close();
      }
    });

    test("not again once destroyed (by itself, or by the application), nor when its state cannot be read: logged", async () => {
      const logs: unknown[] = [];
      const destroyed = Object.assign(new Recorded(), { destroyed: false });
      const unreadable = new Recorded();
      let reads = 0;
      Object.defineProperty(unreadable, "destroyed", {
        get(): boolean {
          reads += 1;
          if (reads > 1) {
            throw new Error("Its state cannot be read");
          }
          return false;
        },
      });
      const outcomes: unknown[] = [];
      for (const source of [destroyed, unreadable]) {
        const [, outcome] = read(source, logs);
        if (source === destroyed) {
          destroyed.destroyed = true;
        }
        source.emit("error", new Error("Failed"));
        outcomes.push(await outcome);
      }
      await ioTurn();
      deepStrictEqual(
        [
          outcomes.map((error) => (error as Error).message),
          destroyed.calls,
          unreadable.calls,
          logs.map((error) => (error as Error).message),
        ],
        [["Failed", "Failed"], [], [], ["Its state cannot be read"]],
      );
    });
  },
);
