/* eslint-disable init-declarations, class-methods-use-this, @typescript-eslint/only-throw-error */
import { deepStrictEqual, ok, rejects, throws } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Server, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { Agent } from "node:https";
import { Readable } from "node:stream";
import { afterEach, beforeEach, suite, test } from "node:test";
import { Logger, type LoggerOptions } from "@binden/logger";
import fetch from "node-fetch";

import {
  DefaultErrorCode,
  Binden,
  BindenError,
  type IBindenErrorOptions,
  type IBindenOptions,
  Middleware,
  type IMiddlewareParams,
  Context,
  Cookie,
  Router,
  ct_text,
  ct_json,
  ct_html,
  serializers,
} from "../index.js";

class CustomMiddleware extends Middleware {
  public readonly id: string;
  public constructor(params?: IMiddlewareParams) {
    super(params);
    this.id = randomUUID();
  }
  public run(context: Context): Context | Promise<Context> | Promise<void> {
    return context;
  }
}
class SendMiddleware extends CustomMiddleware {
  public run(context: Context): Promise<void> {
    return context.send(this.id);
  }
}
class ErrorMiddleware extends CustomMiddleware {
  readonly #error: BindenError;
  public constructor(
    params?: IMiddlewareParams,
    status = 401,
    error_params: IBindenErrorOptions = {},
  ) {
    super(params);
    this.#error = new BindenError(status, error_params);
  }
  public get error(): BindenError {
    return this.#error;
  }
  public run(context: Context | undefined): Promise<never>;
  public run(): Promise<never> {
    return Promise.reject(this.#error);
  }
}

/** The port of a listening server */
function portOf(server: { address(): unknown }): number {
  return (server.address() as AddressInfo).port;
}

let url = "";

interface ILoggedApp {
  app: Binden;
  url: string;
  /** The log lines written so far */
  output(): string;
  close(): Promise<void>;
}

/** An application (on another port) whose debug logs are captured */
async function loggedApp(
  options: IBindenOptions = {},
  logSerializers: LoggerOptions["serializers"] = serializers,
): Promise<ILoggedApp> {
  const lines: string[] = [];
  const destination = {
    write(line: string): void {
      lines.push(line);
    },
  };
  const logger = new Logger({
    destination,
    level: "debug",
    serializers: logSerializers,
  });
  const logged = new Binden({ ...options, logger });
  const loggedServer = logged.createServer();
  await new Promise<void>((resolve) => {
    loggedServer.listen(0, resolve);
  });
  const loggedUrl = `http://localhost:${portOf(loggedServer)}`;
  return {
    app: logged,
    url: loggedUrl,
    output: (): string => lines.join(""),
    close: async (): Promise<void> => {
      loggedServer.closeAllConnections();
      await new Promise((resolve) => {
        loggedServer.close(resolve);
      });
    },
  };
}

suite("Binden", () => {
  let app: Binden;
  let server: Server;

  beforeEach((_t, done) => {
    app = new Binden();
    server = app.createServer().listen(0, () => {
      url = `http://localhost:${portOf(server)}`;
      done();
    });
  });

  test(".createSecureServer()", async () => {
    const newApp = new Binden();
    const path = new URL(url);
    const agent = new Agent({ rejectUnauthorized: false });
    path.protocol = "https:";

    const key = await readFile("./test/cert/key.pem", { encoding: "utf-8" });
    const cert = await readFile("./test/cert/cert.pem", { encoding: "utf-8" });

    const newServer = newApp.createSecureServer({ key, cert });

    await new Promise<void>((resolve) => {
      newServer.listen(0, resolve);
    });
    path.port = `${portOf(newServer)}`;

    const m = new SendMiddleware();
    let protocol = "";
    newApp.use((context: Context) => {
      ({ protocol } = context.request);
    }, m);
    // An untrusted `Forwarded` does not change the protocol of the connection
    const headers = { Forwarded: "for=1.2.3.4" };
    const response = await fetch(path.toString(), { agent, headers });
    deepStrictEqual(response.status, 200);
    const data = await response.text();
    deepStrictEqual(data, m.id);
    deepStrictEqual(protocol, "https:");

    await new Promise((resolve) => {
      newServer.close(resolve);
    });
  });

  test("`trust_proxy`", async () => {
    const protocols: string[] = [];
    const record = (context: Context): Promise<void> => {
      protocols.push(context.request.protocol);
      return context.send();
    };
    app.use(record);
    const trusting = await loggedApp({ trust_proxy: 1 });
    try {
      trusting.app.use(record);
      const headers = { Forwarded: "for=1.2.3.4;proto=https" };
      const signal = AbortSignal.timeout(5000);

      await fetch(url, { headers, signal });
      await fetch(trusting.url, { headers, signal });

      deepStrictEqual(protocols, ["http:", "https:"]);
    } finally {
      await trusting.close();
    }

    for (const trust_proxy of [-1, 1.5, Number.NaN]) {
      throws(() => new Binden({ trust_proxy }), RangeError);
    }
  });

  test("stack (use/off)", () => {
    const m1 = new CustomMiddleware();
    const m2 = new CustomMiddleware();
    const m3 = new CustomMiddleware();
    const r1 = new Router();
    const r2 = new Router();

    const reg = new RegExp("Something", "u");

    deepStrictEqual(app.stack, []);

    deepStrictEqual(app.use().stack, []);

    deepStrictEqual(app.use("/path", m1).stack, [[[m1], "/path"]]);

    throws(() => {
      app.use("/", {} as Router);
    }, new TypeError("Unsupported Middleware/Router"));

    deepStrictEqual(app.use("/path", m2).stack, [[[m1, m2], "/path"]]);

    deepStrictEqual(app.off(), []);
    deepStrictEqual(app.stack, [[[m1, m2], "/path"]]);

    deepStrictEqual(app.use("/path", r2, m3).stack, [
      [[m1, m2, r2, m3], "/path"],
    ]);

    deepStrictEqual(app.use("/path2", r1).stack, [
      [[m1, m2, r2, m3], "/path"],
      [[r1], "/path2"],
    ]);

    deepStrictEqual(app.use(m3).stack, [
      [[m1, m2, r2, m3], "/path"],
      [[r1], "/path2"],
      [[m3], null],
    ]);

    deepStrictEqual(app.use(m2).stack, [
      [[m1, m2, r2, m3], "/path"],
      [[r1], "/path2"],
      [[m3, m2], null],
    ]);

    deepStrictEqual(app.use(reg, m3, r1, m1).stack, [
      [[m1, m2, r2, m3], "/path"],
      [[r1], "/path2"],
      [[m3, m2], null],
      [[m3, r1, m1], reg],
    ]);

    deepStrictEqual(app.off(m3), [m3]);
    deepStrictEqual(app.stack, [
      [[m1, m2, r2, m3], "/path"],
      [[r1], "/path2"],
      [[m2], null],
      [[m3, r1, m1], reg],
    ]);

    deepStrictEqual(app.use(m3).stack, [
      [[m1, m2, r2, m3], "/path"],
      [[r1], "/path2"],
      [[m2], null],
      [[m3, r1, m1], reg],
      [[m3], null],
    ]);

    deepStrictEqual(app.off(reg, r1), [r1]);
    deepStrictEqual(app.stack, [
      [[m1, m2, r2, m3], "/path"],
      [[r1], "/path2"],
      [[m2], null],
      [[m3, m1], reg],
      [[m3], null],
    ]);

    deepStrictEqual(app.off(reg, m1, m3), [m1, m3]);
    deepStrictEqual(app.stack, [
      [[m1, m2, r2, m3], "/path"],
      [[r1], "/path2"],
      [[m2, m3], null],
    ]);

    deepStrictEqual(app.use("/path3", m3).stack, [
      [[m1, m2, r2, m3], "/path"],
      [[r1], "/path2"],
      [[m2, m3], null],
      [[m3], "/path3"],
    ]);

    deepStrictEqual(app.off(m2, m3), [m2, m3]);
    deepStrictEqual(app.stack, [
      [[m1, m2, r2, m3], "/path"],
      [[r1], "/path2"],
      [[m3], "/path3"],
    ]);

    deepStrictEqual(app.off("/path", m1, m2, r2, m3), [m1, m2, r2, m3]);
    deepStrictEqual(app.stack, [
      [[r1], "/path2"],
      [[m3], "/path3"],
    ]);

    deepStrictEqual(app.off("/path2", m3, r1), [r1]);
    deepStrictEqual(app.stack, [[[m3], "/path3"]]);

    deepStrictEqual(app.off("/path3", m3, r1), [m3]);
    deepStrictEqual(app.stack, []);
  });

  test("custom `logger`", async () => {
    const lines: Record<string, unknown>[] = [];
    const destination = {
      write: (line: string): void => {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    };
    const logger = new Logger({ destination, level: "debug", serializers });
    const newApp = new Binden({ logger });
    const path = new URL(url);

    const newServer = newApp.createServer();

    await new Promise<void>((resolve) => {
      newServer.listen(0, resolve);
    });
    path.port = `${portOf(newServer)}`;

    try {
      let id = "";
      newApp.use((context: Context) => {
        ({ id } = context);
        context.log.info("Custom logger");
        throw new BindenError(401);
      });

      const response = await fetch(path.toString());
      deepStrictEqual(response.status, 401);
      deepStrictEqual(
        lines.map(({ msg, trace_id }) => ({ msg, trace_id })),
        [
          { msg: "Custom logger", trace_id: id },
          { msg: "Error should not be exposed", trace_id: id },
        ],
      );
    } finally {
      await new Promise((resolve) => {
        newServer.close(resolve);
      });
    }
  });

  test("logs an error without a constructor (debug)", async () => {
    const logged = await loggedApp();
    try {
      logged.app.use(() => {
        throw Object.assign(new Error("secret-message"), { constructor: null });
      });

      // A deadline: a crashing error handler would never reply
      const response = await fetch(logged.url, {
        signal: AbortSignal.timeout(5000),
      });

      deepStrictEqual(response.status, DefaultErrorCode);
      ok(logged.output().includes(`"error":{"type":"Error"}`), logged.output());
    } finally {
      await logged.close();
    }
  });

  test("does not log a `json` that cannot be stringified", async () => {
    const logged = await loggedApp();
    try {
      logged.app.use(() => {
        throw new BindenError(400, {
          expose: true,
          json: { password: "SECRET", amount: 1n },
        });
      });

      const response = await fetch(logged.url, {
        signal: AbortSignal.timeout(5000),
      });

      deepStrictEqual(response.status, 400);
      deepStrictEqual(await response.text(), "");
      ok(logged.output().includes("`JSON.stringify` failed"));
      ok(!logged.output().includes("SECRET"), logged.output());
    } finally {
      await logged.close();
    }
  });

  test("does not log a `message` that is not a string", async () => {
    const logged = await loggedApp();
    try {
      logged.app.use(() => {
        throw { status: 400, expose: true, message: { password: "SECRET" } };
      });

      const response = await fetch(logged.url, {
        signal: AbortSignal.timeout(5000),
      });

      deepStrictEqual(response.status, 400);
      deepStrictEqual(await response.text(), "");
      ok(logged.output().includes("`message` is not a valid string"));
      ok(!logged.output().includes("SECRET"), logged.output());
    } finally {
      await logged.close();
    }
  });

  test("does not log a `code` that is not a Node.js error code", async () => {
    const logged = await loggedApp();
    try {
      logged.app.use(() => {
        throw Object.assign(new Error("Failed"), { code: "SECRET-CODE" });
      });

      const response = await fetch(logged.url, {
        signal: AbortSignal.timeout(5000),
      });

      deepStrictEqual(response.status, DefaultErrorCode);
      ok(logged.output().includes(`"error":{"type":"Error"}`), logged.output());
      ok(!logged.output().includes("SECRET"), logged.output());
    } finally {
      await logged.close();
    }
  });

  test("logs an allowlist of request details", async () => {
    const logged = await loggedApp();
    try {
      class SECRET_CLASS extends Error {}
      logged.app.use((context: Context) => {
        Object.assign(context, { privateSession: "SECRET_SESSION" });
        throw Object.assign(new SECRET_CLASS("SECRET_MESSAGE"), {
          code: "ERR_SECRET_ABC123",
          [Symbol.toStringTag]: "SECRET_TAG",
        });
      });

      const response = await fetch(`${logged.url}/path?token=SECRET_QUERY`, {
        headers: { "X-Api-Key": "SECRET_KEY", "User-Agent": "binden-test" },
        signal: AbortSignal.timeout(5000),
      });

      deepStrictEqual(response.status, DefaultErrorCode);
      const output = logged.output();
      ok(!output.includes("SECRET"), output);
      ok(output.includes(`"error":{"type":"Error"}`), output);
      ok(output.includes(`"url":"/path"`), output);
      ok(output.includes(`"user-agent":"binden-test"`), output);
    } finally {
      await logged.close();
    }
  });

  test("replies when the logger fails", async () => {
    const logged = await loggedApp(
      {},
      {
        ...serializers,
        error: (): never => {
          throw new Error("A failing serializer");
        },
      },
    );
    try {
      logged.app.use(() => {
        throw new BindenError(401);
      });

      const response = await fetch(logged.url, {
        signal: AbortSignal.timeout(5000),
      });

      deepStrictEqual(response.status, 401);
    } finally {
      await logged.close();
    }
  });

  test("awaits an async `error_handler`", async () => {
    const logged = await loggedApp({
      error_handler: async (context: Context): Promise<void> => {
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
        context.response.status(503).end("later");
      },
    });
    try {
      logged.app.use(() => {
        throw new BindenError(400);
      });

      const response = await fetch(logged.url, {
        signal: AbortSignal.timeout(5000),
      });

      deepStrictEqual(response.status, 503);
      deepStrictEqual(await response.text(), "later");
    } finally {
      await logged.close();
    }
  });

  test("replies by default when the `error_handler` does not", async () => {
    const logged = await loggedApp({
      error_handler: (): void => {
        // Only observes the error
      },
    });
    try {
      logged.app.use(() => {
        throw new BindenError(418, { expose: true, message: "teapot" });
      });

      const response = await fetch(logged.url, {
        signal: AbortSignal.timeout(5000),
      });

      deepStrictEqual(response.status, 418);
      deepStrictEqual(await response.text(), "teapot");
      ok(logged.output().includes("has not replied"), logged.output());
    } finally {
      await logged.close();
    }
  });

  test("closes the connection when an async error handler fails", async () => {
    const logged = await loggedApp({
      error_handler: async (): Promise<void> => {
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
        throw new Error("A failing error handler");
      },
    });
    try {
      logged.app.use(() => {
        throw new BindenError(400);
      });

      // The connection is closed (not left open until the deadline)
      await rejects(
        fetch(logged.url, { signal: AbortSignal.timeout(5000) }),
        (error: Error) => error.name !== "AbortError",
      );
      ok(logged.output().includes("The error handler failed"), logged.output());
    } finally {
      await logged.close();
    }
  });

  test("closes the connection when the error handler fails", async () => {
    const logged = await loggedApp({
      error_handler: (): never => {
        throw new Error("A failing error handler");
      },
    });
    try {
      logged.app.use(() => {
        throw new BindenError(400);
      });

      // The connection is closed (not left open until the deadline)
      await rejects(
        fetch(logged.url, { signal: AbortSignal.timeout(5000) }),
        (error: Error) => error.name !== "AbortError",
      );
      ok(logged.output().includes("The error handler failed"), logged.output());
    } finally {
      await logged.close();
    }
  });

  test("replies 500 to any thrown value", async () => {
    const thrown: Partial<Record<string, () => unknown>> = {
      "/null": () => null,
      // `undefined`
      "/undefined": (): unknown => Reflect.get({}, "nothing"),
      "/string": () => "error",
      "/symbol": () => ({ status: Symbol("status") }),
      "/getter": () => ({
        get status(): never {
          throw new Error("A throwing getter");
        },
      }),
    };
    app.use((context: Context) => {
      throw thrown[context.url.pathname]?.();
    });

    for (const path of Object.keys(thrown)) {
      const response = await fetch(`${url}${path}`, {
        signal: AbortSignal.timeout(5000),
      });
      deepStrictEqual(response.status, 500, path);
      deepStrictEqual(await response.text(), "", path);
    }
  });

  test("replies with an unregistered status code of an error", async () => {
    app.use(() => {
      throw new BindenError(499);
    });

    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });

    deepStrictEqual(response.status, 499);
    await response.text();
  });

  test("sends the cookies of the response with an error reply", async () => {
    app.use((context: Context) => {
      context.response.cookies.add(new Cookie({ key: "session", value: "1" }));
      throw new BindenError(401, { expose: true });
    });

    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });

    deepStrictEqual(response.status, 401);
    ok(response.headers.get("Set-Cookie")?.startsWith("session=1;") === true);
    deepStrictEqual(await response.text(), "Unauthorized");
  });

  test("closes the connection when the `error_handler` does not end its reply", async () => {
    const logged = await loggedApp({
      error_handler: (context: Context): void => {
        context.response.write("partial");
      },
    });
    try {
      logged.app.use(() => {
        throw new BindenError(400);
      });

      // The truncated body is not taken as complete (and not left open): the
      // client may not even get the headers
      const outcome = await fetch(logged.url, {
        signal: AbortSignal.timeout(5000),
      })
        .then(async (response) => response.text())
        .then(
          () => "complete",
          (error: unknown) => (error as Error).name,
        );
      ok(outcome !== "complete" && outcome !== "AbortError", outcome);
      ok(logged.output().includes("has not ended its reply"), logged.output());
    } finally {
      await logged.close();
    }
  });

  test("logs an error reply that cannot be sent", async () => {
    const logged = await loggedApp();
    try {
      logged.app.use((context: Context) => {
        context.request.destroy();
        throw new BindenError(400);
      });

      await rejects(fetch(logged.url, { signal: AbortSignal.timeout(5000) }));
      const deadline = Date.now() + 5000;
      while (
        !logged.output().includes("The error reply has not been sent") &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
      }
      ok(logged.output().includes("The error reply has not been sent"));
    } finally {
      await logged.close();
    }
  });

  test("Disabled middleware", async () => {
    const m1 = new SendMiddleware({ disabled: true });
    const m2 = new SendMiddleware();
    app.use(m1, m2);
    const response = await fetch(url);
    deepStrictEqual(response.status, 200);
    const text = await response.text();
    deepStrictEqual(text, m2.id);
  });

  test("auto_head", async () => {
    const m = new SendMiddleware();
    app.use("/", new Router().get(m));
    const response = await fetch(url, { method: "HEAD" });
    deepStrictEqual(response.status, 200);
  });

  test("auto_head (an explicit `HEAD` middleware)", async () => {
    app.use(
      "/both",
      new Router()
        .get((context: Context) => context.setHeader("X-Handler", "GET").send())
        .head((context: Context) =>
          context.setHeader("X-Handler", "HEAD").send(),
        ),
    );
    app.use(
      "/head",
      new Router({ guarded: true }).head((context: Context) =>
        context.setHeader("X-Handler", "HEAD").send(),
      ),
    );
    const handler = async (path: string, method: string): Promise<unknown> => {
      const response = await fetch(`${url}${path}`, { method });
      await response.text();
      return [response.status, response.headers.get("X-Handler")];
    };

    deepStrictEqual(await handler("/both", "HEAD"), [200, "HEAD"]);
    deepStrictEqual(await handler("/both", "GET"), [200, "GET"]);
    deepStrictEqual(await handler("/head", "HEAD"), [200, "HEAD"]);
  });

  test("RegExp paths keep their flags", async () => {
    // eslint-disable-next-line require-unicode-regexp -- without `u` on purpose
    app.use(/^\/foo$/i, (context: Context) => context.send("foo"));
    // `g` would make `test()` stateful: every other request would not match
    app.use(/^\/bar$/gu, (context: Context) => context.send("bar"));
    // Not valid with `u`
    // eslint-disable-next-line require-unicode-regexp, no-useless-escape -- on purpose
    app.use(/^\/b\-z$/, (context: Context) => context.send("b-z"));
    const text = async (path: string): Promise<string> =>
      (await fetch(`${url}${path}`)).text();

    deepStrictEqual(await text("/FOO"), "foo");
    deepStrictEqual(await text("/bar"), "bar");
    deepStrictEqual(await text("/bar"), "bar");
    deepStrictEqual(await text("/b-z"), "b-z");
    // eslint-disable-next-line require-unicode-regexp -- the flags of the path
    deepStrictEqual(app.stack[0]?.[1], /^\/foo$/i);
  });

  test("function middlewares", async () => {
    const message = { message: "Hello World!" };
    const m = (context: Context): Promise<void> => context.json(message);
    app.use("/", new Router().get(m));
    const response = await fetch(url);
    const data = await response.json();
    deepStrictEqual(response.status, 200);
    deepStrictEqual(data, message);
  });

  test("Middleware `ignore_errors === true`", async () => {
    const m1 = new SendMiddleware();
    const m2 = new ErrorMiddleware({ ignore_errors: true });
    app.use(m2, m1);
    const response = await fetch(url);
    deepStrictEqual(response.status, 200);
    const text = await response.text();
    deepStrictEqual(text, m1.id);
  });

  test("400 error (an invalid `Host`)", async () => {
    // Routing by path needs the URL
    app.use("/", (context: Context) => context.send());

    const status = await new Promise<number | undefined>((resolve, reject) => {
      httpRequest(url, { headers: { host: "a b" } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      })
        .on("error", reject)
        .end();
    });

    deepStrictEqual(status, 400);
  });

  test("400 error (an invalid request-target)", async () => {
    app.use("/b", (context: Context) => context.send("b"));
    // Sent as it is (a URL would be normalized by the client)
    const status = (path: string): Promise<number | undefined> =>
      new Promise((resolve, reject) => {
        httpRequest({ path, port: portOf(server) }, (response) => {
          response.resume();
          resolve(response.statusCode);
        })
          .on("error", reject)
          .end();
      });

    deepStrictEqual(await status("/b"), 200);
    deepStrictEqual(await status("/a/../b"), 400);
    deepStrictEqual(await status("/%zz"), 400);
  });

  test("404 error (context.done === false)", async () => {
    app.use(new CustomMiddleware());
    const response = await fetch(url);
    deepStrictEqual(response.status, 404);
  });

  test("`done` without a response sends an empty one", async () => {
    app.use("/empty", (context: Context) => {
      context.done = true;
    });
    app.use("/no-content", (context: Context) => {
      context.status(204).setHeader("X-Header", "Value").done = true;
    });
    const signal = AbortSignal.timeout(5000);

    const empty = await fetch(`${url}/empty`, { signal });
    deepStrictEqual(empty.status, 200);
    deepStrictEqual(await empty.text(), "");

    const noContent = await fetch(`${url}/no-content`, { signal });
    deepStrictEqual(noContent.status, 204);
    deepStrictEqual(noContent.headers.get("X-Header"), "Value");
  });

  test("`done` with a response that is still starting", async () => {
    // Sends "a" and "b" a little later (as a file is read after the stack)
    const slow = (): Readable => {
      let reading = false;
      return new Readable({
        read(): void {
          if (!reading) {
            reading = true;
            setTimeout(() => {
              this.push("a");
              setTimeout(() => {
                this.push("b");
                this.push(null);
              }, 20);
            }, 20);
          }
        },
      });
    };
    app.use("/send", (context: Context) => {
      context.response.send(slow()).catch(() => {
        // The body then fails the test
      });
      context.done = true;
    });
    app.use("/pipe", (context: Context) => {
      slow().pipe(context.response);
      context.done = true;
    });
    const signal = AbortSignal.timeout(5000);

    deepStrictEqual(
      await (await fetch(`${url}/send`, { signal })).text(),
      "ab",
    );
    deepStrictEqual(
      await (await fetch(`${url}/pipe`, { signal })).text(),
      "ab",
    );
  });

  test("a context of another request is not taken over", async () => {
    let first: Context | null = null;
    app.use((context: Context) => {
      if (first === null) {
        first = context;
        return context.send("first");
      }
      // A replacement must be a context of the same request
      return first;
    });
    const signal = AbortSignal.timeout(5000);

    deepStrictEqual(await (await fetch(url, { signal })).text(), "first");
    const second = await fetch(url, { signal });
    deepStrictEqual(second.status, 500);
    await second.text();
  });

  test("a context of the same request may replace the context", async () => {
    app.use(
      (context: Context) =>
        new Context({ request: context.request, response: context.response }),
      (context: Context) => context.send("replaced"),
    );

    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    deepStrictEqual(await response.text(), "replaced");
  });

  test("a response ended without `done` is not cut by a 404", async () => {
    const size = 32 * 1024 * 1024;
    app.use((context: Context) => {
      context.response.end(Buffer.alloc(size));
    });

    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });

    deepStrictEqual(response.status, 200);
    deepStrictEqual((await response.arrayBuffer()).byteLength, size);
  });

  test("404 error (Empty `guarded` router)", async () => {
    app.use(new Router({ guarded: true }));
    const response = await fetch(url, { method: "POST" });
    deepStrictEqual(response.status, 404);
    deepStrictEqual(response.headers.get("Allow"), null);
  });

  test("405 error (`guarded` router)", async () => {
    const m = new CustomMiddleware();
    const router = new Router({ guarded: true }).patch(m).get(m);
    app.use(router);
    const response = await fetch(url, { method: "POST" });
    deepStrictEqual(response.status, 405);
    deepStrictEqual(response.headers.get("Allow"), "PATCH, GET, HEAD");
  });

  test("405 error (`guarded` router `auto_head === false`)", async () => {
    const newApp = new Binden({ auto_head: false });
    const path = new URL(url);

    const newServer = newApp.createServer();

    await new Promise<void>((resolve) => {
      newServer.listen(0, resolve);
    });
    path.port = `${portOf(newServer)}`;

    const m = new CustomMiddleware();
    const router = new Router({ guarded: true }).patch(m).get(m);
    newApp.use(router);
    const response = await fetch(path.toString(), { method: "POST" });
    deepStrictEqual(response.status, 405);
    deepStrictEqual(response.headers.get("Allow"), "PATCH, GET");

    await new Promise((resolve) => {
      newServer.close(resolve);
    });
  });

  suite("Error handler", () => {
    test("custom `error_handler`", async () => {
      function error_handler(context: Context): void {
        context.response
          .status(401)
          .setHeader("X-HEADER", "Value")
          .end("Secret");
      }
      const newApp = new Binden({ error_handler });
      const path = new URL(url);

      const newServer = newApp.createServer();

      await new Promise<void>((resolve) => {
        newServer.listen(0, resolve);
      });
      path.port = `${portOf(newServer)}`;

      const status = 405;
      const message = "Hello World!";
      const expose = true;
      newApp.use(new ErrorMiddleware({}, status, { message, expose }));

      const response = await fetch(path.toString());
      deepStrictEqual(response.status, 401);
      deepStrictEqual(response.headers.get("X-HEADER"), "Value");

      const text = await response.text();
      deepStrictEqual(text, "Secret");

      await new Promise((resolve) => {
        newServer.close(resolve);
      });
    });

    test("errorHadler (default error code when no `status`)", async () => {
      const status = 405;
      const message = "Hello World!";
      const expose = true;

      class EM extends ErrorMiddleware {
        public run(): Promise<never> {
          throw { expose, message };
        }
      }

      app.use(new EM({}, status, { message, expose }));

      const response = await fetch(url);

      deepStrictEqual(response.status, DefaultErrorCode);
      deepStrictEqual(response.headers.get("Content-Type"), ct_text);

      const received = await response.text();
      deepStrictEqual(received, message);
    });

    test("errorHadler (`message` is not a string)", async () => {
      const status = 405;
      const message = 1;
      const expose = true;

      const regexp = new RegExp("/", "u");

      class EM extends ErrorMiddleware {
        public run(): Promise<never> {
          throw { expose, message };
        }
      }

      app.use(regexp, new EM({}, status, { message: "2", expose }));

      const response = await fetch(url);

      deepStrictEqual(response.status, DefaultErrorCode);
      deepStrictEqual(response.headers.get("Content-Type"), null);

      const received = await response.text();
      deepStrictEqual(received, "");
    });

    test("errorHadler (`expose === true`)", async () => {
      const status = 405;
      const message = "Hello World!";
      const expose = true;
      app.use(new ErrorMiddleware({}, status, { message, expose }));

      const response = await fetch(url);

      deepStrictEqual(response.status, status);
      deepStrictEqual(response.headers.get("Content-Type"), ct_text);

      const received = await response.text();

      deepStrictEqual(received, message);
    });

    test("errorHadler (`expose === false`)", async () => {
      const status = 405;
      const message = "Hello World!";
      const expose = false;
      app.use(new ErrorMiddleware({}, status, { message, expose }));

      const response = await fetch(url);

      deepStrictEqual(response.status, status);
      deepStrictEqual(response.headers.get("Content-Type"), null);

      const received = await response.text();

      deepStrictEqual(received, "");
    });

    test("errorHadler (`json`)", async () => {
      const status = 405;
      const message = "Something happend";
      const json = { message: "Hello World!" };
      const expose = true;
      app.use(new ErrorMiddleware({}, status, { message, json, expose }));

      const response = await fetch(url);

      deepStrictEqual(response.status, status);
      deepStrictEqual(response.headers.get("Content-Type"), ct_json);

      const received = await response.json();

      deepStrictEqual(received, json);
    });

    test("errorHadler (custom `Content-Type`)", async () => {
      const status = 405;
      const message = "<html></html>";
      const expose = true;
      class CTMiddleware extends Middleware {
        public run(context: Context): void {
          context.response.setHeader("Content-Type", ct_html);
        }
      }
      app.use(
        new CTMiddleware(),
        new ErrorMiddleware({}, status, { message, expose }),
      );

      const response = await fetch(url);

      deepStrictEqual(response.status, status);
      deepStrictEqual(response.headers.get("Content-Type"), ct_html);

      const received = await response.text();

      deepStrictEqual(received, message);
    });

    test("errorHadler (invalid `json`)", async () => {
      const status = 405;
      const message = "Something happend";
      const json = { message: 1n };
      const expose = true;
      app.use(new ErrorMiddleware({}, status, { message, json, expose }));

      const response = await fetch(url);

      deepStrictEqual(response.status, status);
      deepStrictEqual(response.headers.get("Content-Type"), null);

      const received = await response.text();

      deepStrictEqual(received, "");
    });

    test(".errorHandler() (`headersSent === true`)", async () => {
      const message = "<html></html>";
      const html = "text/html";

      class WM extends Middleware {
        public run(context: Context): Promise<void> {
          return new Promise<void>((resolve, reject) => {
            context.response
              .set({ "Content-Type": html })
              .status(201)
              .write(message, (err) => {
                if (err) {
                  reject(err);
                } else {
                  resolve();
                }
              });
          });
        }
      }
      class EM extends ErrorMiddleware {
        public run(context?: Context): Promise<never> {
          deepStrictEqual(context?.response.writableEnded, false);
          deepStrictEqual(context.response.headersSent, true);
          throw this.error;
        }
      }

      app.use(new WM(), new EM());

      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });

      deepStrictEqual(response.status, 201);
      deepStrictEqual(response.headers.get("Content-Type"), html);

      // The connection is closed: a truncated body must not look complete
      await rejects(
        response.text(),
        (error: Error) => error.name !== "AbortError",
      );
    });

    test(".errorHandler() (resets the framing of the response)", async () => {
      app.use((context: Context) => {
        context.response.set({
          "Content-Length": 99,
          "Content-Encoding": "gzip",
          ETag: `"etag"`,
          "Set-Cookie": "kept=1",
        });
        throw new BindenError(400, { expose: true, message: "Bad request" });
      });

      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });

      deepStrictEqual(response.status, 400);
      deepStrictEqual(response.headers.get("Content-Encoding"), null);
      deepStrictEqual(response.headers.get("ETag"), null);
      deepStrictEqual(response.headers.get("Set-Cookie"), "kept=1");
      deepStrictEqual(await response.text(), "Bad request");
    });

    test(".errorHandler() (a stream that fails before sending)", async () => {
      app.use(async (context: Context) => {
        const failing = new Readable({
          read(): void {
            this.destroy(new BindenError(503));
          },
        });
        await context.send(failing);
      });

      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });

      deepStrictEqual(response.status, 503);
    });

    test(".errorHandler() (an ended response is not cut)", async () => {
      const size = 32 * 1024 * 1024;
      app.use((context: Context) => {
        context.response.end(Buffer.alloc(size));
        throw new BindenError(500);
      });

      const response = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
      });

      deepStrictEqual(response.status, 200);
      deepStrictEqual((await response.arrayBuffer()).byteLength, size);
    });

    test(".errorHandler() (`writableEnded === true`)", async () => {
      const expose = true;
      const status = 200;
      const message = "<html></html>";
      const html = "text/html";
      const error = new BindenError(500, { expose, message });

      class WM extends Middleware {
        public run(context: Context): Promise<void> {
          return new Promise<void>((resolve) => {
            context.response
              .set({ "Content-Type": html })
              .status(status)
              .end(message, resolve);
          });
        }
      }
      class EM extends Middleware {
        public run(context: Context): Promise<void> {
          deepStrictEqual(context.response.writableEnded, true);
          throw error;
        }
      }

      app.use(new WM(), new EM());

      const response = await fetch(url);

      deepStrictEqual(response.status, status);
      deepStrictEqual(response.headers.get("Content-Type"), html);

      const received = await response.text();

      deepStrictEqual(received, message);
    });
  });

  afterEach((_t, done) => {
    // Also the connections of a failed test, which would keep the process alive
    server.closeAllConnections();
    server.close(done);
  });
});
