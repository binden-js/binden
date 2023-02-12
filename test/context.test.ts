/* eslint-disable init-declarations, @typescript-eslint/no-loop-func */
import { ok, deepStrictEqual } from "node:assert";
import { Server, createServer } from "node:http";
import fetch from "node-fetch";
import sinon from "sinon";

import {
  Context,
  BindenError,
  BindenRequest,
  BindenResponse,
} from "../index.js";

const port = 8080;
const url = `http://localhost:${port}`;

suite("Context", () => {
  let server: Server<typeof BindenRequest, typeof BindenResponse>;

  setup((done) => {
    server = createServer({
      IncomingMessage: BindenRequest,
      ServerResponse: BindenResponse,
    }).listen(port, done);
  });

  test("constructor", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (request, response) => {
        try {
          const context = new Context({ request, response });
          ok(context instanceof Context);
          ok(!context.done);
          deepStrictEqual(context.request, request);
          deepStrictEqual(context.response, response);
          deepStrictEqual(typeof context.id, "string");
          deepStrictEqual(context.url, new URL(url));

          context.done = true;
          ok(context.done);

          context.done = false;
          ok(context.done);
        } catch (error) {
          reject(error);
        } finally {
          response.end(resolve);
        }
      });
    });
    await fetch(url);
    await serverPromise;
  });

  test(".setHeader()", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (request, response) => {
        try {
          const context = new Context({ request, response });
          const name = "name";
          const value = ["value1", "value2"];
          const mock = sinon
            .mock(response)
            .expects("setHeader")
            .once()
            .withExactArgs(name, value);

          deepStrictEqual(context.setHeader(name, value), context);
          mock.verify();
        } catch (error) {
          reject(error);
        } finally {
          response.end(resolve);
        }
      });
    });
    await fetch(url);
    await serverPromise;
  });

  test("status", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (request, response) => {
        try {
          const status = 401;
          const context = new Context({ request, response });

          const mock = sinon
            .mock(response)
            .expects("status")
            .once()
            .withExactArgs(status);

          deepStrictEqual(context.status(status), context);
          mock.verify();
        } catch (error) {
          reject(error);
        } finally {
          response.end(resolve);
        }
      });
    });
    await fetch(url);
    await serverPromise;
  });

  const params = [
    ["send", 1n],
    ["sendFile", "./path.temp"],
    ["form", new URLSearchParams({ item: "123" })],
    ["html", "<html></html>"],
    ["json", { message: "Hello World!" }],
    ["text", "Hello World!"],
  ] as const;

  for (const [method, args] of params) {
    test(`.${method}()`, async () => {
      const serverPromise = new Promise<void>((resolve, reject) => {
        server.once("request", (request, response) => {
          const context = new Context({ request, response });

          const mock = sinon
            .mock(response)
            .expects(method)
            .once()
            .withExactArgs(args);

          try {
            let promise: Promise<void>;

            if (method === "send") {
              deepStrictEqual(args, params[0][1]);
              promise = context.send(args);
            } else if (method === "sendFile") {
              deepStrictEqual(args, params[1][1]);
              promise = context.sendFile(args);
            } else if (method === "form") {
              deepStrictEqual(args, params[2][1]);
              promise = context.form(args);
            } else if (method === "html") {
              deepStrictEqual(args, params[3][1]);
              promise = context.html(args);
            } else if (method === "json") {
              deepStrictEqual(args, params[4][1]);
              promise = context.json(args);
            } else {
              deepStrictEqual(args, params[5][1]);
              promise = context.text(args);
            }

            promise
              .then(() => {
                mock.verify();
                deepStrictEqual(context.done, true);
              })
              .catch(reject)
              .finally(() => context.response.end(resolve));
          } catch (error) {
            context.response.end(() => {
              reject(error);
            });
          }
        });
      });
      await fetch(url);
      await serverPromise;
    });
  }

  test(".throw()", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (request, response) => {
        const status = 401;
        const message = "Text";
        const expose = true;
        const context = new Context({ request, response });
        const json = { message };
        try {
          context.throw(status, { message, expose, json });
          reject(new Error("Should throw `BindenError`"));
        } catch (error: unknown) {
          try {
            ok(error instanceof BindenError);
            deepStrictEqual(error.expose, expose);
            deepStrictEqual(error.message, message);
            deepStrictEqual(error.json, json);
            deepStrictEqual(error.status, status);
          } catch (err) {
            reject(err);
          }
        } finally {
          response.end(resolve);
        }
      });
    });
    await fetch(url);
    await serverPromise;
  });

  teardown((done) => server.close(done));
});
