/* eslint-disable init-declarations, class-methods-use-this, @typescript-eslint/no-throw-literal */
import { deepEqual, throws } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Server } from "node:http";
import { Agent } from "node:https";
import fetch from "node-fetch";

import {
  DefaultErrorCode,
  Binden,
  BindenError,
  IBindenErrorOptions,
  Middleware,
  IMiddlewareParams,
  Context,
  Router,
  ct_text,
  ct_json,
  ct_html,
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

const port = 8080;
const url = `http://localhost:${port}`;

suite("Binden", () => {
  let app: Binden;
  let server: Server;

  setup((done) => {
    app = new Binden();
    server = app.createServer().listen(port, done);
  });

  test(".createSecureServer()", async () => {
    const newApp = new Binden();
    const path = new URL(url);
    const agent = new Agent({ rejectUnauthorized: false });
    path.port = `${Number(path.port) + 1}`;
    path.protocol = "https:";

    const key = await readFile("./test/cert/key.pem", { encoding: "utf-8" });
    const cert = await readFile("./test/cert/cert.pem", { encoding: "utf-8" });

    const newServer = newApp.createSecureServer({ key, cert });

    await new Promise<void>((resolve) => {
      newServer.listen(port + 1, resolve);
    });

    const m = new SendMiddleware();
    newApp.use(m);
    const response = await fetch(path.toString(), { agent });
    deepEqual(response.status, 200);
    const data = await response.text();
    deepEqual(data, m.id);

    await new Promise((resolve) => {
      newServer.close(resolve);
    });
  });

  test("stack (use/off)", () => {
    const m1 = new CustomMiddleware();
    const m2 = new CustomMiddleware();
    const m3 = new CustomMiddleware();
    const r1 = new Router();
    const r2 = new Router();

    const reg = new RegExp("Something", "u");

    deepEqual(app.stack, []);

    deepEqual(app.use().stack, []);

    deepEqual(app.use("/path", m1).stack, [[[m1], "/path"]]);

    throws(() => {
      app.use("/", {} as Router);
    }, new TypeError("Unsupported Middleware/Router"));

    deepEqual(app.use("/path", m2).stack, [[[m1, m2], "/path"]]);

    deepEqual(app.off(), []);
    deepEqual(app.stack, [[[m1, m2], "/path"]]);

    deepEqual(app.use("/path", r2, m3).stack, [[[m1, m2, r2, m3], "/path"]]);

    deepEqual(app.use("/path2", r1).stack, [
      [[m1, m2, r2, m3], "/path"],
      [[r1], "/path2"],
    ]);

    deepEqual(app.use(m3).stack, [
      [[m1, m2, r2, m3], "/path"],
      [[r1], "/path2"],
      [[m3], null],
    ]);

    deepEqual(app.use(m2).stack, [
      [[m1, m2, r2, m3], "/path"],
      [[r1], "/path2"],
      [[m3, m2], null],
    ]);

    deepEqual(app.use(reg, m3, r1, m1).stack, [
      [[m1, m2, r2, m3], "/path"],
      [[r1], "/path2"],
      [[m3, m2], null],
      [[m3, r1, m1], reg],
    ]);

    deepEqual(app.off(m3), [m3]);
    deepEqual(app.stack, [
      [[m1, m2, r2, m3], "/path"],
      [[r1], "/path2"],
      [[m2], null],
      [[m3, r1, m1], reg],
    ]);

    deepEqual(app.use(m3).stack, [
      [[m1, m2, r2, m3], "/path"],
      [[r1], "/path2"],
      [[m2], null],
      [[m3, r1, m1], reg],
      [[m3], null],
    ]);

    deepEqual(app.off(reg, r1), [r1]);
    deepEqual(app.stack, [
      [[m1, m2, r2, m3], "/path"],
      [[r1], "/path2"],
      [[m2], null],
      [[m3, m1], reg],
      [[m3], null],
    ]);

    deepEqual(app.off(reg, m1, m3), [m1, m3]);
    deepEqual(app.stack, [
      [[m1, m2, r2, m3], "/path"],
      [[r1], "/path2"],
      [[m2, m3], null],
    ]);

    deepEqual(app.use("/path3", m3).stack, [
      [[m1, m2, r2, m3], "/path"],
      [[r1], "/path2"],
      [[m2, m3], null],
      [[m3], "/path3"],
    ]);

    deepEqual(app.off(m2, m3), [m2, m3]);
    deepEqual(app.stack, [
      [[m1, m2, r2, m3], "/path"],
      [[r1], "/path2"],
      [[m3], "/path3"],
    ]);

    deepEqual(app.off("/path", m1, m2, r2, m3), [m1, m2, r2, m3]);
    deepEqual(app.stack, [
      [[r1], "/path2"],
      [[m3], "/path3"],
    ]);

    deepEqual(app.off("/path2", m3, r1), [r1]);
    deepEqual(app.stack, [[[m3], "/path3"]]);

    deepEqual(app.off("/path3", m3, r1), [m3]);
    deepEqual(app.stack, []);
  });

  test("Disabled middleware", async () => {
    const m1 = new SendMiddleware({ disabled: true });
    const m2 = new SendMiddleware();
    app.use(m1, m2);
    const response = await fetch(url);
    deepEqual(response.status, 200);
    const text = await response.text();
    deepEqual(text, m2.id);
  });

  test("auto_head", async () => {
    const m = new SendMiddleware();
    app.use("/", new Router().get(m));
    const response = await fetch(url, { method: "HEAD" });
    deepEqual(response.status, 200);
  });

  test("function middlewares", async () => {
    const message = { message: "Hello World!" };
    const m = (context: Context): Promise<void> => context.json(message);
    app.use("/", new Router().get(m));
    const response = await fetch(url);
    const data = await response.json();
    deepEqual(response.status, 200);
    deepEqual(data, message);
  });

  test("Middleware `ignore_errors === true`", async () => {
    const m1 = new SendMiddleware();
    const m2 = new ErrorMiddleware({ ignore_errors: true });
    app.use(m2, m1);
    const response = await fetch(url);
    deepEqual(response.status, 200);
    const text = await response.text();
    deepEqual(text, m1.id);
  });

  test("404 error (context.done === false)", async () => {
    app.use(new CustomMiddleware());
    const response = await fetch(url);
    deepEqual(response.status, 404);
  });

  test("404 error (Empty `guarded` router)", async () => {
    app.use(new Router({ guarded: true }));
    const response = await fetch(url, { method: "POST" });
    deepEqual(response.status, 404);
    deepEqual(response.headers.get("Allow"), null);
  });

  test("405 error (`guarded` router)", async () => {
    const m = new CustomMiddleware();
    const router = new Router({ guarded: true }).patch(m).get(m);
    app.use(router);
    const response = await fetch(url, { method: "POST" });
    deepEqual(response.status, 405);
    deepEqual(response.headers.get("Allow"), "PATCH, GET, HEAD");
  });

  test("405 error (`guarded` router `auto_head === false`)", async () => {
    const newApp = new Binden({ auto_head: false });
    const path = new URL(url);
    path.port = `${Number(path.port) + 1}`;

    const newServer = newApp.createServer();

    await new Promise<void>((resolve) => {
      newServer.listen(port + 1, resolve);
    });

    const m = new CustomMiddleware();
    const router = new Router({ guarded: true }).patch(m).get(m);
    newApp.use(router);
    const response = await fetch(path.toString(), { method: "POST" });
    deepEqual(response.status, 405);
    deepEqual(response.headers.get("Allow"), "PATCH, GET");

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
      path.port = `${Number(path.port) + 1}`;

      const newServer = newApp.createServer();

      await new Promise<void>((resolve) => {
        newServer.listen(port + 1, resolve);
      });

      const status = 405;
      const message = "Hello World!";
      const expose = true;
      newApp.use(new ErrorMiddleware({}, status, { message, expose }));

      const response = await fetch(path.toString());
      deepEqual(response.status, 401);
      deepEqual(response.headers.get("X-HEADER"), "Value");

      const text = await response.text();
      deepEqual(text, "Secret");

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

      deepEqual(response.status, DefaultErrorCode);
      deepEqual(response.headers.get("Content-Type"), ct_text);

      const received = await response.text();
      deepEqual(received, message);
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

      deepEqual(response.status, DefaultErrorCode);
      deepEqual(response.headers.get("Content-Type"), null);

      const received = await response.text();
      deepEqual(received, "");
    });

    test("errorHadler (`expose === true`)", async () => {
      const status = 405;
      const message = "Hello World!";
      const expose = true;
      app.use(new ErrorMiddleware({}, status, { message, expose }));

      const response = await fetch(url);

      deepEqual(response.status, status);
      deepEqual(response.headers.get("Content-Type"), ct_text);

      const received = await response.text();

      deepEqual(received, message);
    });

    test("errorHadler (`expose === false`)", async () => {
      const status = 405;
      const message = "Hello World!";
      const expose = false;
      app.use(new ErrorMiddleware({}, status, { message, expose }));

      const response = await fetch(url);

      deepEqual(response.status, status);
      deepEqual(response.headers.get("Content-Type"), null);

      const received = await response.text();

      deepEqual(received, "");
    });

    test("errorHadler (`json`)", async () => {
      const status = 405;
      const message = "Something happend";
      const json = { message: "Hello World!" };
      const expose = true;
      app.use(new ErrorMiddleware({}, status, { message, json, expose }));

      const response = await fetch(url);

      deepEqual(response.status, status);
      deepEqual(response.headers.get("Content-Type"), ct_json);

      const received = await response.json();

      deepEqual(received, json);
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

      deepEqual(response.status, status);
      deepEqual(response.headers.get("Content-Type"), ct_html);

      const received = await response.text();

      deepEqual(received, message);
    });

    test("errorHadler (invalid `json`)", async () => {
      const status = 405;
      const message = "Something happend";
      const json = { message: 1n };
      const expose = true;
      app.use(new ErrorMiddleware({}, status, { message, json, expose }));

      const response = await fetch(url);

      deepEqual(response.status, status);
      deepEqual(response.headers.get("Content-Type"), null);

      const received = await response.text();

      deepEqual(received, "");
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
          deepEqual(context?.response.writableEnded, false);
          deepEqual(context.response.headersSent, true);
          throw this.error;
        }
      }

      app.use(new WM(), new EM());

      const response = await fetch(url);

      deepEqual(response.status, 201);
      deepEqual(response.headers.get("Content-Type"), html);

      const received = await response.text();

      deepEqual(received, message);
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
          deepEqual(context.response.writableEnded, true);
          throw error;
        }
      }

      app.use(new WM(), new EM());

      const response = await fetch(url);

      deepEqual(response.status, status);
      deepEqual(response.headers.get("Content-Type"), html);

      const received = await response.text();

      deepEqual(received, message);
    });
  });

  teardown((done) => server.close(done));
});
