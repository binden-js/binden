// Run by `logger.test.ts`: where the `SonicBoom` class of `pino` cannot be
// resolved (e.g. in a bundle), the copy of `transport` keeps its prototype, by
// which `pino` refuses a `SonicBoom` itself
import { registerHooks } from "node:module";

registerHooks({
  resolve: (specifier, context, next) => {
    // Only from `pino` itself: what `pino` loads resolves as before
    if (
      specifier === "sonic-boom" &&
      context.parentURL?.endsWith("/pino/pino.js") === true
    ) {
      process.stdout.write("unresolved\n");
      throw new Error(`Cannot find module '${specifier}'`);
    }
    return next(specifier, context);
  },
});

const { Logger } = await import("../../index.js");
const { default: pino } = await import("pino");

const sonic = Object.getPrototypeOf(
  pino.destination({ dest: 1, sync: true }),
) as object;
const target = new URL("discard.mjs", import.meta.url).href;
for (const transport of [
  Object.create(sonic) as object,
  Object.assign(Object.create(sonic) as object, { target }),
  { writable: true, target },
  Object.create({ _writableState: {} }) as object,
  { target },
]) {
  try {
    new Logger({ transport: transport as never }).info("discarded");
    process.stdout.write("accepted\n");
  } catch (error: unknown) {
    process.stdout.write(`${(error as Error).message}\n`);
  }
}
