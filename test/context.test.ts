/* eslint-disable init-declarations, @typescript-eslint/no-loop-func */
import { ok, deepEqual } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { Server, createServer } from "node:http";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import fastJSON from "fast-json-stringify";

import {
  Context,
  BindenError,
  BindenRequest,
  BindenResponse,
} from "../index.js";

const port = 18080;
const url = `http://localhost:${port}`;

describe("Context", () => {
  let server: Server<typeof BindenRequest, typeof BindenResponse>;

  beforeEach(async () => {
    await new Promise<void>((resolve) => {
      server = createServer({
        IncomingMessage: BindenRequest,
        ServerResponse: BindenResponse,
      }).listen(port, resolve);
    });
  });

  it("constructor", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (request, response) => {
        try {
          const context = new Context({ request, response });
          ok(context instanceof Context);
          ok(!context.done);
          deepEqual(context.request, request);
          deepEqual(context.response, response);
          deepEqual(typeof context.id, "string");
          deepEqual(context.url, new URL(url));

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

  it(".setHeader()", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (request, response) => {
        try {
          const context = new Context({ request, response });
          const name = "name";
          const value = ["value1", "value2"];

          const mocked = mock.method(response, "setHeader");

          deepEqual(context.setHeader(name, value), context);
          deepEqual(mocked.mock.calls.length, 1);
          const [call] = mocked.mock.calls;
          deepEqual(call.arguments, [name, value]);
          deepEqual(call.result, context.response);
          ok(typeof call.error === "undefined");
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

  it("status", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (request, response) => {
        try {
          const status = 401;
          const context = new Context({ request, response });

          const mocked = mock.method(response, "status");

          deepEqual(context.status(status), context);
          deepEqual(mocked.mock.calls.length, 1);
          const [call] = mocked.mock.calls;
          deepEqual(call.result, context.response);
          deepEqual(call.arguments, [status]);
          ok(typeof call.error === "undefined");
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
    it(`.${method}()`, async () => {
      const serverPromise = new Promise<void>((resolve, reject) => {
        server.once("request", (request, response) => {
          const context = new Context({ request, response });

          const mocked = mock.method(response, method);

          try {
            let promise: Promise<void>;

            if (method === "send") {
              deepEqual(args, params[0][1]);
              promise = context.send(args);
            } else if (method === "sendFile") {
              writeFileSync(args, randomUUID());
              deepEqual(args, params[1][1]);
              promise = context.sendFile(args);
            } else if (method === "form") {
              deepEqual(args, params[2][1]);
              promise = context.form(args);
            } else if (method === "html") {
              deepEqual(args, params[3][1]);
              promise = context.html(args);
            } else if (method === "json") {
              deepEqual(args, params[4][1]);
              promise = context.json(args);
            } else {
              deepEqual(args, params[5][1]);
              promise = context.text(args);
            }

            promise
              .then(() => {
                deepEqual(mocked.mock.calls.length, 1);
                const [call] = mocked.mock.calls;
                ok(typeof call.result !== "undefined");
                deepEqual(call.arguments, [args]);
                ok(typeof call.error === "undefined");
                deepEqual(context.done, true);
                if (method === "sendFile") {
                  rmSync(args);
                }
                call.result
                  .then((res) => {
                    ok(typeof res === "undefined");
                  })
                  .catch(reject)
                  .finally(() => context.response.end(resolve));
              })
              .catch(reject);
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

  it(".json() (with a custom `stringify`)", async () => {
    const json = { currency: "💶", value: 120 };
    const stringify = fastJSON({
      title: "Example Schema",
      type: "object",
      properties: {
        currency: {
          type: "string",
        },
        value: {
          type: "integer",
        },
      },
      required: ["currency", "value"],
      additionalProperties: false,
    });
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (request, response) => {
        const context = new Context({ request, response });

        const mocked = mock.method(response, "json");

        context
          .json(json, stringify)
          .then(() => {
            deepEqual(context.done, true);
            deepEqual(mocked.mock.calls.length, 1);
            const [call] = mocked.mock.calls;
            ok(typeof call.result !== "undefined");
            deepEqual(call.arguments, [json, stringify]);
            ok(typeof call.error === "undefined");
            call.result
              .then((res) => {
                ok(typeof res === "undefined");
              })
              .catch(reject)
              .finally(() => context.response.end(resolve));
          })
          .catch(reject);
      });
    });
    await fetch(url);
    await serverPromise;
  });

  it(".throw()", async () => {
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
            deepEqual(error.expose, expose);
            deepEqual(error.message, message);
            deepEqual(error.json, json);
            deepEqual(error.status, status);
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

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      mock.reset();
      server.closeIdleConnections();
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  });
});
