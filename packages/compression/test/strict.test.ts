import { type AddressInfo, connect } from "node:net";
import {
  type ICaptured,
  type IServed,
  capture,
  ioTurn,
  pollUntil,
  serve,
  sleep,
  within,
} from "./helpers.js";
import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from "node:http";
import { afterEach, suite, test } from "node:test";
import { deepStrictEqual, ok, rejects } from "node:assert/strict";
import { Compression } from "../index.js";
import type { Context } from "binden";
import { once } from "node:events";

/** What a client has read of a connection until the server closed it (or until it was idle) */
interface IConversation {
  readonly data: string;
  readonly closed: boolean;
}

/**
 * Writes requests on one connection, and reads every byte until the server
 * closes it, or until nothing comes for `idle` milliseconds (judged after a
 * turn of the pending I/O, see `ioTurn()`: after a stall of the process, its
 * timer runs before the data, or the close, that has come meanwhile is seen;
 * once the end of the connection has been read, its `close` itself decides)
 */
async function talk(
  port: number,
  requests: string,
  idle = 300,
): Promise<IConversation> {
  const socket = connect(port, "127.0.0.1");
  await once(socket, "connect");
  let data = "";
  const { promise: quiet, resolve } = Promise.withResolvers<boolean>();
  const expire = (): void => {
    const seen = data.length;
    const judge = (): void => {
      // Else the data that has come re-armed the timer, or the end of the
      // connection has been read: its `close`, which follows, decides
      if (data.length === seen && !socket.readableEnded) {
        resolve(false);
      }
    };
    ioTurn().then(judge, judge);
  };
  let timer = setTimeout(expire, idle);
  socket.setEncoding("latin1").on("data", (chunk: string) => {
    data += chunk;
    clearTimeout(timer);
    timer = setTimeout(expire, idle);
  });
  socket.on("error", () => {
    // E.g. reset by the server: what it has sent is read
  });
  const closed = once(socket, "close").then(() => true);
  socket.write(requests);
  try {
    const ended = await within(Promise.race([closed, quiet]));
    return { data: data.replaceAll(/\r\nDate: [^\r]*/gu, ""), closed: ended };
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}

/** A response (with an injected one after it) of a UTF-8 body framed by its length in characters */
const injected = "HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\nINJECTED";

/**
 * Writes that Node.js refuses for `strictContentLength` once it has committed
 * the head (a `Content-Length` of 2, unless the case sets its own): the
 * body is below the `threshold`, and sent as it is
 */
const mismatches: Record<string, (response: ServerResponse) => void> = {
  "end() of a longer body": (response) => {
    response.end("abc");
  },
  "end() of a shorter body": (response) => {
    response.end("a");
  },
  "end() of a longer body in hex": (response) => {
    response.end("616263", "hex");
  },
  "write() of the body, then end() of more": (response) => {
    response.write("ab");
    response.end(injected);
  },
  "write() of a shorter body, then end()": (response) => {
    response.write("a");
    response.end();
  },
  "a second write() past the length": (response) => {
    response.write("ab");
    response.write("c");
  },
  "end() of a UTF-8 body framed by its length in characters": (response) => {
    // Every `€` is two bytes more than a character: the excess is the
    // injected response
    const body = `${"€".repeat(injected.length / 2)}${injected}`;
    response.setHeader("Content-Length", body.length);
    response.end(body);
  },
};

const pipelined =
  "GET /mismatch HTTP/1.1\r\nHost: a\r\nAccept-Encoding: gzip\r\n\r\n" +
  "GET /next HTTP/1.1\r\nHost: a\r\nAccept-Encoding: gzip\r\nConnection: close\r\n\r\n";

/** Runs a mismatch on a strict response of `Content-Length: 2` */
function mismatch(name: string, response: ServerResponse): void {
  response.strictContentLength = true;
  response.setHeader("Content-Type", "text/plain");
  response.setHeader("Content-Length", 2);
  mismatches[name](response);
}

/** A server of Node.js whose handler destroys the response that throws */
function native(name: string): Server {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.url === "/next") {
      response.end("next");
      return;
    }
    try {
      mismatch(name, response);
    } catch {
      response.destroy();
    }
  });
}

/** Listens on a free port */
async function listen(server: Server): Promise<IServed> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    close: async (): Promise<void> => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

/** The port of a listening server */
function portOf({ url }: IServed): number {
  return Number(new URL(url).port);
}

suite(
  "A body sent as it is that Node.js refuses once the head is committed",
  () => {
    const servers: IServed[] = [];

    afterEach(async () => {
      await Promise.all(
        servers.splice(0).map(async (served) => served.close()),
      );
    });

    /** An application whose middleware lets the error out, through a compression */
    const application = async (
      name: string,
      outcomes: unknown[],
      captured: ICaptured,
      ids: unknown[] = [],
    ): Promise<IServed> => {
      const served = await serve(
        { app: { logger: captured.logger, access_log: true } },
        new Compression({ format: "gzip" }),
        async (context: Context) => {
          const { response } = context;
          if (context.url.pathname === "/next") {
            await context.text("next");
            return;
          }
          context.done = true;
          ids.push(context.id);
          context.onCleanup(() => {
            outcomes.push(context.signal.aborted, response.writableFinished);
          });
          try {
            mismatch(name, response);
          } catch (error: unknown) {
            // Destroyed before the error is thrown
            outcomes.push(
              (error as { code?: unknown }).code,
              response.destroyed,
            );
            throw error;
          }
        },
      );
      servers.push(served);
      return served;
    };

    for (const name of Object.keys(mismatches)) {
      test(`sends nothing more and closes the connection, as Node.js: ${name}`, async () => {
        const outcomes: unknown[] = [];
        const ids: unknown[] = [];
        const captured = capture();
        const natively = await listen(native(name));
        servers.push(natively);
        const served = await application(name, outcomes, captured, ids);
        const [expected, actual] = [
          await talk(portOf(natively), pipelined),
          await talk(portOf(served), pipelined),
        ];

        // Nothing (neither the head, nor the chunk, nor an injected
        // response): also not by the cork that Node.js releases on the next
        // tick
        deepStrictEqual(actual, expected);
        deepStrictEqual(actual, { data: "", closed: true });
        // Its access log once it has closed: aborted
        const completed = (): Record<string, unknown>[] =>
          captured.entries.filter(
            ({ msg, id }) =>
              msg === "The request has completed" && id === ids[0],
          );
        await pollUntil(() => completed().length > 0).catch(() => null);
        deepStrictEqual(outcomes, [
          "ERR_HTTP_CONTENT_LENGTH_MISMATCH",
          true,
          true,
          false,
        ]);
        deepStrictEqual(
          completed().map(({ status, aborted }) => [status, aborted]),
          [[200, true]],
        );
      });
    }

    test("by fetch(): no response, as from Node.js", async () => {
      const name = "end() of a UTF-8 body framed by its length in characters";
      const natively = await listen(native(name));
      servers.push(natively);
      const served = await application(name, [], capture());
      for (const { url } of [natively, served]) {
        await rejects(
          fetch(`${url}/mismatch`, {
            headers: { "Accept-Encoding": "gzip" },
            signal: AbortSignal.timeout(10_000),
          }),
          (error: unknown) =>
            error instanceof TypeError && error.message === "fetch failed",
        );
      }
    });

    test("once a write has been flushed: closes the connection after exactly what has been sent", async () => {
      const served = await serve(
        {},
        new Compression({ format: "gzip" }),
        async (context: Context) => {
          const { response } = context;
          if (context.url.pathname === "/next") {
            await context.text("next");
            return;
          }
          response.strictContentLength = true;
          response.setHeader("Content-Length", 5);
          response.write("ab");
          await response.flush();
          // Past the length: Node.js refuses it before it writes it
          response.write("abcd");
        },
      );
      servers.push(served);
      const { data, closed } = await talk(portOf(served), pipelined);

      ok(data.startsWith("HTTP/1.1 200 OK\r\n"), data);
      ok(data.includes("\r\nContent-Length: 5\r\n"), data);
      ok(!data.includes("Content-Encoding"), data);
      deepStrictEqual(
        [data.slice(data.indexOf("\r\n\r\n") + 4), closed],
        ["ab", true],
      );
    });

    test("a first write() past the length (which Node.js does not check) throws before Node.js gets it: the error is replied, nothing injected", async () => {
      const outcomes: unknown[] = [];
      const served = await serve(
        {},
        new Compression({ format: "gzip" }),
        async (context: Context) => {
          const { response } = context;
          if (context.url.pathname === "/next") {
            await context.text("next");
            return;
          }
          response.strictContentLength = true;
          response.setHeader("Content-Length", 2);
          try {
            response.write(`ab${injected}`);
          } catch (error: unknown) {
            outcomes.push(
              (error as { code?: unknown }).code,
              response.headersSent,
              response.destroyed,
            );
            throw error;
          }
        },
      );
      servers.push(served);
      const { data, closed } = await talk(portOf(served), pipelined);

      ok(!data.includes("INJECTED"), data);
      ok(
        data.startsWith("HTTP/1.1 500 Internal Server Error\r\n") &&
          data.endsWith("\r\n\r\nnext"),
        data,
      );
      deepStrictEqual(
        [closed, outcomes],
        [true, ["ERR_HTTP_CONTENT_LENGTH_MISMATCH", false, false]],
      );
    });

    test("of a response that waits for the one before it sends nothing of it once its socket comes", async () => {
      const sockets: unknown[] = [];
      const served = await serve(
        {},
        new Compression({ format: "gzip" }),
        async (context: Context) => {
          const { response } = context;
          if (context.url.pathname === "/first") {
            await sleep(50);
            await context.text("first");
            return;
          } else if (context.url.pathname === "/next") {
            await context.text("next");
            return;
          }
          // Without a socket yet: its head and its chunk are queued
          sockets.push(response.socket);
          mismatch("end() of a longer body", response);
        },
      );
      servers.push(served);
      const { data, closed } = await talk(
        portOf(served),
        `GET /first HTTP/1.1\r\nHost: a\r\nAccept-Encoding: gzip\r\n\r\n${pipelined}`,
      );

      deepStrictEqual(
        [
          data.split("\r\n")[0],
          data.slice(data.indexOf("\r\n\r\n") + 4),
          closed,
        ],
        ["HTTP/1.1 200 OK", "first", true],
      );
      deepStrictEqual(sockets, [null]);
    });
  },
);
