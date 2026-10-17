import { type AddressInfo, connect } from "node:net";
import { Binden, type Context } from "binden";
import { PassThrough, Readable } from "node:stream";
import { suite, test } from "node:test";
import { Compression } from "../index.js";
import { capture } from "./helpers.js";
import { deepStrictEqual } from "node:assert/strict";
import { once } from "node:events";

/** The message of a late error of a source that a send no longer reads */
const late = "A stream-like source has failed once released";

/**
 * Writes the requests on one connection to `127.0.0.1`, and reads until the
 * reply of `/next` (`next`) has come in full, or the connection closes,
 * within 10 s (never judged by silence)
 */
async function exchange(
  port: number,
  text: string,
): Promise<{ received: string; closed: boolean }> {
  const socket = connect(port, "127.0.0.1");
  try {
    await once(socket, "connect");
    let received = "";
    const { promise, resolve, reject } = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => {
      reject(new Error(`No end within 10 s: ${received}`));
    }, 10_000);
    socket
      .setEncoding("latin1")
      .on("data", (chunk: string) => {
        received += chunk;
        if (received.endsWith("\r\n\r\nnext")) {
          resolve(false);
        }
      })
      .on("error", () => {
        // Its close follows
      })
      .on("close", () => {
        resolve(true);
      });
    socket.write(text);
    try {
      const closed = await promise;
      return { received, closed };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    socket.destroy();
  }
}

/** A request that accepts no representation (nothing acceptable: `406`) */
const refusing =
  "GET / HTTP/1.1\r\nHost: localhost\r\nAccept-Encoding: identity;q=0, *;q=0\r\n\r\n";

suite(
  "A send whose first chunk makes the compression reply `406 Not Acceptable`",
  () => {
    for (const [how, queued, failing, logged] of [
      // Read again once its first chunk is written: it fails within the turn
      ["fails at once", false, null, 1],
      [
        "fails",
        true,
        (source: Readable): void => {
          source.destroy(new Error("The source has failed"));
        },
        1,
      ],
      [
        "closes",
        true,
        (source: Readable): void => {
          source.destroy();
        },
        0,
      ],
    ] as const) {
      test(`then its source ${how}${queued ? ", while the 406 waits for the response before it" : ""}: the 406 and the next response are sent`, async () => {
        const captured = capture();
        const outcome = Promise.withResolvers<unknown>();
        const failed = Promise.withResolvers<null>();
        const app = new Binden({ logger: captured.logger })
          .use(new Compression({ threshold: 0 }))
          .use(async (context: Context) => {
            const { pathname } = context.url;
            if (pathname === "/next") {
              await context.send("next");
              return;
            } else if (pathname === "/slow") {
              await failed.promise;
              await context.send("slow");
              return;
            }
            let first = true;
            const source =
              failing === null
                ? new Readable({
                    read(): void {
                      if (first) {
                        first = false;
                        this.push("first");
                      } else {
                        this.destroy(new Error("The source has failed"));
                      }
                    },
                  })
                : new PassThrough();
            const sent = context.send(source).then(
              () => "resolved",
              (error: unknown) => error,
            );
            if (failing !== null) {
              // Its first chunk: the compression replaces the response with
              // `406`
              (source as PassThrough).write("first");
              await new Promise(setImmediate);
              failing(source);
            }
            await new Promise(setImmediate);
            const { statusCode, writableEnded } = context.response;
            failed.resolve(null);
            outcome.resolve([statusCode, writableEnded, await sent]);
          });
        const server = app.createServer().listen(0, "127.0.0.1");
        await once(server, "listening");
        try {
          const { port } = server.address() as AddressInfo;
          const { received, closed } = await exchange(
            port,
            `${queued ? "GET /slow HTTP/1.1\r\nHost: localhost\r\n\r\n" : ""}${refusing}GET /next HTTP/1.1\r\nHost: localhost\r\n\r\n`,
          );
          deepStrictEqual(
            [
              received.match(/HTTP\/1\.1 \d{3}/gu),
              closed,
              await outcome.promise,
              captured.records.filter(({ msg }) => msg === late).length,
            ],
            [
              [
                ...(queued ? ["HTTP/1.1 200"] : []),
                "HTTP/1.1 406",
                "HTTP/1.1 200",
              ],
              false,
              [406, true, "resolved"],
              logged,
            ],
          );
        } finally {
          server.closeAllConnections();
          server.close();
          await once(server, "close");
        }
      });
    }
  },
);
