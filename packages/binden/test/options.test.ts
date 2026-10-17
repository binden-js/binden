import {
  Binden,
  type Context,
  type IBindenOptions,
  shutdown,
} from "../index.js";
import {
  type ICaptured,
  type IListening,
  capture,
  listen,
  never,
  pollUntil,
  send,
  sleep,
} from "./helpers.js";
import { deepStrictEqual, ok, throws } from "node:assert/strict";
import { suite, test } from "node:test";
import { connect } from "node:net";
import { once } from "node:events";

/** Runs `fn` with a listening application (with a captured debug logger) */
async function withApp(
  options: IBindenOptions,
  setup: (app: Binden) => void,
  fn: (listening: IListening, captured: ICaptured) => Promise<void>,
): Promise<void> {
  const captured = capture();
  const app = new Binden({ ...options, logger: captured.logger });
  setup(app);
  const listening = await listen(app);
  try {
    await fn(listening, captured);
  } finally {
    await listening.close();
  }
}

suite("Request and response options", () => {
  test("are validated by the constructor", () => {
    const invalid: [IBindenOptions, Error][] = [
      [
        { trust_proxy: -1 },
        new RangeError("`trust_proxy` is not a non-negative integer"),
      ],
      [
        { trust_proxy: "yes" as unknown as boolean },
        new TypeError("`trust_proxy` is not a boolean, number or function"),
      ],
      [
        { allowed_hosts: [] },
        new RangeError("`allowed_hosts` is empty: no request is allowed"),
      ],
      [
        { allowed_hosts: ["a b"] },
        new TypeError("`allowed_hosts` has an invalid host: a b"),
      ],
      [
        { encoded_slashes: 1 as unknown as boolean },
        new TypeError("`encoded_slashes` is not a boolean"),
      ],
      [
        { request_id: { echo: "no" as unknown as boolean } },
        new TypeError("`request_id.echo` is not a boolean"),
      ],
      [
        { query: { max_keys: 0 } },
        new RangeError("`query.max_keys` is not a positive integer"),
      ],
      [
        { etag: "yes" as unknown as boolean },
        new TypeError("`etag` is not a boolean"),
      ],
    ];
    for (const [options, error] of invalid) {
      throws(() => new Binden(options), error);
    }
  });

  test("apply to the requests and the responses of the application", async () => {
    await withApp(
      {
        trust_proxy: { trust: 1, headers: "x-forwarded" },
        allowed_hosts: ["127.0.0.1"],
        query: { max_keys: 1 },
        etag: true,
      },
      (app) => {
        app.use((context: Context) =>
          context.json({
            ip: context.request.ip,
            protocol: context.request.protocol,
            query: context.request.query,
          }),
        );
      },
      async ({ port }) => {
        const response = await send(port, {
          path: "/?a=1&b=2",
          headers: {
            "X-Forwarded-For": "1.2.3.4",
            "X-Forwarded-Proto": "https",
          },
        });
        deepStrictEqual(JSON.parse(response.body), {
          ip: "1.2.3.4",
          protocol: "https:",
          query: { a: "1" },
        });
        ok(typeof response.headers.etag === "string");
        // Not an allowed host
        const refused = await send(port, { headers: { Host: "evil.test" } });
        deepStrictEqual(refused.status, 400);
      },
    );
  });

  test("are the options of one application only", async () => {
    const defaults = new Binden().use((context: Context) =>
      context.json({ ip: context.request.ip }),
    );
    await withApp(
      { trust_proxy: true, encoded_slashes: true },
      () => {
        // Nothing
      },
      async () => {
        const listening = await listen(defaults);
        try {
          const response = await send(listening.port, {
            headers: { Forwarded: "for=1.2.3.4" },
          });
          // The peer: the proxies are not trusted
          ok((JSON.parse(response.body) as { ip: string }).ip !== "1.2.3.4");
          // No ETag by default
          ok(!("etag" in response.headers));
          deepStrictEqual(
            (await send(listening.port, { path: "/a%2Fb" })).status,
            400,
          );
        } finally {
          await listening.close();
        }
      },
    );
  });

  test("an invalid request is refused (400) before the stack runs", async () => {
    let reached = false;
    await withApp(
      { allowed_hosts: ["localhost"], access_log: { path: "path" } },
      (app) => {
        app.use(() => {
          reached = true;
        });
      },
      async ({ port }, captured) => {
        const requests = [
          // Dot-segments, and an invalid percent-encoding
          { path: "/a/../b" },
          { path: "/%zz" },
          // An encoded slash (without `encoded_slashes`)
          { path: "/a%2Fb" },
          // A scheme that is not HTTP, and userinfo
          { path: "ftp://localhost/x" },
          { path: "http://user:secret@localhost/x" },
          // An invalid host, and a host that is not allowed
          { headers: { Host: "a b" } },
          { headers: { Host: "evil.test" } },
        ];
        for (const options of requests) {
          const { status } = await send(port, options);
          deepStrictEqual(status, 400, JSON.stringify(options));
        }
        // Several `Host` field lines
        const socket = connect(port, "127.0.0.1");
        await once(socket, "connect");
        socket.end(
          "GET / HTTP/1.1\r\nHost: localhost\r\nHost: evil.test\r\nConnection: close\r\n\r\n",
        );
        const [chunk] = (await once(socket.setEncoding("utf8"), "data")) as [
          string,
        ];
        ok(chunk.startsWith("HTTP/1.1 400"), chunk);
        await once(socket, "close");
        deepStrictEqual(reached, false);
        // Logged without failing: the access log does not read the URL
        const records = captured.records.filter(
          ({ msg }) => msg === "The request has completed",
        );
        deepStrictEqual(records.length, requests.length + 1);
        ok(!captured.output().includes("secret"));
      },
    );
  });

  test("a callback that does not return a boolean is a server error (500)", async () => {
    await withApp(
      {
        allowed_hosts: (() => "yes") as unknown as (host: string) => boolean,
      },
      (app) => {
        app.use((context: Context) => context.send("ok"));
      },
      async ({ port }, captured) => {
        deepStrictEqual((await send(port)).status, 500);
        const record = await captured.waitFor("The request has failed");
        deepStrictEqual(
          [record.level, (record.failure as { type: string }).type],
          [50, "TypeError"],
        );
      },
    );
    await withApp(
      { trust_proxy: (() => 1) as unknown as () => boolean },
      (app) => {
        app.use((context: Context) => context.send("ok"));
      },
      async ({ port }) => {
        deepStrictEqual((await send(port)).status, 500);
      },
    );
  });
});

suite("Request ids", () => {
  test("are sent back by every reply with `request_id.echo`", async () => {
    const release = Promise.withResolvers<null>();
    await withApp(
      { request_id: {}, timeout: 30 },
      (app) => {
        app.use("/ok", (context: Context) => context.send(context.id));
        app.use("/hangs", async () => {
          await never();
        });
        app.use("/slow", async (context: Context) => {
          context.setTimeout(0);
          // The headers keep the connection alive
          context.response.writeHead(200, { "Content-Length": 1 });
          context.response.flushHeaders();
          await release.promise;
          context.response.end("a");
          context.done = true;
        });
      },
      async ({ port, server }) => {
        const ok200 = await send(port, { path: "/ok" });
        deepStrictEqual(ok200.headers["x-request-id"], ok200.body);
        // An error reply and the deadline
        const ids: unknown[] = [
          (await send(port, { path: "/missing" })).headers["x-request-id"],
          (await send(port, { path: "/hangs" })).headers["x-request-id"],
        ];
        // A request that arrives on an open connection once closing
        const client = connect(port, "127.0.0.1");
        await once(client, "connect");
        let received = "";
        client.setEncoding("utf8").on("data", (chunk: string) => {
          received += chunk;
        });
        client.write("GET /slow HTTP/1.1\r\nHost: localhost\r\n\r\n");
        await pollUntil(() => received.includes("Content-Length: 1"));
        const closing = shutdown(server, { timeout: 1000 });
        client.write("GET /ok HTTP/1.1\r\nHost: localhost\r\n\r\n");
        await sleep(20);
        release.resolve(null);
        await closing;
        await once(client, "close");
        const [, second = ""] = received.split(/(?=HTTP\/1\.1 )/u);
        ok(second.startsWith("HTTP/1.1 503"), received);
        ids.push(/\r\nx-request-id: (?<id>[^\r]+)/iu.exec(second)?.groups?.id);
        for (const id of ids) {
          ok(typeof id === "string" && /^[\da-f-]{36}$/u.test(id), String(id));
        }
      },
    );
  });

  test("an incoming id, a header name, and no echo", async () => {
    await withApp(
      { request_id: { header: "X-Trace", trust_incoming: true } },
      (app) => {
        app.use((context: Context) => context.send());
      },
      async ({ port }) => {
        const { headers } = await send(port, {
          headers: { "X-Trace": "abc.1" },
        });
        deepStrictEqual(headers["x-trace"], "abc.1");
        ok(!("x-request-id" in headers));
      },
    );
    await withApp(
      { request_id: { echo: false } },
      (app) => {
        app.use((context: Context) => context.send());
      },
      async ({ port }) => {
        ok(!("x-request-id" in (await send(port)).headers));
      },
    );
  });

  test("the opaque reply of a failed error handler sends it back", async () => {
    await withApp(
      {
        request_id: {},
        error_handler: (): never => {
          throw new Error("A failing error handler");
        },
      },
      (app) => {
        app.use(() => {
          throw new Error("A failure");
        });
      },
      async ({ port }) => {
        const response = await send(port);
        deepStrictEqual(response.status, 500);
        ok(typeof response.headers["x-request-id"] === "string");
      },
    );
  });
});
