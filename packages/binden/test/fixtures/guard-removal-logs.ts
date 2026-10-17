// Run by `guard-removals.test.ts`: the guard of a source (see `guard()`)
// leaves on the turn after its close, and each removal of its listeners
// throws (a listener of the application of its `removeListener`), and so does
// the logger that logs them (the report, given the message of a removal):
// that must not crash the process from the turn of the guard. Prints the
// listeners of `error` and `close` left on the source.
import { emitterMethods, guard } from "../../src/stream-like.js";
import { Readable } from "node:stream";

setTimeout(() => {
  process.stderr.write("Timed out\n");
  process.exit(2);
}, 10_000).unref();

const source = new Readable({
  read(): void {
    // Never read
  },
});
guard(source, emitterMethods, (_error: unknown, message?: string) => {
  if (typeof message !== "undefined") {
    throw new Error("The logger has failed");
  }
});
source.on("removeListener", () => {
  throw new Error("No removal");
});
source.destroy();
for (let turn = 0; turn < 3; turn += 1) {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}
process.stdout.write(
  `left ${source.listenerCount("error")} ${source.listenerCount("close")}\n`,
);
