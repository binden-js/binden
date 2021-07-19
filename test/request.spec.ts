import { deepStrictEqual, ok } from "assert";
import { Server, ServerResponse, createServer } from "http";
import { stringify, parse } from "querystring";
import fetch from "node-fetch";

import { KauaiRequest, Forwarded, Cookie } from "../index.js";

const port = 8080;
const url = `http://localhost:${port}`;

suite("KauaiRequest", () => {
  let server: Server;

  setup((done) => {
    server = createServer({ IncomingMessage: KauaiRequest }).listen(port, done);
  });

  test("secure", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once(
        "request",
        (request: KauaiRequest, response: ServerResponse) => {
          try {
            deepStrictEqual(request.secure, false);
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

  test("protocol", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once(
        "request",
        (request: KauaiRequest, response: ServerResponse) => {
          try {
            deepStrictEqual(request.protocol, "http");
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

  test(".query()", async () => {
    const query = { a: 1, b: ["2", "3"], c: "4" };
    const expected = { ...parse(stringify(query)) };
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once(
        "request",
        (request: KauaiRequest, response: ServerResponse) => {
          try {
            ok(Array.isArray(request.query.b));
            deepStrictEqual(request.query.b?.pop(), "3");
            deepStrictEqual(request.query, expected);
          } catch (error) {
            reject(error);
          } finally {
            response.end(resolve);
          }
        }
      );
    });

    const urlQuery = new URL(url);
    urlQuery.search = stringify(query);
    await fetch(urlQuery.toString());
    await serverPromise;
  });

  test(".body", async () => {
    const body = { a: 1 } as Record<string, number>;
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once(
        "request",
        (request: KauaiRequest, response: ServerResponse) => {
          try {
            deepStrictEqual(typeof request.body, "undefined");
            request.body = body;
            deepStrictEqual(request.body, body);
            request.body = {};
            deepStrictEqual(request.body, body);
            body.b = 3;
            deepStrictEqual(request.body, body);
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

  test(".cookies", async () => {
    const cookie = new Cookie({ key: "key", value: "value" });
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once(
        "request",
        (request: KauaiRequest, response: ServerResponse) => {
          try {
            deepStrictEqual(typeof request.cookies, "undefined");
            request.cookies = [cookie];
            deepStrictEqual(request.cookies, [cookie]);
            deepStrictEqual(request.cookies[0].key, cookie.key);
            deepStrictEqual(request.cookies[0].value, cookie.value);
            request.cookies = [];
            deepStrictEqual(request.cookies, [cookie]);
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

  test(".forwarded", async () => {
    const forwarded = new Forwarded({ for: "8:8:8:8", proto: "https" });
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once(
        "request",
        (request: KauaiRequest, response: ServerResponse) => {
          try {
            deepStrictEqual(request.protocol, "http");
            ok(!request.secure);
            deepStrictEqual(typeof request.forwarded, "undefined");
            request.forwarded = [forwarded];
            deepStrictEqual(request.protocol, "https");
            ok(request.secure);
            deepStrictEqual(request.forwarded, [forwarded]);
            deepStrictEqual(request.forwarded[0].for, forwarded.for);
            deepStrictEqual(request.forwarded[0].proto, forwarded.proto);
            request.forwarded = [];
            deepStrictEqual(request.protocol, "https");
            ok(request.secure);
            deepStrictEqual(request.forwarded, [forwarded]);
            deepStrictEqual(request.forwarded[0].for, forwarded.for);
            deepStrictEqual(request.forwarded[0].proto, forwarded.proto);
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

  test(".URL", async () => {
    const newUrl = new URL("/p/a/t/h?a=1&a=2&b=3c", url);
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once(
        "request",
        (request: KauaiRequest, response: ServerResponse) => {
          try {
            deepStrictEqual(request.URL, newUrl);
          } catch (error) {
            reject(error);
          } finally {
            response.end(resolve);
          }
        }
      );
    });

    await fetch(newUrl.toString());
    await serverPromise;
  });

  test(".header()", async () => {
    const value = "some value";
    const headers = { "X-CUSTOM-HEADER": value };
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once(
        "request",
        (request: KauaiRequest, response: ServerResponse) => {
          try {
            deepStrictEqual(request.header("X-CUSTOM-HEADER"), value);
            deepStrictEqual(request.header("x-custom-header"), value);
          } catch (error) {
            reject(error);
          } finally {
            response.end(resolve);
          }
        }
      );
    });

    await fetch(url, { headers });
    await serverPromise;
  });

  teardown((done) => server.close(done));
});
