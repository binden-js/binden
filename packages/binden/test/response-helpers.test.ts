/* eslint-disable init-declarations */
import { deepStrictEqual, ok } from "node:assert";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, suite, test } from "node:test";

import { BindenResponse, ct_json } from "../index.js";
import { type ITestServer, listen } from "./http.js";

/** `undefined`, which the linter does not let the tests write */
const none = ({} as { value?: undefined }).value;

/** A response without a connection: nothing is actually sent */
function detached(): BindenResponse {
  return new BindenResponse(new IncomingMessage(new Socket()));
}

suite("BindenResponse helpers", () => {
  let server: ITestServer;

  beforeEach(async () => {
    server = await listen();
  });

  afterEach(async () => {
    await server.close();
  });

  test(".json() (any JSON value)", async () => {
    for (const value of [null, 0, -1.5, "text", true, [1, "2"], { a: [] }]) {
      const handled = server.handle((_request, response) =>
        response.json(value),
      );
      const { headers, body } = await server.request();
      deepStrictEqual(await handled, null);
      deepStrictEqual(headers["content-type"], ct_json);
      deepStrictEqual(JSON.parse(body.toString()), value);
    }
  });

  test(".json() (rejects what has no JSON text before the response)", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const values: [unknown, RegExp][] = [
      [none, /^TypeError: A undefined is not a JSON value$/u],
      [(): number => 1, /^TypeError: A function is not a JSON value$/u],
      [Symbol("s"), /^TypeError: A symbol is not a JSON value$/u],
      [1n, /^TypeError: A bigint is not a JSON value$/u],
      // Nested, by `JSON.stringify()`
      [{ big: 1n }, /^TypeError: Do not know how to serialize a BigInt$/u],
      [cyclic, /^TypeError: Converting circular structure to JSON/u],
      // `toJSON()` without a value
      [{ toJSON: (): undefined => none }, /^TypeError: The JSON text/u],
    ];
    for (const [value, error] of values) {
      const response = detached();
      const sent = await response.json(value).then(
        () => null,
        (reason: unknown) => reason,
      );
      ok(error.test(String(sent)), String(sent));
      // Nothing is set nor started: the error can be replied
      ok(!response.started);
      ok(!response.hasHeader("Content-Type"));
    }
  });

  test(".json() (a custom `stringify` must return a string)", async () => {
    const response = detached();
    const sent = await response
      .json({ a: 1 }, () => 1 as unknown as string)
      .then(
        () => null,
        (reason: unknown) => reason,
      );
    deepStrictEqual(sent, new TypeError("The JSON text is not a string"));
    ok(!response.started);

    // Its own errors, and the values it accepts (e.g. a `bigint`)
    const failing = new Error("stringify");
    const rejected = await detached()
      .json({}, () => {
        throw failing;
      })
      .then(
        () => null,
        (reason: unknown) => reason,
      );
    deepStrictEqual(rejected, failing);

    const handled = server.handle((_request, res) =>
      res.json({ n: 1n }, (data) => `{"n":${String(data.n)}}`),
    );
    const { body } = await server.request();
    deepStrictEqual(await handled, null);
    deepStrictEqual(body.toString(), `{"n":1}`);
  });

  test(".text() and .html() (UTF-8)", async () => {
    const text = server.handle((_request, response) => response.text("😀"));
    const plain = await server.request();
    deepStrictEqual(await text, null);
    deepStrictEqual(plain.headers["content-type"], "text/plain; charset=utf-8");
    deepStrictEqual(plain.body.toString(), "😀");

    const html = server.handle((_request, response) => response.html("<p>"));
    const page = await server.request();
    deepStrictEqual(await html, null);
    deepStrictEqual(page.headers["content-type"], "text/html; charset=utf-8");
    deepStrictEqual(page.body.toString(), "<p>");
  });
});
