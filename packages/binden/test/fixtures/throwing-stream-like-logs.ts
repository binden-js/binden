// Run by `throwing-stream-like-logs.test.ts`: a log of the release of a
// stream-like source that throws (e.g. a logger of the application whose own
// `debug()` throws) must not crash the process from a turn of its own: here,
// the removal of the listener of `error` of the send, deferred to the turn
// after the end of the source, throws, and so does its log. Prints whether
// the readable has ended.
import {
  type IStreamLikeMethods,
  readStreamLike,
  streamLikeOf,
} from "../../src/stream-like.js";
import { EventEmitter } from "node:events";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 10_000).unref();

const source = Object.assign(new EventEmitter(), {
  pause(): void {
    // Never full
  },
  resume(): void {
    // Emits by the fixture
  },
  removeListener(event: string, listener: () => void): unknown {
    EventEmitter.prototype.removeListener.call(source, event, listener);
    if (event === "error") {
      throw new Error("No removal");
    }
    return source;
  },
});
const thrown = (): never => {
  throw new Error("The logger has failed");
};
const readable = readStreamLike(
  source,
  streamLikeOf(source) as IStreamLikeMethods,
  () => new Error("Cancelled"),
  () => null,
  () => null,
  { released: thrown, removed: thrown },
);
readable.resume();
source.emit("end");
for (let turn = 0; turn < 3; turn += 1) {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}
process.stdout.write(`ended ${String(readable.readableEnded)}\n`);
