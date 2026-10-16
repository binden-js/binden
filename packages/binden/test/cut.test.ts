import { type AddressInfo, connect } from "node:net";
import { Binden, BindenResponse, type Context } from "../index.js";
import {
  type IncomingMessage,
  type Server,
  ServerResponse,
  createServer,
} from "node:http";
import { capture, listen, never, sleep, within } from "./helpers.js";
import { deepStrictEqual, ok } from "node:assert/strict";
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
