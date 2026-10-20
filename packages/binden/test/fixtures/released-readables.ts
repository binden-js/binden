// Run by `released-readables.test.ts` with `--expose-gc`: once destroyed, the
// readable of a stream-like source (see `readStreamLike()`) holds nothing of
// the response that sends it (its cancellation reason, its logs, and what
// tells that it is left untouched), so that what keeps the readable and its
// source (e.g. a pending report of a late error, see `reportOnce()`) keeps
// nothing of the response. Prints, by case, whether the stand-in of the
// response is collected while the readable and its source are kept.
import {
  type IStreamLikeMethods,
  readStreamLike,
  streamLikeOf,
} from "../../src/stream-like.js";
import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import { queryObjects } from "node:v8";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 20_000).unref();

/** A stream-like source of its own */
class Source extends EventEmitter {
  public pause(): this {
    return this;
  }

  public resume(): this {
    return this;
  }

  public destroy(): this {
    return this;
  }
}

/** Ignores an error (a function of the module, which holds nothing) */
function ignore(): void {
  // The readable fails without anybody to tell
}

/** The stand-in of a response, whose instances are counted */
class Response {
  public response = true;
}

/** A readable and its source, kept */
interface ISent {
  readonly readable: Readable;
  readonly source: Source;
}

/** Reads a source for a stand-in of a response, which only its hooks hold */
function sent(): ISent {
  const response = new Response();
  const source = new Source();
  const readable = readStreamLike(
    source,
    streamLikeOf(source) as IStreamLikeMethods,
    () => new Error(`Cancelled ${String(response.response)}`),
    // The report of a late error holds nothing of the response
    ignore,
    () => {
      Reflect.get(response, "response");
    },
    {
      released: (): void => {
        Reflect.get(response, "response");
      },
      removed: (): void => {
        Reflect.get(response, "response");
      },
    },
  );
  readable.on("error", ignore);
  return { readable, source };
}

/** The ways a readable is destroyed */
const cases: Record<string, (sending: ISent) => void> = {
  cancelled: ({ readable }) => {
    readable.destroy();
  },
  failed: ({ source }) => {
    source.emit("error", new Error("Failed"));
  },
  ended: ({ readable, source }) => {
    readable.resume();
    source.emit("end");
  },
};

const gc = Reflect.get(globalThis, "gc") as () => void;
const lines: string[] = [];
for (const [name, destroy] of Object.entries(cases)) {
  const sending = sent();
  destroy(sending);
  // Its release, then its listener of `error` removed on the next turn
  for (let turn = 0; turn < 3; turn += 1) {
    await new Promise(setImmediate);
  }
  gc();
  await new Promise(setImmediate);
  gc();
  const { readable, source } = sending;
  const left = queryObjects(Response, { format: "count" });
  lines.push(
    `${name} ${String(readable.destroyed)} ${left === 0 ? "collected" : "kept"} ${String(source.listenerCount("error"))}`,
  );
}
process.stdout.write(`${lines.join("\n")}\n`);
