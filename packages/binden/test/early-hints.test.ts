import { Binden, type Context } from "../index.js";
import { type IListening, listen, sleep, within } from "./helpers.js";
import { deepStrictEqual, ok } from "node:assert/strict";
import { suite, test } from "node:test";
import { Readable } from "node:stream";
import { connect } from "node:net";
import { once } from "node:events";

const hints = { link: "</style.css>; rel=preload; as=style" };
const body = Buffer.from("bytes");

/** A promise with its `resolve()` */
function gate(): { promise: Promise<void>; open(): void } {
  const { promise, resolve } = Promise.withResolvers<never>();
  return { promise, open: resolve as () => void };
}

/**
 * Sends two pipelined requests on one connection, and reads the responses
 * until the server closes it (the second request has `Connection: close`)
 */
async function pipelined(port: number, second: string): Promise<string> {
  const socket = connect(port, "localhost");
  await once(socket, "connect");
  let data = "";
  socket.setEncoding("latin1").on("data", (chunk: string) => {
    data += chunk;
  });
  socket.write(
    `GET /first HTTP/1.1\r\nHost: a\r\n\r\nGET ${second} HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n`,
  );
  await within(once(socket, "close"), 5000);
  return data;
}

suite("Informational responses of a pipelined request", () => {
  // The first request replies once the second has replied: the response of
  // the second (with its `103 Early Hints`) is queued until then
  const replied = { current: gate() };
  const replies: Partial<Record<string, (context: Context) => unknown>> = {
    "/send": (context) => context.send(body),
    "/write-head": ({ response }) => {
      response.writeHead(200, { "Content-Length": body.length }).end(body);
    },
    "/write": ({ response }) => {
      response.setHeader("Content-Length", body.length);
      response.write(new Uint8Array(body), "utf8", () => {
        response.end();
      });
    },
    "/end": ({ response }) => {
      response.setHeader("Content-Length", body.length);
      response.end(body, () => {
        // Ended
      });
    },
    "/stream": (context) =>
      context
        .setHeader("Content-Length", body.length)
        .send(Readable.from([body])),
    "/file": async (context) => {
      await context.response.sendFile(import.meta.filename, {
        content_type: "text/plain",
      });
    },
  };

  const withApp = async (
    fn: (listening: IListening) => Promise<void>,
  ): Promise<void> => {
    const app = new Binden({ timeout: 100 }).use(async (context: Context) => {
      const { pathname } = context.url;
      if (pathname === "/first") {
        // Without a deadline: it waits for the second one
        context.setTimeout(0);
        await replied.current.promise;
        await sleep(20);
        await context.send("first");
        return;
      } else if (pathname === "/delayed") {
        context.response.writeEarlyHints(hints);
        // Its first chunk never comes: the deadline cancels the send
        await context.send(
          new Readable({
            read(): void {
              // Nothing
            },
          }),
        );
        return;
      }
      // Ended by its reply, not by the deadline
      context.setTimeout(0);
      context.response.writeEarlyHints(hints);
      const reply = replies[pathname]?.(context);
      replied.current.open();
      await reply;
    });
    const listening = await listen(app);
    try {
      await fn(listening);
    } finally {
      await listening.close();
    }
  };

  test("are sent before the response, also when its body is bytes", async () => {
    await withApp(async ({ port }) => {
      for (const path of Object.keys(replies)) {
        replied.current = gate();
        const data = await pipelined(port, path);
        const [first = "", early = "", second = ""] =
          data.split(/(?=HTTP\/1\.1 )/u);
        ok(first.startsWith("HTTP/1.1 200 OK\r\n"), `${path}: ${data}`);
        ok(first.endsWith("\r\n\r\nfirst"), `${path}: ${first}`);
        deepStrictEqual(
          early,
          `HTTP/1.1 103 Early Hints\r\nLink: ${hints.link}\r\n\r\n`,
          path,
        );
        ok(second.startsWith("HTTP/1.1 200 OK\r\n"), `${path}: ${second}`);
        if (path === "/file") {
          ok(second.includes('suite("Informational responses'), path);
        } else {
          ok(
            second.endsWith(`\r\n\r\n${body.toString()}`),
            `${path}: ${second}`,
          );
        }
      }
    });
  });

  test("a send whose first chunk is late is still cancelled by the deadline", async () => {
    await withApp(async ({ port }) => {
      // The first request replies once the deadline has passed
      replied.current = gate();
      setTimeout(() => {
        replied.current.open();
      }, 150);
      const data = await pipelined(port, "/delayed");
      const [, early = "", second = ""] = data.split(/(?=HTTP\/1\.1 )/u);
      deepStrictEqual(
        early,
        `HTTP/1.1 103 Early Hints\r\nLink: ${hints.link}\r\n\r\n`,
      );
      ok(second.startsWith("HTTP/1.1 503 "), second);
    });
  });
});

suite("Informational responses to HTTP/1.0", () => {
  /** The raw response of one request of `version` (read until the server closes) */
  async function raw(port: number, version: string): Promise<string> {
    const socket = connect(port, "localhost");
    await once(socket, "connect");
    let data = "";
    socket.setEncoding("latin1").on("data", (chunk: string) => {
      data += chunk;
    });
    socket.write(
      `GET / HTTP/${version}\r\nHost: a\r\nConnection: close\r\n\r\n`,
    );
    await within(once(socket, "close"), 5000);
    return data;
  }

  test("an HTTP/1.0 client never gets an informational response (RFC 9110, 15.2)", async () => {
    const callbacks: string[] = [];
    const app = new Binden().use(async ({ response }: Context) => {
      response.writeContinue(() => callbacks.push("continue"));
      response.writeProcessing(() => callbacks.push("processing"));
      response.writeEarlyHints(hints, () => callbacks.push("hints"));
      await new Promise<null>((resolve) => {
        response.end("final", () => {
          resolve(null);
        });
      });
    });
    const listening = await listen(app);
    try {
      const old = await raw(listening.port, "1.0");
      ok(old.startsWith("HTTP/1.1 200 OK\r\n"), old);
      ok(!/HTTP\/1\.1 1\d\d /u.test(old), old);
      ok(old.endsWith("final"), old);
      // Ignored, but each callback is called once
      deepStrictEqual(callbacks.toSorted(), [
        "continue",
        "hints",
        "processing",
      ]);

      callbacks.length = 0;
      const current = await raw(listening.port, "1.1");
      ok(current.startsWith("HTTP/1.1 100 Continue\r\n"), current);
      ok(current.includes("HTTP/1.1 102 Processing\r\n"), current);
      ok(current.includes("HTTP/1.1 103 Early Hints\r\n"), current);
    } finally {
      await listening.close();
    }
  });
});
