import {
  Binden,
  BindenAbortError,
  BindenRequest,
  BindenResponse,
  type Context,
  isClosing,
  shutdown,
} from "../index.js";
import { type Server, createServer } from "node:http";
import { type Socket, connect } from "node:net";
import { capture, listen, never, send, sleep, within } from "./helpers.js";
import { deepStrictEqual, ok, rejects, throws } from "node:assert/strict";
import { mock, suite, test } from "node:test";
import dns from "node:dns";
import { once } from "node:events";

/** A connection to a server, with everything it has received */
interface IConnection {
  readonly socket: Socket;
  received(): string;
  /** Resolves once the received data includes `text` */
  waitFor(text: string): Promise<void>;
  /** Resolves once the server has closed the connection */
  closed: Promise<void>;
}

/** Opens a connection to a server (closed by the test at the latest) */
async function connection(port: number): Promise<IConnection> {
  const socket = connect(port, "127.0.0.1");
  await once(socket, "connect");
  let data = "";
  socket.setEncoding("utf8").on("data", (chunk: string) => {
    data += chunk;
  });
  socket.on("error", () => {
    // Reset by the server
  });
  return {
    socket,
    received: (): string => data,
    waitFor: async (text: string): Promise<void> => {
      const deadline = Date.now() + 5000;
      while (!data.includes(text)) {
        if (Date.now() > deadline || socket.destroyed) {
          throw new Error(`Not received: ${text} (${data})`);
        }
        await sleep(5);
      }
    },
    closed: once(socket, "close").then(() => {
      // Closed
    }),
  };
}

/** A promise that the test resolves */
function gate(): { promise: Promise<void>; open(): void } {
  const { promise, resolve } = Promise.withResolvers<null>();
  return {
    promise: promise.then(() => {
      // Opened
    }),
    open: (): void => {
      resolve(null);
    },
  };
}

suite("shutdown()", () => {
  test("validates its options", () => {
    const server = createServer();
    throws(
      () => shutdown(server, { timeout: 0 }),
      new RangeError("`timeout` is not between 1 and 2147483647"),
    );
    throws(
      () => shutdown(server, { cleanup_timeout: 1.5 }),
      new TypeError("`cleanup_timeout` is not an integer"),
    );
    throws(
      () => shutdown(server, { timeout: 2 ** 31 }),
      new RangeError("`timeout` is not between 1 and 2147483647"),
    );
    ok(!isClosing(server));
  });

  test("closes an idle server at once, and returns the same promise", async () => {
    const app = new Binden().use((context: Context) => context.send("ok"));
    const { server, port } = await listen(app);
    const idle = await connection(port);
    idle.socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
    await idle.waitFor("\r\n\r\nok");

    ok(!isClosing(server));
    const first = shutdown(server);
    ok(isClosing(server));
    ok(shutdown(server, { timeout: 1 }) === first);
    await within(first);
    // The idle keep-alive connection has been closed, and no other is accepted
    await within(idle.closed);
    ok(!server.listening);
    await rejects(send(port), { code: "ECONNREFUSED" });
  });

  test("lets a request complete, and closes its connection afterwards", async () => {
    const started = gate();
    const release = gate();
    let aborted = true;
    const app = new Binden().use(async (context: Context) => {
      started.open();
      await release.promise;
      ({ aborted } = context.signal);
      await context.send("done");
    });
    const { server, port } = await listen(app);
    const client = await connection(port);
    client.socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
    await started.promise;

    const closing = shutdown(server);
    await sleep(20);
    release.open();
    await within(closing);
    await within(client.closed);
    ok(!aborted);
    ok(client.received().startsWith("HTTP/1.1 200 OK"), client.received());
    ok(
      /\r\nConnection: close\r\n/iu.test(client.received()),
      client.received(),
    );
    ok(client.received().endsWith("done"));
  });

  test("a request that arrives on a connection once closing gets `503`", async () => {
    const release = gate();
    const paths: string[] = [];
    const app = new Binden().use(async (context: Context) => {
      paths.push(context.url.pathname);
      // The headers are sent before the shutdown: the connection stays open
      context.response.writeHead(200, { "Content-Length": 1 });
      context.response.flushHeaders();
      await release.promise;
      context.response.end("a");
      context.done = true;
    });
    const { server, port } = await listen(app);
    const client = await connection(port);
    client.socket.write("GET /a HTTP/1.1\r\nHost: localhost\r\n\r\n");
    await client.waitFor("Content-Length: 1\r\n");

    const closing = shutdown(server);
    // Pipelined after the first one, on its connection
    client.socket.write("GET /b HTTP/1.1\r\nHost: localhost\r\n\r\n");
    await sleep(20);
    release.open();
    await within(closing);
    await within(client.closed);
    const [, second = ""] = client.received().split(/(?=HTTP\/1\.1 )/u);
    ok(second.startsWith("HTTP/1.1 503"), client.received());
    ok(/\r\nConnection: close\r\n/iu.test(second), second);
    deepStrictEqual(paths, ["/a"]);
  });

  test("answers the pipelined requests in progress, and closes the connection after the last one", async () => {
    const gates = { "/a": gate(), "/b": gate() };
    const started: string[] = [];
    const app = new Binden().use(async (context: Context) => {
      const { pathname } = context.url;
      started.push(pathname);
      await gates[pathname as keyof typeof gates].promise;
      await context.send(pathname);
    });
    const { server, port } = await listen(app);
    const client = await connection(port);
    client.socket.write(
      "GET /a HTTP/1.1\r\nHost: localhost\r\n\r\nGET /b HTTP/1.1\r\nHost: localhost\r\n\r\n",
    );
    while (started.length < 2) {
      await sleep(5);
    }

    const closing = shutdown(server);
    gates["/b"].open();
    await sleep(20);
    gates["/a"].open();
    await within(closing);
    await within(client.closed);
    const [first = "", second = ""] = client
      .received()
      .split(/(?=HTTP\/1\.1 )/u);
    // The first response keeps the connection open for the second one
    ok(first.startsWith("HTTP/1.1 200 OK"), first);
    ok(/\r\nConnection: keep-alive\r\n/iu.test(first), first);
    ok(first.endsWith("/a"), first);
    ok(second.startsWith("HTTP/1.1 200 OK"), second);
    ok(/\r\nConnection: close\r\n/iu.test(second), second);
    ok(second.endsWith("/b"), second);
  });

  test("a request that arrives once closing keeps the connection open for its `503`", async () => {
    const gates = { "/a": gate(), "/b": gate() };
    const started: string[] = [];
    const app = new Binden().use(async (context: Context) => {
      const { pathname } = context.url;
      started.push(pathname);
      await gates[pathname as keyof typeof gates].promise;
      await context.send(pathname);
    });
    const { server, port } = await listen(app);
    const requests: string[] = [];
    server.on("request", (request: BindenRequest) => {
      requests.push(request.url ?? "");
    });
    const client = await connection(port);
    client.socket.write(
      "GET /a HTTP/1.1\r\nHost: localhost\r\n\r\nGET /b HTTP/1.1\r\nHost: localhost\r\n\r\n",
    );
    while (started.length < 2) {
      await sleep(5);
    }

    const closing = shutdown(server);
    // The newest request of the connection once the server is closing
    client.socket.write("GET /c HTTP/1.1\r\nHost: localhost\r\n\r\n");
    while (requests.length < 3) {
      await sleep(5);
    }
    gates["/a"].open();
    gates["/b"].open();
    await within(closing);
    await within(client.closed);
    const replies = client.received().split(/(?=HTTP\/1\.1 )/u);
    deepStrictEqual(
      replies.map((reply) => [
        reply.split("\r\n", 1)[0],
        /\r\nConnection: (?<value>[\w-]+)\r\n/iu.exec(reply)?.groups?.value,
      ]),
      [
        ["HTTP/1.1 200 OK", "keep-alive"],
        ["HTTP/1.1 200 OK", "keep-alive"],
        ["HTTP/1.1 503 Service Unavailable", "close"],
      ],
    );
    deepStrictEqual(started, ["/a", "/b"]);
  });

  test("closes a connection that is kept alive once its response is complete", async () => {
    const release = gate();
    const app = new Binden().use(async (context: Context) => {
      // The headers are sent before the shutdown: they keep the connection alive
      context.response.writeHead(200, { "Content-Length": 1 });
      context.response.flushHeaders();
      await release.promise;
      context.response.end("a");
      context.done = true;
    });
    const { server, port } = await listen(app);
    const client = await connection(port);
    client.socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
    await client.waitFor("Content-Length: 1\r\n");
    ok(/\r\nConnection: keep-alive\r\n/iu.test(client.received()));

    const before = Date.now();
    const closing = shutdown(server);
    release.open();
    await within(closing);
    await within(client.closed);
    // Not after the keep-alive timeout of the server
    ok(Date.now() - before < 1000);
  });

  test("aborts the requests that take longer than `timeout`", async () => {
    const started = gate();
    let reason: unknown = null;
    const app = new Binden().use(async (context: Context) => {
      context.signal.addEventListener("abort", () => {
        ({ reason } = context.signal.reason as BindenAbortError);
      });
      started.open();
      await never();
    });
    const { server, port } = await listen(app);
    // The connection is closed
    const response = rejects(send(port));
    await started.promise;

    const before = Date.now();
    await within(shutdown(server, { timeout: 50 }));
    ok(Date.now() - before >= 40);
    deepStrictEqual(reason, "shutdown");
    await response;
  });

  test("closes the upgraded connections once `timeout` has passed", async () => {
    const app = new Binden();
    const { server, port } = await listen(app);
    server.on("upgrade", (_request, socket: Socket) => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n",
      );
    });
    const client = await connection(port);
    client.socket.write(
      "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n",
    );
    await client.waitFor("101 Switching Protocols");

    await within(shutdown(server, { timeout: 30 }));
    await within(client.closed);
  });

  test("rejects when the cleanups take longer than `cleanup_timeout`", async () => {
    const captured = capture();
    const app = new Binden({ logger: captured.logger }).use(
      (context: Context) => {
        context.onCleanup(never);
        return context.send("ok");
      },
    );
    const { server, port } = await listen(app);
    deepStrictEqual((await send(port)).body, "ok");
    const kept = await connection(port);
    kept.socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
    await kept.waitFor("\r\n\r\nok");

    await rejects(
      within(shutdown(server, { cleanup_timeout: 30 })),
      new Error("The cleanup of the requests has not completed within 30 ms"),
    );
    const record = await captured.waitFor("The shutdown has failed");
    deepStrictEqual(record.failure, { type: "Error", location: "shutdown" });
  });

  test("frames the connection of the reply of a deadline, whose response is sealed", async () => {
    for (const pipelined of [false, true]) {
      const handled = gate();
      const app = new Binden({
        timeout: 20,
        error_handler: async (context: Context): Promise<void> => {
          await handled.promise;
          await context.status(503).send("deadline");
        },
      }).use(async () => {
        await never();
      });
      const { server, port } = await listen(app);
      const client = await connection(port);
      client.socket.write("GET /a HTTP/1.1\r\nHost: localhost\r\n\r\n");
      // Past the deadline: the response is sealed, the error handler waits
      await sleep(60);
      const closing = shutdown(server);
      if (pipelined) {
        // It arrives once closing: the reply before it keeps the connection
        client.socket.write("GET /b HTTP/1.1\r\nHost: localhost\r\n\r\n");
        await sleep(20);
      }
      handled.open();
      await within(closing);
      await within(client.closed);
      const [first = "", second = ""] = client
        .received()
        .split(/(?=HTTP\/1\.1 )/u);
      ok(first.startsWith("HTTP/1.1 503 "), first);
      if (pipelined) {
        ok(/\r\nConnection: keep-alive\r\n/iu.test(first), first);
        ok(second.startsWith("HTTP/1.1 503 "), second);
        ok(/\r\nConnection: close\r\n/iu.test(second), second);
      } else {
        ok(/\r\nConnection: close\r\n/iu.test(first), first);
      }
    }
  });

  test("before `listen()`, and once closed, waits for the cleanups only", async () => {
    const app = new Binden();
    const unused = app.createServer();
    await within(shutdown(unused));
    ok(isClosing(unused) && !unused.listening);

    const closed = await listen(app);
    await closed.close();
    await within(shutdown(closed.server));
    ok(isClosing(closed.server));
  });

  test("once closed, waits for the connections that are left", async () => {
    const release = gate();
    const app = new Binden().use(async (context: Context) => {
      await release.promise;
      await context.send("done");
    });
    const { server, port } = await listen(app);
    const client = await connection(port);
    client.socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
    await sleep(20);
    // Not listening, with a connection left
    server.close();
    const closing = shutdown(server);
    release.open();
    await within(closing);
    await within(client.closed);
    ok(client.received().endsWith("done"));
    ok(/\r\nConnection: close\r\n/iu.test(client.received()));
  });

  test("a server that is about to listen is closed once it listens", async () => {
    const app = new Binden().use((context: Context) => context.send("ok"));
    const server = app.createServer();
    const listeners = ["listening", "close", "error"].map((name) =>
      server.listenerCount(name),
    );
    // Bound once the address has been looked up (on the next tick)
    server.listen(0, "127.0.0.1");
    ok(!server.listening);
    const bound = once(server, "listening");
    try {
      await within(shutdown(server));
      await bound;
      ok(!server.listening);
      deepStrictEqual(
        ["listening", "close", "error"].map((name) =>
          server.listenerCount(name),
        ),
        listeners,
      );
    } finally {
      // Not left listening by a failure
      server.close();
    }
  });

  test("a `listen()` that has not completed within `timeout` is cancelled", async () => {
    const lookups: (() => void)[] = [];
    // The address of the host is looked up once the shutdown has given up
    mock.method(dns, "lookup", (...args: unknown[]): void => {
      const callback = args.at(-1) as (
        error: null,
        address: string,
        family: number,
      ) => void;
      lookups.push(() => {
        callback(null, "127.0.0.1", 4);
      });
    });
    const captured = capture();
    const app = new Binden({ logger: captured.logger });
    const server = app.createServer();
    const listeners = ["listening", "close", "error"].map((name) =>
      server.listenerCount(name),
    );
    try {
      server.listen(0, "binden.test");
      ok(!server.listening);
      const start = performance.now();
      await rejects(
        within(shutdown(server, { timeout: 50 })),
        new Error("The server has not started listening within 50 ms"),
      );
      ok(performance.now() - start < 1000);
      deepStrictEqual(
        ["listening", "close", "error"].map((name) =>
          server.listenerCount(name),
        ),
        listeners,
      );
      await captured.waitFor("The shutdown has failed");
      // Looked up now: the server does not listen
      deepStrictEqual(lookups.length, 1);
      for (const lookup of lookups) {
        lookup();
      }
      await sleep(20);
      ok(!server.listening);
    } finally {
      mock.restoreAll();
      server.close();
    }
  });

  test("the `timeout` covers the wait for a pending `listen()` and the drain", async () => {
    const aborted = Promise.withResolvers<number>();
    const app = new Binden().use(async (context: Context) => {
      context.signal.addEventListener("abort", () => {
        aborted.resolve(performance.now());
      });
      await never();
    });
    const { server, port } = await listen(app);
    // A request in progress on a connection of a server that listens again
    const client = await connection(port);
    client.socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
    await sleep(20);
    server.close();
    mock.method(dns, "lookup", (...args: unknown[]): void => {
      const callback = args.at(-1) as (
        error: null,
        address: string,
        family: number,
      ) => void;
      // Looked up after 2/3 of the `timeout`
      setTimeout(callback, 200, null, "127.0.0.1", 4);
    });
    try {
      server.listen(0, "binden.test");
      const start = performance.now();
      await within(shutdown(server, { timeout: 300 }));
      // Aborted at the `timeout` of the whole shutdown, not of the drain
      const elapsed = (await aborted.promise) - start;
      ok(elapsed >= 250 && elapsed < 450, `${elapsed} ms`);
    } finally {
      mock.restoreAll();
      client.socket.destroy();
      server.close();
    }
  });

  test("a server whose `listen()` fails rejects the shutdown with its error", async () => {
    const busy = createServer();
    busy.listen(0, "127.0.0.1");
    await once(busy, "listening");
    const { port } = busy.address() as { port: number };
    const captured = capture();
    const app = new Binden({ logger: captured.logger });
    const server = app.createServer();
    const listeners = ["listening", "close", "error"].map((name) =>
      server.listenerCount(name),
    );
    try {
      server.listen(port, "127.0.0.1");
      // Without an `error` listener of the application: the shutdown has it
      await rejects(within(shutdown(server)), { code: "EADDRINUSE" });
      ok(isClosing(server) && !server.listening);
      deepStrictEqual(
        ["listening", "close", "error"].map((name) =>
          server.listenerCount(name),
        ),
        listeners,
      );
      const record = await captured.waitFor("The shutdown has failed");
      deepStrictEqual(record.failure, {
        type: "Error",
        code: "EADDRINUSE",
        location: "shutdown",
      });
    } finally {
      busy.close();
    }
  });

  test("a `listen()` that has failed, thrown or been cancelled is not waited for", async () => {
    const busy = createServer();
    busy.listen(0, "127.0.0.1");
    await once(busy, "listening");
    const { port } = busy.address() as { port: number };
    const app = new Binden();
    try {
      const failed = app.createServer();
      failed.listen(port, "127.0.0.1");
      await once(failed, "error");
      await within(shutdown(failed));

      const thrown = app.createServer();
      throws(() => thrown.listen(-1), { code: "ERR_SOCKET_BAD_PORT" });
      await within(shutdown(thrown));

      const cancelled = app.createServer();
      cancelled.listen(0, "127.0.0.1");
      cancelled.close();
      await once(cancelled, "close");
      await within(shutdown(cancelled));
      ok(!cancelled.listening);
    } finally {
      busy.close();
    }
  });

  test("an `error` of a server without a listener of its own still throws", () => {
    const server = new Binden().createServer();
    const error = new Error("An error of the server");
    throws(() => server.emit("error", error), error);
  });

  test("closes one server of an application, not the others", async () => {
    const app = new Binden().use((context: Context) => context.send("ok"));
    const one = await listen(app);
    const other = await listen(app);
    try {
      await within(shutdown(one.server));
      ok(!isClosing(other.server));
      deepStrictEqual((await send(other.port)).body, "ok");
    } finally {
      await other.close();
    }
  });

  test("closes a server that is not registered", async () => {
    const server: Server = createServer((_request, response) => {
      response.end("ok");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    await within(shutdown(server));
    ok(!server.listening);
  });
});

suite("callback()", () => {
  test("handles the requests of a server created with `serverOptions()`", async () => {
    const app = new Binden().use((context: Context) =>
      context.send(String(context.request instanceof BindenRequest)),
    );
    const options = app.serverOptions();
    // The classes of the application, with its options
    ok(options.IncomingMessage.prototype instanceof BindenRequest);
    ok(options.ServerResponse.prototype instanceof BindenResponse);
    const other = new Binden().serverOptions();
    ok(other.IncomingMessage !== options.IncomingMessage);
    ok(other.ServerResponse !== options.ServerResponse);
    const server = createServer(options);
    server.on("request", app.callback(server));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as { port: number };
    try {
      deepStrictEqual((await send(port)).body, "true");
      // The server is registered at once
      const client = await connection(port);
      client.socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
      await client.waitFor("\r\n\r\ntrue");
      await within(shutdown(server));
      await within(client.closed);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  test("closes the connection of a request of a foreign server", async () => {
    const captured = capture();
    const app = new Binden({ logger: captured.logger });
    // Neither the request nor the response of the application
    const other = new Binden().serverOptions();
    for (const options of [
      {},
      { IncomingMessage: other.IncomingMessage },
      // The request of another application
      { ...app.serverOptions(), IncomingMessage: other.IncomingMessage },
      // The response of another application
      { ...app.serverOptions(), ServerResponse: other.ServerResponse },
      { ...app.serverOptions(), ServerResponse: BindenResponse },
    ]) {
      const server = createServer(options);
      server.on("request", app.callback(server));
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const { port } = server.address() as { port: number };
      try {
        await rejects(send(port), { code: "ECONNRESET" });
      } finally {
        server.close();
      }
    }
    await captured.waitFor(
      "The request and the response are not those of the application (`serverOptions()`)",
    );

    // Even with a logger that fails
    const fail = (): never => {
      throw new Error("A failing logger");
    };
    const failing = new Binden({
      logger: {
        fatal: fail,
        error: fail,
        warn: fail,
        info: fail,
        debug: fail,
        trace: fail,
        child: fail,
      },
    });
    const server = createServer();
    server.on("request", failing.callback(server));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as { port: number };
    try {
      await rejects(send(port), { code: "ECONNRESET" });
    } finally {
      server.close();
    }
  });
});
