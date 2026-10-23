import { BindenError, type Context, ct_json, ct_text } from "binden";
import { BodyParser, type IVerify, type IVerifyInfo } from "../index.js";
import { type IBody, type IReply, send, serve } from "./helpers.js";
import { createHmac, timingSafeEqual } from "node:crypto";
import { deepStrictEqual, ok } from "node:assert/strict";
import { suite, test } from "node:test";
import { gzipSync } from "node:zlib";

/** Sends one request through the parser (then `echo`) */
async function post(
  parser: BodyParser,
  body: IBody,
  headers: Record<string, string> = {},
): Promise<IReply> {
  const server = await serve(parser);
  try {
    return await send(server.url, body, {
      "Content-Type": ct_json,
      ...headers,
    });
  } finally {
    await server.close();
  }
}

interface ICall {
  decoded: string;
  context: boolean;
  encoded: string | null;
}

/** A `verify` that records its calls */
function recorder(calls: ICall[]): IVerify {
  return (decoded: Buffer, context: Context, info: IVerifyInfo): void => {
    calls.push({
      decoded: decoded.toString("hex"),
      context: typeof context.request.method === "string",
      encoded: info.encoded === null ? null : info.encoded.toString("hex"),
    });
  };
}

const hex = (input: Buffer | string): string =>
  Buffer.from(input).toString("hex");

suite("BodyParser (verify)", () => {
  test("`verify` gets the decoded body and the context", async () => {
    const calls: ICall[] = [];
    const parser = new BodyParser({ verify: recorder(calls) });
    const body = gzipSync("[1]");
    deepStrictEqual(
      (await post(parser, body, { "Content-Encoding": "gzip" })).body,
      { type: "json", value: [1] },
    );
    deepStrictEqual(calls, [
      { decoded: hex("[1]"), context: true, encoded: null },
    ]);
  });

  test("`verify_encoded`: the body as received too", async () => {
    const calls: ICall[] = [];
    const parser = new BodyParser({
      verify: recorder(calls),
      verify_encoded: true,
    });
    const body = gzipSync("[1]");
    deepStrictEqual(
      (await post(parser, body, { "Content-Encoding": "gzip" })).status,
      200,
    );
    // Without codings, both are the same
    deepStrictEqual((await post(parser, "[2]")).status, 200);
    deepStrictEqual(calls, [
      { decoded: hex("[1]"), context: true, encoded: hex(body) },
      { decoded: hex("[2]"), context: true, encoded: hex("[2]") },
    ]);
  });

  test("`verify` checks an empty body too", async () => {
    const calls: ICall[] = [];
    const parser = new BodyParser({
      verify: recorder(calls),
      verify_encoded: true,
    });
    deepStrictEqual((await post(parser, "")).body, { type: "undefined" });
    deepStrictEqual(
      (await post(parser, "", { "Content-Type": ct_text })).body,
      {
        type: "text",
        value: "",
      },
    );
    deepStrictEqual(calls, [
      { decoded: "", context: true, encoded: "" },
      { decoded: "", context: true, encoded: "" },
    ]);
  });

  test("the failures of `verify`", async () => {
    const unauthorized = (): never => {
      throw new BindenError(401);
    };
    const failure = (): never => {
      throw new Error("A failure");
    };
    const statuses: [IVerify, number][] = [
      [unauthorized, 401],
      [(): Promise<never> => Promise.reject(new BindenError(403)), 403],
      [failure, 500],
      [(): Promise<never> => Promise.reject(new TypeError("A failure")), 500],
      // Its result does not matter
      [(): boolean => false, 200],
      [(): Promise<boolean> => Promise.resolve(false), 200],
    ];
    for (const [verify, status] of statuses) {
      const parser = new BodyParser({ verify });
      deepStrictEqual((await post(parser, "[]")).status, status);
    }
  });

  test("`verify` comes before the charset and `parse`", async () => {
    const order: string[] = [];
    const parser = new BodyParser({
      verify: (): never => {
        order.push("verify");
        throw new BindenError(403);
      },
      parse: (input: string): unknown => {
        order.push("parse");
        return input;
      },
    });
    // Not valid UTF-8
    deepStrictEqual(
      (
        await post(parser, Buffer.from([0x7b, 0xff, 0x7d]), {
          "Content-Type": ct_text,
        })
      ).status,
      403,
    );
    deepStrictEqual((await post(parser, "[]")).status, 403);
    deepStrictEqual(order, ["verify", "verify"]);
  });

  test("`verify` does not check a refused body or one that is not selected", async () => {
    const calls: ICall[] = [];
    const parser = new BodyParser({
      verify: recorder(calls),
      encoded_limit: 2,
    });
    deepStrictEqual((await post(parser, "[1]")).status, 413);
    deepStrictEqual(
      (await post(parser, "[1]", { "Content-Type": "image/png" })).body,
      { type: "undefined" },
    );
    deepStrictEqual(calls, []);
  });

  test("a webhook signature", async () => {
    const secret = "secret";
    const parser = new BodyParser({
      verify: (decoded, context): void => {
        const signature = context.request.headers["x-signature"];
        const expected = createHmac("sha256", secret).update(decoded).digest();
        const given = Buffer.from(
          typeof signature === "string" ? signature : "",
          "hex",
        );
        if (
          given.length !== expected.length ||
          !timingSafeEqual(given, expected)
        ) {
          throw new BindenError(401);
        }
      },
    });
    const body = '{"event":"paid"}';
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    const signed = await post(parser, gzipSync(body), {
      "Content-Encoding": "gzip",
      "X-Signature": signature,
    });
    deepStrictEqual(signed.body, { type: "json", value: { event: "paid" } });
    const forged = await post(parser, body, { "X-Signature": "00" });
    deepStrictEqual(forged.status, 401);
    ok(signature.length > 0);
  });
});
