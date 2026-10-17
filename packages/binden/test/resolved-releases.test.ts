import { Binden, type Context } from "../index.js";
import { capture, ioTurn, listen, pollUntil, within } from "./helpers.js";
import { converse, get } from "./connection.js";
import { suite, test } from "node:test";
import type { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { deepStrictEqual } from "node:assert/strict";

const require = createRequire(import.meta.url);

/** A `PassThrough` of `readable-stream` (a stream-like source) */
type IPassThrough = EventEmitter & {
  readonly destroyed: boolean;
  write(chunk: string): unknown;
};

/** The `PassThrough` of `readable-stream` 3 or 4 */
function passThroughOf(version: 3 | 4): IPassThrough {
  const { PassThrough } = require(`readable-stream-v${version}`) as {
    PassThrough: new () => IPassThrough;
  };
  return new PassThrough();
}

/**
 * Sends a stream-like source whose send resolves (`how`), and resolves with
 * what the client gets, how the send has settled, whether the source is
 * destroyed, and the errors that a listener of the application has heard
 */
async function resolvedSend(
  version: 3 | 4,
  how: "ended" | "late chunk" | "length",
): Promise<[string, string, boolean, unknown[]]> {
  const source = passThroughOf(version);
  const heard: unknown[] = [];
  source.on("error", (error: unknown) => {
    heard.push((error as { code?: unknown }).code ?? error);
  });
  const outcome = Promise.withResolvers<string>();
  const app = new Binden({ logger: capture().logger }).use(
    async (context: Context) => {
      if (how === "length") {
        context.response.setHeader("Content-Length", 3);
      }
      // @ts-expect-error -- a stream-like source
      const sent = context.send(source);
      if (how === "length") {
        // Its whole body, before its end: complete for the client
        source.write("abc");
      } else {
        context.response.end("other");
        if (how === "late chunk") {
          // Read once the response has ended: no longer sent
          source.write("abc");
        }
      }
      outcome.resolve(
        await sent.then(
          () => "resolved",
          (error: unknown) => `rejected:${String(error)}`,
        ),
      );
    },
  );
  const listening = await listen(app);
  try {
    const { received } = await converse(listening.port, get("/"), {
      // The client closes once it has the whole response
      complete: (text) => text.endsWith(how === "length" ? "abc" : "other"),
    });
    const settled = await within(outcome.promise);
    await pollUntil(() => source.destroyed);
    await ioTurn();
    const body = /\r\n\r\n(?<body>\w*)$/u.exec(received)?.groups?.body ?? "";
    return [body, settled, source.destroyed, heard];
  } finally {
    await listening.close();
  }
}

suite("A stream-like source whose send resolves", () => {
  for (const version of [3, 4] as const) {
    for (const [how, what] of [
      ["ended", "another writer has ended the response"],
      [
        "late chunk",
        "another writer has ended the response, before a chunk of it",
      ],
      [
        "length",
        "its declared length is complete, and the client closes before its end",
      ],
    ] as const) {
      test(`(\`readable-stream\` ${version}) is destroyed without an error, as a Node.js \`Readable\`: ${what}`, async () => {
        deepStrictEqual(await resolvedSend(version, how), [
          how === "length" ? "abc" : "other",
          "resolved",
          true,
          [],
        ]);
      });
    }
  }
});
