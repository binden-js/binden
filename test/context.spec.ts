import { ok, deepStrictEqual } from "assert";
import { Server, createServer } from "http";
import fetch from "node-fetch";
import sinon from "sinon";

import {
  Context,
  KauaiError,
  KauaiRequest,
  KauaiResponse,
  IKauaiResponse,
} from "../index.js";

const port = 8080;
const url = `http://localhost:${port}`;

suite("Context", () => {
  let server: Server;

  setup((done) => {
    server = createServer({
      IncomingMessage: KauaiRequest,
      ServerResponse: KauaiResponse,
    }).listen(port, done);
  });

  test("constructor", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once(
        "request",
        (request: KauaiRequest, response: IKauaiResponse) => {
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
        }
      );
    });
    await fetch(url);
    await serverPromise;
  });

  test(".setHeader()", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once(
        "request",
        (request: KauaiRequest, response: IKauaiResponse) => {
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
        }
      );
    });
    await fetch(url);
    await serverPromise;
  });

  test("status", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once(
        "request",
        (request: KauaiRequest, response: IKauaiResponse) => {
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
        }
      );
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
        server.once(
          "request",
          (request: KauaiRequest, response: IKauaiResponse) => {
            const context = new Context({ request, response });

            const mock = sinon
              .mock(response)
              .expects(method)
              .once()
              .withExactArgs(args);

            try {
              /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
              context[method](args as any)
                .then(() => {
                  mock.verify();
                  deepStrictEqual(context.done, true);
                })
                .catch(reject)
                .finally(() => context.response.end(resolve));
            } catch (error) {
              context.response.end(() => reject(error));
            }
          }
        );
      });
      await fetch(url);
      await serverPromise;
    });
  }

  test(".throw()", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once(
        "request",
        (request: KauaiRequest, response: IKauaiResponse) => {
          const status = 401;
          const message = "Text";
          const expose = true;
          const context = new Context({ request, response });
          const json = { message };
          try {
            context.throw(status, { message, expose, json });
            reject(new Error("Should throw `KauaiError`"));
          } catch (error: unknown) {
            try {
              ok(error instanceof KauaiError);
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
        }
      );
    });
    await fetch(url);
    await serverPromise;
  });

  teardown((done) => server.close(done));
});
