import { Binden, type Context } from "../index.js";
import { HOST, listen, within } from "./helpers.js";
import { suite, test } from "node:test";
import { PassThrough } from "node:stream";
import { connect } from "node:net";
import { deepStrictEqual } from "node:assert/strict";
import { once } from "node:events";

/** How a send has settled: resolved, or the code (else the message) of its error */
function outcomeOf(sent: Promise<void>): Promise<string> {
  return sent.then(
    () => "resolved",
    (error: unknown) => {
      const { code, message } = error as { code?: unknown; message?: unknown };
      return String(code ?? message);
    },
  );
}

suite("A send of a stream with a declared `Content-Length: 0`", () => {
  test("is complete only once the response has finished: a client that goes away before its head rejects it", async () => {
    const { promise: started, resolve: starts } = Promise.withResolvers<null>();
    const { promise: settled, resolve: settles } =
      Promise.withResolvers<[string, boolean]>();
    const listening = await listen(
      new Binden().use(async (context: Context) => {
        context.response.setHeader("Content-Length", 0);
        // Never ends: nothing is written, not even the head
        const sent = context.send(new PassThrough());
        starts(null);
        settles([await outcomeOf(sent), context.response.headersSent]);
      }),
    );
    try {
      const socket = connect(listening.port, HOST);
      let received = "";
      socket.setEncoding("latin1").on("data", (chunk: string) => {
        received += chunk;
      });
      await once(socket, "connect");
      socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
      await within(started);
      socket.destroy();
      deepStrictEqual(
        [await within(settled), received],
        [["ERR_STREAM_PREMATURE_CLOSE", false], ""],
      );
    } finally {
      await listening.close();
    }
  });

  test("of a stream that ends resolves once its empty reply has finished", async () => {
    const outcomes: string[] = [];
    const listening = await listen(
      new Binden().use(async (context: Context) => {
        context.response.setHeader("Content-Length", 0);
        const source = new PassThrough();
        source.end();
        outcomes.push(await outcomeOf(context.send(source)));
      }),
    );
    try {
      const response = await within(
        fetch(`${listening.url}/`).then(async (reply) => [
          reply.status,
          reply.headers.get("Content-Length"),
          await reply.text(),
        ]),
      );
      deepStrictEqual([response, outcomes], [[200, "0", ""], ["resolved"]]);
    } finally {
      await listening.close();
    }
  });
});
