import { converse, framed, serve } from "./helpers.js";
import { deepStrictEqual, ok } from "node:assert/strict";
import { Compression } from "../index.js";
import type { Context } from "binden";
import { join } from "node:path";
import { test } from "node:test";

/** A file that `sendFile()` sends, which the compression compresses */
const file = join(import.meta.dirname, "..", "package.json");

test("a sendFile() that fails once its compressed representation is chosen (its status has become informational) leaves no decision: the reply that follows gets one of its own (H29-3)", async () => {
  let outcome: unknown = null;
  let filtered = 0;
  const served = await serve(
    {},
    new Compression({
      threshold: 100,
      // As the compressed representation of the file is chosen (once its
      // headers are set), its status becomes informational: its send
      // refuses it
      filter: (context: Context): boolean => {
        filtered += 1;
        if (filtered === 1) {
          context.response.statusCode = 103;
        }
        return true;
      },
    }),
    async ({ response }: Context): Promise<void> => {
      outcome = await response.sendFile(file).then(
        () => null,
        (error: unknown) => (error as Error).message,
      );
      response.status(500).type("text/plain").end("err");
    },
  );
  try {
    const responses = await converse(
      served.url,
      "GET / HTTP/1.1\r\nHost: localhost\r\nAccept-Encoding: gzip\r\nConnection: close\r\n\r\n",
    );
    deepStrictEqual(responses.length, 1);
    const [response] = responses as [(typeof responses)[0]];
    ok(response.head.startsWith("http/1.1 500 "), response.head);
    // Below the threshold: as it is
    ok(!response.head.includes("\r\ncontent-encoding:"), response.head);
    deepStrictEqual(framed(response).toString(), "err");
  } finally {
    await served.close();
  }
  deepStrictEqual(
    outcome,
    "Status code 103 is informational (use writeEarlyHints())",
  );
});
