import { BindenRequest, type Context } from "binden";
import { deepStrictEqual, ok } from "node:assert/strict";
import { suite, test } from "node:test";
import { BodyParser } from "../index.js";
import { Socket } from "node:net";

/** An error of the application's own (e.g. of a getter, or of a trap) */
class OwnError extends Error {}

/** What a call has thrown (or rejected with), and whether it was formatted then */
interface IOutcome {
  readonly thrown: unknown;
  readonly formatted: boolean;
}

/**
 * Runs a call while `Error.prepareStackTrace` records each error whose stack
 * V8 formats: what it throws (or its promise rejects with), and whether that
 * was formatted before the caller got it (`null` when it does not fail)
 */
async function outcome(run: () => unknown): Promise<IOutcome | null> {
  const formatted = new WeakSet<object>();
  const previous: unknown = Reflect.get(Error, "prepareStackTrace");
  Reflect.set(Error, "prepareStackTrace", (error: Error): string => {
    formatted.add(error);
    return `${error.name}: ${error.message}`;
  });
  try {
    await run();
    return null;
  } catch (thrown: unknown) {
    return {
      thrown,
      formatted: typeof thrown === "object" && formatted.has(thrown as object),
    };
  } finally {
    Reflect.set(Error, "prepareStackTrace", previous);
  }
}

/** A revoked proxy */
function revoked(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

/** A logger that logs nothing */
const silent = {
  fatal: (): null => null,
  error: (): null => null,
  warn: (): null => null,
  info: (): null => null,
  debug: (): null => null,
  trace: (): null => null,
  child: (): unknown => silent,
};

suite(
  "The entry points of the body parser format what they throw (round 27)",
  () => {
    test("new BodyParser(): anything but an object is refused, and what reading the options throws is formatted", async () => {
      for (const [options, message] of [
        [null, "`options` is not an object: null"],
        ["json", "`options` is not an object: json"],
        [Symbol("s"), "`options` is not an object: (a symbol)"],
      ] as const) {
        const failed = await outcome(() => new BodyParser(options as never));
        ok(failed?.thrown instanceof TypeError);
        deepStrictEqual(
          [failed.thrown.message, failed.formatted],
          [message, true],
        );
      }
      const failed = await outcome(() => new BodyParser(revoked()));
      ok(failed?.thrown instanceof TypeError);
      ok(failed.formatted);
      for (const make of [
        (own: Error): object => ({
          get limit(): number {
            throw own;
          },
        }),
        // Read by the validation of `type`
        (own: Error): object => ({
          type: new Proxy([], {
            get(): never {
              throw own;
            },
          }),
        }),
      ]) {
        const own = new OwnError("own");
        deepStrictEqual(
          await outcome(() => new BodyParser(make(own) as never)),
          { thrown: own, formatted: true },
        );
      }
    });

    test("an entry of `type` that is not a string is described without converting it", async () => {
      let conversions = 0;
      const entry = {
        toString(): string {
          conversions += 1;
          return "application/json";
        },
      };
      const failed = await outcome(
        () => new BodyParser({ type: [entry as unknown as string] }),
      );
      ok(failed?.thrown instanceof TypeError);
      deepStrictEqual(
        [failed.thrown.message, failed.formatted, conversions],
        ["Invalid media type in `type`: (an object)", true, 0],
      );
    });

    test("run() formats what reading its context throws, also what Node.js throws for what it gives (e.g. its signal)", async () => {
      const request = new BindenRequest(new Socket());
      request.method = "POST";
      request.headers = { "content-type": "application/json" };
      const signalless = {
        request,
        response: { headersSent: false, writableFinished: false },
        signal: "not a signal",
        log: silent,
      };
      for (const context of [null, revoked(), {}, signalless]) {
        const failed = await outcome(() =>
          new BodyParser().run(context as unknown as Context),
        );
        ok(failed?.thrown instanceof TypeError);
        ok(failed.formatted);
      }
    });
  },
);
