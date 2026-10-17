import { Binden, type Context, releasedFailure } from "../index.js";
import { HOST, capture, ioTurn, listen, within } from "./helpers.js";
import { suite, test } from "node:test";
import { Readable } from "node:stream";
import { connect } from "node:net";
import { deepStrictEqual } from "node:assert/strict";
import { once } from "node:events";

/** How the release of a source fails (see `source()`) */
type IRelease = "sync" | "tick" | "none";

/**
 * A source whose release fails: its own `destroy()` destroys it with an
 * error of its own (`sync`), or its `_destroy()` fails (`tick`, on the next
 * tick), or neither (`none`)
 */
function source(release: IRelease, failure: Error): Readable {
  return new (class extends Readable {
    public override destroy(error?: Error): this {
      return super.destroy(release === "sync" ? failure : error);
    }
  })({
    read(): void {
      // Pushed by the test
    },
    destroy(error, callback): void {
      callback(release === "tick" ? failure : error);
    },
  });
}

suite("A send whose response closes before the send has settled", () => {
  for (const release of ["sync", "tick", "none"] as const) {
    for (const complete of [false, true]) {
      test(`${complete ? "once its body is complete for the client (its Content-Length)" : "before its body is complete"}, of a source whose release ${release === "none" ? "succeeds" : release === "sync" ? "fails at once (its own destroy())" : "fails on the next tick (its _destroy())"}: ${complete ? "resolves" : "rejects as a premature close"}, then releases the source${release === "none" ? "" : ", whose failure is logged"}`, async () => {
        const captured = capture();
        const failure = new Error(`The release has failed (${release})`);
        const outcome = Promise.withResolvers<unknown>();
        let released: Readable | null = null;
        const app = new Binden({
          logger: captured.logger,
          log_error_details: true,
        }).use(async (context: Context) => {
          const data = source(release, failure);
          released = data;
          if (complete) {
            context.response.setHeader("Content-Length", 1);
          }
          // Commits the headers: a body that waits for more (its end)
          data.push("x");
          outcome.resolve(
            await context.send(data).then(
              () => "resolved",
              (error: unknown) => (error as { code?: unknown }).code,
            ),
          );
        });
        const listening = await listen(app);
        try {
          const socket = connect(listening.port, HOST);
          socket.on("error", () => {
            // Destroyed below
          });
          await within(once(socket, "connect"));
          socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
          let received = "";
          socket.setEncoding("latin1");
          await within(
            new Promise<void>((resolve) => {
              socket.on("data", (chunk: string) => {
                received += chunk;
                // Its chunk (with its framing, or its byte)
                if (/\r\n\r\n(?:1\r\n)?x/u.test(received)) {
                  resolve();
                }
              });
            }),
          );
          socket.destroy();
          deepStrictEqual(
            await within(outcome.promise),
            complete ? "resolved" : "ERR_STREAM_PREMATURE_CLOSE",
          );
          if (release === "none") {
            await ioTurn();
            deepStrictEqual(
              captured.records.filter(({ msg }) => msg === releasedFailure),
              [],
            );
          } else {
            const record = await captured.waitFor(releasedFailure);
            deepStrictEqual(
              [record.level, (record.failure as { message?: unknown }).message],
              [20, failure.message],
            );
          }
          deepStrictEqual((released as Readable | null)?.destroyed, true);
        } finally {
          await listening.close();
        }
      });
    }
  }
});
