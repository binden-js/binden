import {
  Binden,
  Context,
  type IFunctionMiddleware,
  ct_json,
  ct_text,
} from "binden";
import { type IBody, Recorder, echo, listen, send } from "./helpers.js";
import { deepStrictEqual, ok } from "node:assert/strict";
import { suite, test } from "node:test";
import { BodyParser } from "../index.js";

/** Sends a request through a parser, with a logger that keeps everything */
async function post(
  parser: BodyParser,
  body: IBody,
  headers: Record<string, string>,
): Promise<[number, Recorder]> {
  const logger = new Recorder();
  const server = await listen(new Binden({ logger }).use(parser, echo));
  try {
    const { status } = await send(server.url, body, headers);
    return [status, logger];
  } finally {
    await server.close();
  }
}

// Invalid JSON: the error of `JSON.parse()` quotes the body
const secret = '{"password": SECRET}';

suite("BodyParser (logging)", () => {
  test("keeps the body out of the logs", async () => {
    for (const parser of [
      new BodyParser(),
      new BodyParser({ parse: (input): unknown => JSON.parse(input) }),
      new BodyParser({
        verify: (decoded): unknown => JSON.parse(decoded.toString()),
      }),
    ]) {
      const [status, logger] = await post(parser, secret, {
        "Content-Type": ct_json,
      });
      ok(status === 400 || status === 500, String(status));
      const output = JSON.stringify(logger.lines);
      ok(logger.lines.length > 0);
      ok(!output.includes("SECRET"), output);
    }
  });

  test("a refusal is logged at `debug`", async () => {
    const [status, logger] = await post(new BodyParser(), secret, {
      "Content-Type": ct_json,
    });
    deepStrictEqual(status, 400);
    ok(logger.messages("debug").includes("The JSON body cannot be parsed"));
    deepStrictEqual(logger.messages("error"), []);
  });

  test("a failure of `type` is logged at `error`", async () => {
    const parser = new BodyParser({ type: (): "raw" => "xml" as "raw" });
    const [status, logger] = await post(parser, "a", {
      "Content-Type": ct_text,
    });
    deepStrictEqual(status, 500);
    ok(
      logger
        .messages("error")
        .includes("The `type` function has returned an invalid kind"),
    );
  });

  test("a body that has already been read is logged at `error`", async () => {
    const logger = new Recorder();
    const app = new Binden({ logger }).use(async (context) => {
      await context.request.toArray();
    }, new BodyParser());
    const server = await listen(app);
    try {
      const reply = await send(server.url, "[]", { "Content-Type": ct_json });
      deepStrictEqual(reply.status, 500);
    } finally {
      await server.close();
    }
    ok(logger.messages("error").includes("The body has already been read"));
  });

  test("a logger of the context whose methods and `child()` are replaced by ones that throw: the parse settles as without them, and none of them runs (a `log` getter that throws, also of a subclass of `Context`, drops the records only)", async () => {
    const calls: string[] = [];
    const methods = ["fatal", "error", "warn", "info", "debug", "trace"];
    class Unlogged extends Context {
      // eslint-disable-next-line class-methods-use-this -- a getter that fails
      public override get log(): Context["log"] {
        calls.push("log");
        throw new Error("No logger");
      }
    }
    const changes: Record<string, IFunctionMiddleware> = {
      replaced: (context) => {
        for (const method of [...methods, "child"]) {
          Object.assign(context.log, {
            [method]: (): never => {
              calls.push(method);
              throw new Error("A replaced method");
            },
          });
        }
      },
      getter: (context) => {
        Object.defineProperty(context, "log", {
          get: (): never => {
            calls.push("log");
            throw new Error("No logger");
          },
        });
      },
      // The next context
      subclass: ({ request, response }) => new Unlogged({ request, response }),
    };
    const outcomes: unknown[] = [];
    for (const [name, change] of Object.entries(changes)) {
      const logger = new Recorder();
      const app = new Binden({ logger }).use(change, new BodyParser(), echo);
      const server = await listen(app);
      try {
        const parsed = await send(server.url, '{"a":1}', {
          "Content-Type": ct_json,
        });
        const refused = await send(server.url, secret, {
          "Content-Type": ct_json,
        });
        const skipped = await send(server.url, "a", {
          "Content-Type": "application/xml",
        });
        outcomes.push([
          name,
          parsed.status,
          parsed.body,
          refused.status,
          skipped.status,
          logger.messages("debug").includes("The JSON body cannot be parsed"),
        ]);
      } finally {
        await server.close();
      }
    }
    deepStrictEqual(outcomes, [
      // Through the private path of the logger of the context
      ["replaced", 200, { type: "json", value: { a: 1 } }, 400, 200, true],
      // Read as the parse starts, as the other properties of the context:
      // what it throws drops the records of the parse (as those of binden
      // through it), never the parse
      ["getter", 200, { type: "json", value: { a: 1 } }, 400, 200, false],
      ["subclass", 200, { type: "json", value: { a: 1 } }, 400, 200, false],
    ]);
    // Only the getter, as the framework and the parser get the logger
    ok(calls.every((call) => call === "log"));
  });
});
