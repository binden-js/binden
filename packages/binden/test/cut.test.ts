import { type AddressInfo, Socket, connect } from "node:net";
import { Binden, BindenResponse, type Context } from "../index.js";
import {
  IncomingMessage,
  OutgoingMessage,
  type Server,
  ServerResponse,
  createServer,
} from "node:http";
import { capture, listen, never, sleep, within } from "./helpers.js";
import { deepStrictEqual, ok, rejects, throws } from "node:assert/strict";
import { suite, test } from "node:test";
import { kFramework } from "../src/seal.js";
import { once } from "node:events";

/** What a client has read of a connection until the server closed it (or until it was idle) */
interface IConversation {
  readonly data: string;
  readonly closed: boolean;
}

/**
 * Writes requests on one connection, and reads every byte until the server
 * closes it, or until nothing comes for `idle` milliseconds
 */
async function converse(
  port: number,
  requests: string,
  idle = 300,
): Promise<IConversation> {
  const socket = connect(port, "localhost");
  await once(socket, "connect");
  let data = "";
  const { promise: quiet, resolve } = Promise.withResolvers<boolean>();
  let timer = setTimeout(resolve, idle, false);
  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(resolve, idle, false);
  };
  socket.setEncoding("latin1").on("data", (chunk: string) => {
    data += chunk;
    arm();
  });
  socket.on("error", () => {
    // E.g. reset by the server: what it has sent is read
  });
  const closed = once(socket, "close").then(() => true);
  socket.write(requests);
  try {
    const ended = await within(Promise.race([closed, quiet]), 5000);
    return { data: data.replaceAll(/\r\nDate: [^\r]*/gu, ""), closed: ended };
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}

/** The body of a chunked body (and its last chunk), as Node.js has chunked it */
function dechunk(chunked: string): string {
  let body = "";
  let rest = chunked;
  for (;;) {
    const line = rest.indexOf("\r\n");
    const size = Number.parseInt(rest.slice(0, line), 16);
    ok(line > 0 && Number.isSafeInteger(size), `Not chunked: ${chunked}`);
    if (size === 0) {
      deepStrictEqual(rest, "0\r\n\r\n");
      return body;
    }
    body += rest.slice(line + 2, line + 2 + size);
    rest = rest.slice(line + 2 + size + 2);
  }
}

/** A server listening on a free port, closed by `close()` */
async function serve(server: Server): Promise<{
  port: number;
  close(): Promise<void>;
}> {
  server.listen(0, "localhost");
  await once(server, "listening");
  return {
    port: (server.address() as AddressInfo).port,
    close: async (): Promise<void> => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

/** A response (with an injected one after it) of a UTF-8 body framed by its length in characters */
const injected = "HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\nINJECTED";

/**
 * Writes that Node.js refuses for `strictContentLength` once it has committed
 * the head (a `Content-Length` of 2, unless the case sets its own)
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
  "write() of a longer body, then end()": (response) => {
    response.write("abc");
    response.end();
  },
  "write() of a shorter body, then end()": (response) => {
    response.write("a");
    response.end();
  },
  "write() of the body, then end() of more": (response) => {
    response.write("ab");
    response.end(injected);
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
  "GET /mismatch HTTP/1.1\r\nHost: a\r\n\r\n" +
  "GET /next HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n";

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

/** An application whose middleware lets the error out (also through the access log) */
function application(
  name: string,
  outcomes: unknown[],
): { app: Binden; captured: ReturnType<typeof capture> } {
  const captured = capture();
  const app = new Binden({ logger: captured.logger, access_log: true }).use(
    async (context: Context) => {
      const { response } = context;
      if (context.url.pathname === "/next") {
        await context.text("next");
        return;
      }
      context.onCleanup(() => {
        outcomes.push(context.signal.aborted, response.writableFinished);
      });
      try {
        mismatch(name, response);
      } catch (error: unknown) {
        // Destroyed before the error is thrown
        outcomes.push((error as { code?: unknown }).code, response.destroyed);
        throw error;
      }
    },
  );
  return { app, captured };
}

suite("A write() or an end() that throws once the head is committed", () => {
  for (const name of Object.keys(mismatches)) {
    test(`sends nothing more and closes the connection: ${name}`, async () => {
      const outcomes: unknown[] = [];
      const { app, captured } = application(name, outcomes);
      const servers = [native(name), app.createServer()];
      const conversations: IConversation[] = [];
      for (const server of servers) {
        const listening = await serve(server);
        try {
          conversations.push(await converse(listening.port, pipelined));
        } finally {
          await listening.close();
        }
      }
      const [natively, binden] = conversations;
      // Nothing (neither the head, nor the chunk, nor an injected response),
      // as Node.js itself: also not by the cork that Node.js releases on the
      // next tick
      deepStrictEqual(binden, natively);
      deepStrictEqual(binden, { data: "", closed: true });
      deepStrictEqual(outcomes, [
        "ERR_HTTP_CONTENT_LENGTH_MISMATCH",
        true,
        true,
        false,
      ]);
      const { status, aborted } = await captured.waitFor(
        "The request has completed",
      );
      deepStrictEqual([status, aborted], [200, true]);
    });
  }

  test("by fetch(): no response, as from Node.js", async () => {
    const name = "end() of a UTF-8 body framed by its length in characters";
    const { app } = application(name, []);
    for (const server of [native(name), app.createServer()]) {
      const listening = await serve(server);
      try {
        await rejects(
          fetch(`http://localhost:${listening.port}/mismatch`, {
            signal: AbortSignal.timeout(5000),
          }),
          (error: unknown) =>
            error instanceof TypeError && error.message === "fetch failed",
        );
      } finally {
        await listening.close();
      }
    }
  });

  test("once a write has been flushed: closes the connection after exactly what has been sent", async () => {
    const app = new Binden().use(async (context: Context) => {
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
    });
    const listening = await listen(app);
    try {
      deepStrictEqual(await converse(listening.port, pipelined), {
        data: "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: keep-alive\r\nKeep-Alive: timeout=5\r\n\r\nab",
        closed: true,
      });
    } finally {
      await listening.close();
    }
  });

  test("of a response that waits for the one before it sends nothing of it once its socket comes", async () => {
    const outcomes: unknown[] = [];
    const app = new Binden().use(async (context: Context) => {
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
      outcomes.push(response.socket);
      response.strictContentLength = true;
      response.setHeader("Content-Length", 2);
      response.end("abc");
    });
    const listening = await listen(app);
    try {
      deepStrictEqual(
        await converse(
          listening.port,
          "GET /first HTTP/1.1\r\nHost: a\r\n\r\n" +
            "GET /mismatch HTTP/1.1\r\nHost: a\r\n\r\n" +
            "GET /next HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n",
        ),
        {
          data: "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 5\r\nConnection: keep-alive\r\nKeep-Alive: timeout=5\r\n\r\nfirst",
          closed: true,
        },
      );
      deepStrictEqual(outcomes, [null]);
    } finally {
      await listening.close();
    }
  });

  test("for a chunk or an encoding refused before anything is written leaves the response to its reply", async () => {
    const refused: unknown[] = [];
    const app = new Binden().use(({ response }: Context) => {
      response.setHeader("Content-Type", "text/plain");
      response.write("part;");
      const calls: (() => unknown)[] = [
        (): unknown => response.write(null),
        (): unknown => response.write({}),
        (): unknown => response.write("x", "bogus" as BufferEncoding),
        (): unknown => response.end({}),
        (): unknown => response.end("x", "bogus" as BufferEncoding),
      ];
      for (const call of calls) {
        try {
          call();
        } catch (error: unknown) {
          refused.push((error as { code?: unknown }).code);
        }
      }
      response.end("rest");
    });
    const listening = await listen(app);
    try {
      const { data, closed } = await converse(
        listening.port,
        "GET / HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n",
      );
      const end = data.indexOf("\r\n\r\n");
      const [head, chunks] = [data.slice(0, end), data.slice(end + 4)];
      deepStrictEqual(
        [head, dechunk(chunks), closed],
        [
          "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\nTransfer-Encoding: chunked",
          "part;rest",
          true,
        ],
      );
      deepStrictEqual(refused, [
        "ERR_STREAM_NULL_VALUES",
        "ERR_INVALID_ARG_TYPE",
        "ERR_UNKNOWN_ENCODING",
        "ERR_INVALID_ARG_TYPE",
        "ERR_UNKNOWN_ENCODING",
      ]);
    } finally {
      await listening.close();
    }
  });

  test("for a body that the response may not have (to HEAD, or with 204), caught: an end() sends the reply complete, as Node.js", async () => {
    // `rejectNonStandardBodyWrites`: Node.js generates the head, then throws
    // `ERR_HTTP_BODY_NOT_ALLOWED`, having queued nothing more
    const thrown: unknown[] = [];
    const handler = (
      request: IncomingMessage,
      response: ServerResponse,
    ): void => {
      if (request.url === "/next") {
        response.end("next");
        return;
      } else if (request.url?.startsWith("/204") === true) {
        response.statusCode = 204;
      }
      try {
        if (request.url?.endsWith("end") === true) {
          response.end("body");
        } else {
          response.write("body");
        }
      } catch (error: unknown) {
        thrown.push((error as { code?: unknown }).code, response.headersSent);
      }
      response.end();
    };
    const options = { rejectNonStandardBodyWrites: true };
    const app = new Binden().use(({ request, response }: Context) => {
      handler(request, response);
    });
    const conversations: IConversation[][] = [];
    for (const server of [
      createServer(options, handler),
      app.createServer(options),
    ]) {
      const listening = await serve(server);
      const replies: IConversation[] = [];
      try {
        for (const target of [
          "HEAD /",
          "HEAD /end",
          "GET /204",
          "GET /204end",
        ]) {
          replies.push(
            await converse(
              listening.port,
              `${target} HTTP/1.1\r\nHost: a\r\n\r\n` +
                "GET /next HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n",
            ),
          );
        }
      } finally {
        await listening.close();
      }
      conversations.push(replies);
    }
    const [natively, binden] = conversations as [
      IConversation[],
      IConversation[],
    ];
    deepStrictEqual(binden, natively);
    // Complete, and the connection is kept for the next response
    for (const [index, { data, closed }] of binden.entries()) {
      ok(
        data.startsWith(
          index < 2 ? "HTTP/1.1 200 OK\r\n" : "HTTP/1.1 204 No Content\r\n",
        ) && data.endsWith("\r\nContent-Length: 4\r\n\r\nnext"),
        data,
      );
      ok(closed);
    }
    deepStrictEqual(
      thrown,
      Array.from({ length: 8 }, () => [
        "ERR_HTTP_BODY_NOT_ALLOWED",
        true,
      ]).flat(),
    );
  });

  test("for a chunk that Node.js refuses before it takes it: the response stays usable", () => {
    // Such checks of binden itself come first (see above): they would leave
    // the response as it is, also from Node.js once the head is committed
    const write = Reflect.get(OutgoingMessage.prototype, "write") as unknown;
    try {
      for (const code of [
        "ERR_HTTP_BODY_NOT_ALLOWED",
        "ERR_INVALID_ARG_TYPE",
        "ERR_STREAM_NULL_VALUES",
        "ERR_UNKNOWN_ENCODING",
        "ERR_HTTP_CONTENT_LENGTH_MISMATCH",
      ]) {
        const response = new BindenResponse(new IncomingMessage(new Socket()));
        response.flushHeaders();
        Reflect.set(OutgoingMessage.prototype, "write", (): never => {
          throw Object.assign(new Error(code), { code });
        });
        throws(() => response.write("x"), { code });
        Reflect.set(OutgoingMessage.prototype, "write", write);
        deepStrictEqual(
          response.destroyed,
          code === "ERR_HTTP_CONTENT_LENGTH_MISMATCH",
          code,
        );
      }
    } finally {
      Reflect.set(OutgoingMessage.prototype, "write", write);
    }
  });

  test("for a head that Node.js refuses (left uncommitted) leaves the response to its next reply", async () => {
    const app = new Binden().use(({ response }: Context) => {
      response.setHeader("Trailer", "X-T");
      response.setHeader("Content-Length", 4);
      try {
        response.end("body");
      } catch {
        ok(!response.headersSent && !response.destroyed);
        response.removeHeader("Trailer");
        response.end("next");
      }
    });
    const listening = await listen(app);
    try {
      deepStrictEqual(
        await converse(
          listening.port,
          "GET / HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n",
        ),
        {
          data: "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nnext",
          closed: true,
        },
      );
    } finally {
      await listening.close();
    }
  });
});

suite("A response that waits for the one before it, destroyed", () => {
  /**
   * A server whose `/` replies after 50 ms, and whose `/next` (pipelined
   * after it, so without a socket yet) is set up, then destroyed (with the
   * rights of the framework, or not): what the client reads
   */
  async function destroyQueued(
    Response: typeof ServerResponse,
    setup: (response: ServerResponse) => void,
    framework: boolean,
  ): Promise<IConversation> {
    const server = createServer(
      { ServerResponse: Response as typeof BindenResponse },
      (request: IncomingMessage, response: ServerResponse) => {
        if (request.url === "/") {
          setTimeout(() => {
            response.end("first");
          }, 50);
          return;
        }
        ok(response.socket === null);
        setup(response);
        if (framework) {
          (response as BindenResponse)[kFramework](() => response.destroy());
        } else {
          response.destroy();
        }
      },
    );
    const listening = await serve(server);
    try {
      return await converse(
        listening.port,
        "GET / HTTP/1.1\r\nHost: a\r\n\r\n" +
          "GET /next HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n",
      );
    } finally {
      await listening.close();
    }
  }

  const first =
    "HTTP/1.1 200 OK\r\nConnection: keep-alive\r\nKeep-Alive: timeout=5\r\nContent-Length: 5\r\n\r\nfirst";

  const setups: Record<string, (response: ServerResponse) => void> = {
    "once started": (response) => {
      response.write("part");
    },
    "before it has started": () => {
      // Nothing written
    },
  };

  for (const [name, setup] of Object.entries(setups)) {
    test(`by the framework ${name}: its connection is closed once it would be sent (on every Node.js)`, async () => {
      deepStrictEqual(await destroyQueued(BindenResponse, setup, true), {
        data: first,
        closed: true,
      });
    });

    test(`by the application ${name}: as Node.js`, async () => {
      deepStrictEqual(
        await destroyQueued(BindenResponse, setup, false),
        await destroyQueued(ServerResponse, setup, false),
      );
    });
  }

  test("by the framework once ended: as Node.js (its complete reply is not cut by binden)", async () => {
    const setup = (response: ServerResponse): void => {
      response.end("next");
    };
    deepStrictEqual(
      await destroyQueued(BindenResponse, setup, true),
      await destroyQueued(ServerResponse, setup, false),
    );
  });

  test("by its deadline once it has started: the response before it is complete, then the connection is closed", async () => {
    const captured = capture();
    const app = new Binden({
      logger: captured.logger,
      timeout: 50,
      error_handler: async ({ request, response }: Context): Promise<void> => {
        if (request.url === "/") {
          // Once the deadline of `/next` has passed
          await sleep(40);
          await response.status(503).send("late");
        }
      },
    }).use(async ({ request, response }: Context) => {
      if (request.url === "/next") {
        response.write("part");
      }
      await never();
    });
    const listening = await listen(app);
    try {
      deepStrictEqual(
        await converse(
          listening.port,
          "GET / HTTP/1.1\r\nHost: a\r\n\r\n" +
            "GET /next HTTP/1.1\r\nHost: a\r\n\r\n",
        ),
        {
          data: "HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\nContent-Length: 4\r\nConnection: keep-alive\r\nKeep-Alive: timeout=5\r\n\r\nlate",
          closed: true,
        },
      );
      await captured.waitFor("The deadline has passed. Destroying the socket");
    } finally {
      await listening.close();
    }
  });
});
