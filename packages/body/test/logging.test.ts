import { deepStrictEqual, ok } from "node:assert/strict";
import { suite, test } from "node:test";
import { Binden, ct_json, ct_text } from "binden";

import { BodyParser } from "../index.js";
import { type IBody, Recorder, echo, listen, send } from "./helpers.js";

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
});
