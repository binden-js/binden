/* eslint-disable init-declarations */
import { Agent, type Server, request } from "node:http";
import { Binden, BindenError, type Context } from "../index.js";
import { afterEach, beforeEach, suite, test } from "node:test";
import { deepStrictEqual, rejects } from "node:assert";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { once } from "node:events";

/** The status, the body and whether the connection was reused */
interface IExchange {
  status: number;
  body: string;
  reused: boolean;
}

// The other tests use a fresh connection for every request (`test/setup.ts`):
// here every request reuses the one connection of the agent. A response whose
// framing does not match its body leaves the next one waiting for bytes that
// never come, or reading the rest of the previous response.
suite("Keep-alive", () => {
  let server: Server;
  let agent: Agent;

  const routes: Partial<Record<string, (context: Context) => Promise<void>>> = {
    "/ok": (context) => context.send("ok"),
    "/no-content": (context) =>
      context.setHeader("Content-Length", 99).status(204).send(),
    "/reset-content": (context) =>
      context.setHeader("Content-Length", 11).status(205).send("hello world"),
    "/unsatisfiable": (context) =>
      context
        .setHeader("Content-Length", 99)
        .response.sendFile(import.meta.filename),
    "/head": (context) => context.send("abc"),
    "/error": (context) => {
      // The error reply replaces the body that this length was set for
      context.setHeader("Content-Length", 99);
      throw new BindenError(400, { expose: true, message: "error" });
    },
    "/short": (context) =>
      context.setHeader("Content-Length", 10).send(Readable.from(["abc"])),
  };

  const exchange = (
    path: string,
    method = "GET",
    headers: Record<string, string> = {},
  ): Promise<IExchange> =>
    new Promise<IExchange>((resolve, reject) => {
      const { port } = server.address() as AddressInfo;
      const sent = request(
        {
          agent,
          headers,
          method,
          path,
          port,
          signal: AbortSignal.timeout(5000),
        },
        (response) => {
          let body = "";
          response
            .setEncoding("utf8")
            .on("data", (chunk: string) => {
              body += chunk;
            })
            .once("end", () => {
              const status = response.statusCode ?? 0;
              resolve({ status, body, reused: sent.reusedSocket });
            })
            .once("error", reject);
        },
      );
      sent.on("error", reject).end();
    });

  beforeEach(async () => {
    agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const app = new Binden().use(async (context) => {
      await routes[context.url.pathname]?.(context);
    });
    server = app.createServer().listen(0);
    await once(server, "listening");
    // The connection is open: the next request reuses it
    deepStrictEqual(await exchange("/ok"), {
      status: 200,
      body: "ok",
      reused: false,
    });
  });

  afterEach(() => {
    agent.destroy();
    server.closeAllConnections();
    server.close();
  });

  const cases: [string, string, string, Record<string, string>, number][] = [
    ["204 with a stale `Content-Length`", "/no-content", "GET", {}, 204],
    ["205 with a body", "/reset-content", "GET", {}, 205],
    [
      "416 with a stale `Content-Length`",
      "/unsatisfiable",
      "GET",
      { Range: "bytes=99999999-" },
      416,
    ],
    ["HEAD with a body", "/head", "HEAD", {}, 200],
  ];

  test("an error reply after a `Content-Length`, then another request", async () => {
    deepStrictEqual(await exchange("/error"), {
      status: 400,
      body: "error",
      reused: true,
    });
    deepStrictEqual(await exchange("/ok"), {
      status: 200,
      body: "ok",
      reused: true,
    });
  });

  test("a body shorter than its `Content-Length` closes the connection", async () => {
    // The client knows that the body is truncated
    await rejects(exchange("/short"), { code: "ECONNRESET" });
    deepStrictEqual(await exchange("/ok"), {
      status: 200,
      body: "ok",
      reused: false,
    });
  });

  for (const [name, path, method, headers, status] of cases) {
    test(`${name}, then another request`, async () => {
      deepStrictEqual(await exchange(path, method, headers), {
        status,
        body: "",
        reused: true,
      });
      deepStrictEqual(await exchange("/ok"), {
        status: 200,
        body: "ok",
        reused: true,
      });
    });
  }
});
