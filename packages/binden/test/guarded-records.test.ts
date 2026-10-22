import {
  Binden,
  BindenRequest,
  BindenResponse,
  Context,
  type IOwnership,
  Middleware,
  releasedFailure,
} from "../index.js";
import { capture, ioTurn, listen, send } from "./helpers.js";
import { converse, get } from "./connection.js";
import { deepStrictEqual, ok } from "node:assert/strict";
import { kOwnership, owners } from "../src/seal.js";
import { suite, test } from "node:test";
import type { ILogger } from "@binden/logger";
import { Readable } from "node:stream";
import { Socket } from "node:net";

/** The methods (and `child()`) of a logger */
const methods = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "child",
] as const;

/** Replaces the methods (and `child()`) of a logger with ones that count their calls and throw */
function replace(logger: ILogger, calls: string[]): void {
  for (const method of methods) {
    Object.assign(logger, {
      [method]: (): never => {
        calls.push(method);
        throw new Error("A replaced method");
      },
    });
  }
}

suite(
  "The records of binden cannot be broken by the application (R29-C1)",
  () => {
    test("a late error is logged by the private path of a logger of binden whose methods and `child()` have been replaced since", async () => {
      const captured = capture();
      const message = new BindenRequest(new Socket());
      // A logger of binden over the captured one
      const logger = new Context({
        request: message,
        response: new BindenResponse(message),
        logger: captured.logger,
      }).log;
      const failure = new Error("The source has failed before its send");
      const app = new Binden({ logger, log_error_details: true }).use(
        async (context: Context) => {
          if (context.url.pathname === "/next") {
            await context.text("next");
            return;
          }
          const source = new Readable({
            read(): void {
              // Never read
            },
          });
          source.destroy(failure);
          // Ends the response once `send()` reads it: its error is emitted, and
          // reported late, once the send has settled
          Object.defineProperty(source, "destroyed", {
            get(): boolean {
              context.response.end("complete");
              return true;
            },
          });
          await context.send(source);
        },
      );
      const calls: string[] = [];
      replace(logger, calls);
      const listening = await listen(app);
      try {
        const { received } = await converse(
          listening.port,
          `${get("/")}${get("/next")}`,
          { complete: (text) => text.endsWith("\r\n\r\nnext") },
        );
        await ioTurn();
        deepStrictEqual(
          [
            received.match(/\r\n\r\n(?:complete|next)/gu),
            captured.records
              .filter(({ msg }) => msg === releasedFailure)
              .map(
                ({ failure: logged }) =>
                  (logged as { message?: unknown }).message,
              ),
          ],
          [["\r\n\r\ncomplete", "\r\n\r\nnext"], [failure.message]],
        );
        deepStrictEqual(calls, []);
      } finally {
        await listening.close();
      }
    });

    test("the handlers of the ownership, the report of a cleanup and the failure of a pipe of the stack once it has failed log by the private path: the methods replaced on `context.log` never run", async () => {
      const captured = capture();
      const prototype = BindenResponse.prototype as unknown as Record<
        typeof kOwnership,
        (ownership: IOwnership) => void
      >;
      const install = prototype[kOwnership];
      let ownership: IOwnership | null = null;
      // The handlers that the application installs on its responses
      prototype[kOwnership] = function installed(
        this: BindenResponse,
        given: IOwnership,
      ): void {
        ownership = given;
        Reflect.apply(install, this, [given]);
      };
      const calls: string[] = [];
      let stack: unknown = null;
      const app = new Binden({
        logger: captured.logger,
        error_handler: async (context: Context): Promise<void> => {
          // A pipe of the stack fails once the error handler runs
          ok(
            ownership?.fail(stack as object, new Error("A late pipe")) === true,
          );
          await context.status(418).send("handled");
        },
      }).use((context: Context) => {
        replace(context.log, calls);
        context.onCleanup(() => {
          throw new Error("A failing cleanup");
        });
        const handlers = ownership as unknown as IOwnership;
        handlers.warn("A warning", "a reason");
        handlers.note("A note", "a reason");
        handlers.debug("A failure", new Error("A failure"));
        stack = owners.getStore();
        throw new Error("A failure of the stack");
      });
      const listening = await listen(app);
      try {
        const { status, body } = await send(listening.port);
        await captured.waitFor("A cleanup of the request has failed");
        const logged = captured.records.map(({ msg }) => msg);
        deepStrictEqual(
          [
            status,
            body,
            [
              "A warning",
              "A note",
              "A failure",
              "A pipe of the stack has failed once it had failed",
              "A cleanup of the request has failed",
            ].filter((message) => !logged.includes(message)),
            calls,
          ],
          [418, "handled", [], []],
        );
      } finally {
        prototype[kOwnership] = install;
        await listening.close();
      }
    });

    test("a middleware that ignores its errors is passed once getting the logger of its context throws", async () => {
      class Failing extends Middleware {
        // eslint-disable-next-line class-methods-use-this -- a middleware that fails
        public run(): never {
          throw new Error("An ignored failure");
        }
      }
      const app = new Binden().use(
        (context: Context) => {
          Object.defineProperty(context, "log", {
            get: (): never => {
              throw new Error("No logger");
            },
          });
        },
        new Failing({ ignore_errors: true }),
        (context: Context) => context.send("passed"),
      );
      const listening = await listen(app);
      try {
        const { status, body } = await send(listening.port);
        deepStrictEqual([status, body], [200, "passed"]);
      } finally {
        await listening.close();
      }
    });

    test("a middleware that returns an object derived from a context, or a proxy of one, keeps the context, told by its brand", async () => {
      const app = new Binden().use(
        (context: Context) => {
          if (context.url.pathname === "/derived") {
            return Object.create(context) as Context;
          }
          return new Proxy(context, {});
        },
        (context: Context) => context.send("kept"),
      );
      const listening = await listen(app);
      try {
        const { received } = await converse(
          listening.port,
          `${get("/derived")}${get("/proxy")}`,
          { complete: (text) => text.split("\r\n\r\nkept").length === 3 },
        );
        deepStrictEqual(received.match(/HTTP\/1\.1 \d+/gu), [
          "HTTP/1.1 200",
          "HTTP/1.1 200",
        ]);
      } finally {
        await listening.close();
      }
    });
  },
);
