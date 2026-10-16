import { Agent, type IncomingMessage, request as httpRequest } from "node:http";
import {
  Binden,
  BindenAbortError,
  BindenError,
  type Context,
  shutdown,
} from "binden";
import { type IMultipartOptions, Multipart } from "../index.js";
import {
  RecordingLogger,
  body,
  listen,
  part,
  send,
  serve,
  sleep,
  type,
  upload,
  within,
} from "./helpers.js";
import { type TestContext, describe, it } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { once } from "node:events";

/**
 * What `run()` has settled with: the reason of a `BindenAbortError`, or the
 * status, code and cause of a `BindenError`
 */
function outcome(error: unknown): unknown[] {
  if (error instanceof BindenAbortError) {
    return ["BindenAbortError", error.reason];
  }
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

  it("rejects with the reason of the signal once the deadline has passed", async (t) => {
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
    deepEqual(outcome(await within(settled)), ["BindenAbortError", "deadline"]);
  });

  it("replies `503` at the deadline while a send waits for the first chunk of its stream", async (t) => {
    const { promise: settled, resolve: settle } =
      Promise.withResolvers<unknown>();
    const { promise: sent, resolve: finish } = Promise.withResolvers<unknown>();
    const parser = new Multipart();
    const { url } = await serve(
      t,
      [
        async (context: Context): Promise<void> => {
          // Not awaited: the reply starts while the body is read
          parser.run(context).then(settle, settle);
          // A stream that gives nothing: the headers are never sent
          const stream = new Readable({
            read(): void {
              // Nothing
            },
          });
          await context.send(stream).then(finish, (error: unknown) => {
            finish(error);
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

    // Not a closed connection: the deadline cancels the send, then replies
    deepEqual(reply, [503, "close"]);
    deepEqual(outcome(await within(settled)), ["BindenAbortError", "deadline"]);
    deepEqual(outcome(await within(sent)), ["BindenAbortError", "deadline"]);
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
    deepEqual(outcome(await within(settled)), ["BindenAbortError", "deadline"]);
  });

  it("rejects with the reason of the signal when the server shuts down", async () => {
    const { promise: settled, resolve: settle } =
      Promise.withResolvers<unknown>();
    const { promise: started, resolve: start } = Promise.withResolvers<null>();
    const parser = new Multipart();
    const { server, url } = await listen(
      new Binden().use(async (context: Context): Promise<void> => {
        start(null);
        await parser.run(context).catch((error: unknown) => {
          settle(error);
          throw error;
        });
      }),
    );

    const reply = upload(url, part('name="file"; filename="file.txt"', "1"));
    await within(started);
    const closed = shutdown(server, { timeout: 50 });

    deepEqual(outcome(await within(settled)), ["BindenAbortError", "shutdown"]);
    // Then every connection is closed
    await within(reply.catch(() => null));
    await within(closed);
  });
});

/** Ignores an error (e.g. of a connection that the test closes on purpose) */
function ignore(): void {
  // On purpose
}

/**
 * The client of a parse that starts before the response, which finishes
 * while the parse goes on: it sends the head of a body, reads the response,
 * and goes away. Settles with what `run()` has settled with.
 */
async function afterResponse(
  t: TestContext,
  storage: IMultipartOptions["storage"],
  reached: Promise<unknown>,
): Promise<unknown> {
  const { promise: settled, resolve: settle } =
    Promise.withResolvers<unknown>();
  const parser = new Multipart({ storage });
  const { url } = await serve(t, [
    async (context: Context): Promise<void> => {
      // Not awaited: the response finishes while the body is read
      parser.run(context).then(settle, settle);
      await context.send("early");
    },
  ]);

  const client = httpRequest(url, {
    method: "POST",
    headers: { "Content-Type": type, "Content-Length": 1 << 20 },
  });
  client.on("error", ignore);
  client.write(part('name="file"; filename="file.txt"', "Hello"));
  const [response] = (await within(once(client, "response"))) as [
    IncomingMessage,
  ];
  response.resume();
  await within(once(response, "end"));
  await within(reached);
  client.destroy();
  return within(settled);
}

describe("Multipart (a client that goes away once the response has finished)", () => {
  it("rejects with a `400` (memory storage)", async (t) => {
    const settled = await afterResponse(t, "memory", Promise.resolve());

    deepEqual(outcome(settled), [400, "aborted", "object"]);
  });

  it("rejects with a `400`, and destroys the stream of the file (stream storage)", async (t) => {
    const { promise: reached, resolve: reach } = Promise.withResolvers<null>();
    const { promise: streamed, resolve: stream } =
      Promise.withResolvers<unknown>();
    const settled = await afterResponse(
      t,
      {
        on_file: async ({ stream: content }): Promise<void> => {
          reach(null);
          content.resume();
          await finished(content).then(
            () => {
              stream("ended");
            },
            () => {
              stream(content.destroyed ? "destroyed" : "failed");
            },
          );
        },
      },
      reached,
    );

    deepEqual(outcome(settled), [400, "aborted", "object"]);
    equal(await within(streamed), "destroyed");
  });

  it("parses a body received whole, also when its connection then closes", async (t) => {
    const { promise: settled, resolve: settle } =
      Promise.withResolvers<unknown>();
    const { promise: closed, resolve: close } =
      Promise.withResolvers<Context["request"]>();
    const parser = new Multipart();
    const { url } = await serve(t, [
      async (context: Context): Promise<void> => {
        const { request } = context;
        parser.run(context).then(settle, settle);
        // As if the rest of the body had been received, and were still on
        // its way to the parser when the connection closes
        request.complete = true;
        request.socket.once("close", () => {
          close(request);
        });
        await context.send("early");
      },
    ]);
    const form = body(part('name="a"', "1"));

    const client = httpRequest(url, {
      method: "POST",
      headers: { "Content-Type": type, "Content-Length": form.length },
    });
    client.on("error", ignore);
    client.write(form.slice(0, 10));
    const [response] = (await within(once(client, "response"))) as [
      IncomingMessage,
    ];
    response.resume();
    await within(once(response, "end"));
    client.destroy();
    const request = await within(closed);
    request.push(form.slice(10));
    request.push(null);

    equal(typeof (await within(settled)), "undefined");
    deepEqual([...(request.body as FormData)], [["a", "1"]]);
  });

  it("keeps no listener on a connection that is kept alive", async (t) => {
    const counts: number[] = [];
    const sockets = new Set<unknown>();
    const parser = new Multipart();
    const { url } = await serve(t, [
      async (context: Context): Promise<void> => {
        await parser.run(context);
        const { socket } = context.request;
        sockets.add(socket);
        counts.push(socket.listenerCount("close"));
        await context.send();
      },
    ]);
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    t.after(() => {
      agent.destroy();
    });

    for (let index = 0; index < 3; index += 1) {
      const reply = await send(url, {
        headers: { "Content-Type": type },
        body: body(part('name="a"', "1")),
        agent,
      });
      equal(reply.status, 200);
    }

    deepEqual([sockets.size, counts.length, new Set(counts).size], [1, 3, 1]);
  });
});

describe("Multipart (a parse that starts once the response has ended)", () => {
  const discarded = "The body has been discarded once the response finished";

  it("refuses the body once the response has finished", async (t) => {
    const { promise: settled, resolve: settle } =
      Promise.withResolvers<unknown>();
    const logger = new RecordingLogger();
    const parser = new Multipart();
    const { url } = await serve(
      t,
      [
        async (context: Context): Promise<void> => {
          // Without `done`: the next middleware runs
          await context.response.status(202).send("accepted");
        },
        async (context: Context): Promise<void> => {
          if (!context.response.writableFinished) {
            await once(context.response, "finish");
          }
          await parser.run(context).then(settle, settle);
        },
      ],
      { logger },
    );
    const form = body(part('name="a"', "1"));

    // The body once the client has the reply
    const client = httpRequest(url, {
      method: "POST",
      headers: { "Content-Type": type, "Content-Length": form.length },
    });
    client.on("error", ignore);
    client.flushHeaders();
    const [response] = (await within(once(client, "response"))) as [
      IncomingMessage,
    ];
    response.resume();
    await within(once(response, "end"));
    client.end(form);
    const error = await within(settled);

    ok(error instanceof BindenError);
    deepEqual([error.status, error.message], [500, discarded]);
    ok(
      logger.records.some(
        ({ level, message }) => level === "error" && message === discarded,
      ),
    );
  });

  it(
    "parses the body once the response has ended, but not finished",
    {
      // Windows takes a whole write while its send buffer has room: the
      // response may finish before the client reads it
      skip: process.platform === "win32",
    },
    async (t) => {
      // Larger than what the connection buffers: the response cannot finish
      // before the client reads it
      const large = Buffer.alloc(32 * 1024 * 1024, 0x61);
      const states: boolean[] = [];
      const { promise: settled, resolve: settle } =
        Promise.withResolvers<unknown>();
      const { promise: started, resolve: start } =
        Promise.withResolvers<null>();
      const parser = new Multipart();
      const { url } = await serve(t, [
        (context: Context): void => {
          context.response.end(large);
        },
        async (context: Context): Promise<void> => {
          const { response } = context;
          states.push(response.writableEnded, response.writableFinished);
          start(null);
          await parser.run(context).then(() => {
            settle([...(context.request.body as FormData)]);
          }, settle);
        },
      ]);
      const form = body(part('name="a"', "1"));

      const client = httpRequest(url, {
        method: "POST",
        headers: { "Content-Type": type, "Content-Length": form.length },
      });
      client.on("error", ignore);
      // Listened to at once: the reply arrives before the body is sent, and
      // Node.js dumps a response that nothing listens to (which would also
      // let the reply finish)
      const responded = once(client, "response");
      client.flushHeaders();
      await within(started);
      client.end(form);

      deepEqual(await within(settled), [["a", "1"]]);
      deepEqual(states, [true, false]);
      const [response] = (await within(responded)) as [IncomingMessage];
      response.resume();
      // 32 MiB through the loopback: slower on a loaded machine
      await within(once(response, "end"), 30_000);
    },
  );
});
