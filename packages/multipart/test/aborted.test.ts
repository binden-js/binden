import { BindenAbortError, BindenError, type Context } from "binden";
import { deepEqual, ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { part, serve, sleep, type, upload, within } from "./helpers.js";
import { Multipart } from "../index.js";
import { request as httpRequest } from "node:http";
import { once } from "node:events";

/** What `run()` has settled with */
function outcome(error: unknown): unknown[] {
  ok(error instanceof BindenError);
  const { cause } = error;
  return [
    error.status,
    error.code,
    cause instanceof BindenAbortError ? cause.reason : typeof cause,
  ];
}

describe("Multipart (aborted request)", () => {
  it("rejects once the connection is closed in the middle of a file", async (t) => {
    const { promise: settled, resolve: settle } =
      Promise.withResolvers<unknown>();
    const { promise: started, resolve: start } = Promise.withResolvers<null>();
    const parser = new Multipart();
    const { url } = await serve(t, [
      async (context: Context): Promise<void> => {
        start(null);
        await parser.run(context).then(settle, settle);
      },
    ]);

    const client = httpRequest(url, {
      method: "POST",
      headers: { "Content-Type": type, "Content-Length": 1 << 20 },
    });
    client.on("error", () => {
      // The connection is closed on purpose
    });
    client.write(part('name="file"; filename="file.txt"', "Hello"));
    await within(started);
    await sleep(20);
    client.destroy();

    deepEqual(outcome(await within(settled)), [
      400,
      "aborted",
      "client_closed",
    ]);
  });

  it("stops reading once the deadline has passed", async (t) => {
    const { promise: settled, resolve: settle } =
      Promise.withResolvers<unknown>();
    const parser = new Multipart();
    const { url } = await serve(
      t,
      [
        async (context: Context): Promise<void> => {
          await parser.run(context).catch((error: unknown) => {
            settle(error);
            throw error;
          });
        },
      ],
      { timeout: 100 },
    );

    const reply = await upload(
      url,
      part('name="file"; filename="file.txt"', "Hello"),
    );

    deepEqual(reply, [503, "close"]);
    deepEqual(outcome(await within(settled)), [400, "aborted", "deadline"]);
  });

  it("rejects at once when the request has already been aborted", async (t) => {
    const { promise: settled, resolve: settle } =
      Promise.withResolvers<unknown>();
    const parser = new Multipart();
    const { url } = await serve(
      t,
      [
        async (context: Context): Promise<void> => {
          await once(context.signal, "abort");
          await parser.run(context).then(settle, settle);
        },
      ],
      { timeout: 50 },
    );

    const reply = await upload(url, part('name="a"', "1"));

    deepEqual(reply[0], 503);
    deepEqual(outcome(await within(settled)), [400, "aborted", "deadline"]);
  });
});
