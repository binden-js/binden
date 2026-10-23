import { Binden, type Context } from "../index.js";
import { listen, send, within } from "./helpers.js";
import { suite, test } from "node:test";
import { Readable } from "node:stream";
import { deepStrictEqual } from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** How a send has settled, and the reply that the client gets */
interface ISent {
  readonly status: number;
  readonly length: unknown;
  readonly body: string;
  readonly outcome: string;
  /** Whether the headers were sent once it has rejected (`null`: it has resolved) */
  readonly committed: boolean | null;
}

/**
 * Replies one request by `send()` of `data`, then (once it has rejected) by
 * `500 replied`: the reply that the client gets, and how the send has
 * settled (what it has rejected with is given to `failed`)
 */
async function sending(
  data: unknown,
  failed: (error: unknown) => void = (): void => {
    // Only described
  },
): Promise<ISent> {
  const outcome = Promise.withResolvers<[string, boolean | null]>();
  const app = new Binden().use(async (context: Context) => {
    try {
      await context.send(data as Uint8Array);
      outcome.resolve(["resolved", null]);
    } catch (error: unknown) {
      failed(error);
      outcome.resolve([
        `${(error as Error).constructor.name}: ${(error as Error).message}`,
        context.response.headersSent,
      ]);
      await context.response.status(500).send("replied");
    }
  });
  const listening = await listen(app);
  try {
    const { status, headers, body } = await send(listening.port);
    const [settled, committed] = await within(outcome.promise);
    return {
      status,
      length: headers["content-length"],
      body,
      outcome: settled,
      committed,
    };
  } finally {
    await listening.close();
  }
}

/**
 * Defines getters of the application on a view (or its prototype) that
 * count their reads (`reads`) and return the values given
 */
function lying(
  target: object,
  values: Readonly<Record<string, unknown>>,
  reads: { count: number },
): void {
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(target, key, {
      configurable: true,
      get(): unknown {
        reads.count += 1;
        return typeof value === "function" ? (value as () => unknown)() : value;
      },
    });
  }
}

/** An `ArrayBuffer` that has been detached (transferred) */
function detachedBuffer(): ArrayBuffer {
  const buffer = new ArrayBuffer(8);
  buffer.transfer();
  return buffer;
}

/**
 * Runs `run` while `Error.prepareStackTrace` records each error whose stack
 * V8 formats (once it is first read): what it resolves with, and the errors
 * formatted meanwhile
 */
async function recording<T>(
  run: () => Promise<T>,
): Promise<[T, WeakSet<object>]> {
  const previous: unknown = Reflect.get(Error, "prepareStackTrace");
  const formatted = new WeakSet<object>();
  Reflect.set(
    Error,
    "prepareStackTrace",
    (error: Error, frames: readonly unknown[]): string => {
      formatted.add(error);
      return [String(error), ...frames.map(String)].join("\n    at ");
    },
  );
  try {
    return [await run(), formatted];
  } finally {
    Reflect.set(Error, "prepareStackTrace", previous);
  }
}

/**
 * Runs `fixtures/view-getters.ts` in a process of its own, without a handler
 * of the process: a crash is its exit code and output
 */
function piped(mode: string): Record<string, unknown> {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--import",
      "tsx",
      join(import.meta.dirname, "fixtures", "view-getters.ts"),
      mode,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  return { status, stdout, stderr };
}

suite(
  "A view is read by the getters of the engine only, and binden writes a Buffer of its own (R25-C1, R1 F1)",
  () => {
    test("given to send(): a subclass whose buffer, byteOffset and byteLength getters lie is sent as its bytes, none of its getters read", async () => {
      class Lying extends Uint8Array {}
      const reads = { count: 0 };
      lying(
        Lying.prototype,
        { buffer: detachedBuffer, byteOffset: 99, byteLength: 99 },
        reads,
      );
      deepStrictEqual(
        [await sending(new Lying([0x6f, 0x6b])), reads.count],
        [
          {
            status: 200,
            length: "2",
            body: "ok",
            outcome: "resolved",
            committed: null,
          },
          0,
        ],
      );
    });

    test("given to send(): a view of a detached ArrayBuffer whose own getters tell another one is refused (a TypeError of binden), before anything is changed", async () => {
      const bytes = new Uint8Array(2);
      bytes.buffer.transfer();
      const reads = { count: 0 };
      lying(
        bytes,
        {
          buffer: new Uint8Array([0x6f, 0x6b]).buffer,
          byteOffset: 0,
          byteLength: 2,
        },
        reads,
      );
      deepStrictEqual(
        [await sending(bytes), reads.count],
        [
          {
            status: 500,
            length: "7",
            body: "replied",
            outcome: "TypeError: The data is a view of a detached ArrayBuffer",
            committed: false,
          },
          0,
        ],
      );
    });

    test("given to send(): a view of a detached ArrayBuffer that is not a Uint8Array (a Float64Array, a DataView) is refused as detached, and a DataView out of the bounds of a resizable ArrayBuffer that has shrunk as out of bounds (TypeErrors of binden, formatted once created), before anything is changed; any other such view as any other object", async () => {
      const floats = new Float64Array(1);
      floats.buffer.transfer();
      const detached = new ArrayBuffer(2);
      const view = new DataView(detached);
      detached.transfer();
      const resizable = new ArrayBuffer(4, { maxByteLength: 4 });
      const outside = new DataView(resizable, 2);
      resizable.resize(1);
      const failures: unknown[] = [];
      const [sent, formatted] = await recording(async () => {
        const replies: string[] = [];
        for (const data of [floats, view, outside, new Float64Array(1)]) {
          const { status, body, outcome, committed } = await sending(
            data,
            (error) => failures.push(error),
          );
          replies.push(`${status} ${body} ${String(committed)} ${outcome}`);
        }
        return replies;
      });
      // Nothing else reads their stacks (nothing has been sent)
      deepStrictEqual(
        failures.map((error) => formatted.has(Object(error) as object)),
        [true, true, true, true],
      );
      deepStrictEqual(sent, [
        "500 replied false TypeError: The data is a view of a detached ArrayBuffer",
        "500 replied false TypeError: The data is a view of a detached ArrayBuffer",
        "500 replied false TypeError: The data is a view out of the bounds of its ArrayBuffer",
        "500 replied false TypeError: The data is not a string, a number, a Buffer, a Uint8Array, a Readable nor a stream-like source (with on(), pause(), resume(), and removeListener() or off())",
      ]);
    });

    test("given to send(): a view whose own byteLength getter would detach its buffer, or whose ArrayBuffer has a byteLength getter of its own that would detach it, is sent as its bytes, neither getter read", async () => {
      const reads = { count: 0 };
      const own = new Uint8Array([0x6f, 0x6b]);
      lying(
        own,
        {
          byteLength: (): number => {
            own.buffer.transfer();
            return 0;
          },
        },
        reads,
      );
      const { buffer } = new Uint8Array([0x6f, 0x6b]);
      lying(
        buffer,
        {
          byteLength: (): number => {
            buffer.transfer();
            return 2;
          },
        },
        reads,
      );
      const sent = [await sending(own), await sending(new Uint8Array(buffer))];
      deepStrictEqual(
        [sent.map(({ status, body }) => [status, body]), reads.count],
        [
          [
            [200, "ok"],
            [200, "ok"],
          ],
          0,
        ],
      );
    });

    test("given to send(): a typed array out of the bounds of a resizable ArrayBuffer that has shrunk has no bytes, as the engine tells", async () => {
      const buffer = new ArrayBuffer(4, { maxByteLength: 4 });
      const bytes = new Uint8Array(buffer, 2, 2);
      buffer.resize(1);
      deepStrictEqual(await sending(bytes), {
        status: 200,
        length: "0",
        body: "",
        outcome: "resolved",
        committed: null,
      });
    });

    test("a chunk of a Readable that is a view but not a Uint8Array (a DataView, a Uint16Array) is written as its bytes", async () => {
      const bytes = new Uint8Array([0x6f, 0x6b, 0x21, 0x21]).buffer;
      const { status, body, outcome } = await sending(
        Readable.from([new DataView(bytes, 0, 2), new Uint16Array(bytes, 2)], {
          objectMode: true,
        }),
      );
      deepStrictEqual([status, body, outcome], [200, "ok!!", "resolved"]);
    });

    test("the first chunk of a Readable that is a DataView out of the bounds of a resizable ArrayBuffer that has shrunk: the send rejects with a TypeError of binden before the headers are committed, and the work replies", async () => {
      const buffer = new ArrayBuffer(4, { maxByteLength: 4 });
      const view = new DataView(buffer, 2);
      buffer.resize(1);
      deepStrictEqual(
        await sending(Readable.from([view], { objectMode: true })),
        {
          status: 500,
          length: "7",
          body: "replied",
          outcome:
            "TypeError: The data is a view out of the bounds of its ArrayBuffer",
          committed: false,
        },
      );
    });

    test("a chunk of a Readable whose own byteLength getter would detach its buffer once a chunk is written, or a first chunk of a subclass whose getters lie, is written as its bytes, none of its getters read, without a crash", () => {
      for (const [mode, body] of [
        ["detaching", "starta"],
        ["lying", "ok"],
      ]) {
        deepStrictEqual(
          piped(String(mode)),
          {
            status: 0,
            stdout: `${JSON.stringify({ send: "resolved", reads: 0, body, second: "second" })}\n`,
            stderr: "",
          },
          mode,
        );
      }
    });
  },
);
