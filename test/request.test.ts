/* eslint-disable init-declarations */
import { deepEqual, ok } from "node:assert/strict";
import { Server, createServer } from "node:http";
import { stringify, parse } from "node:querystring";
import fetch from "node-fetch";

import {
  Range,
  BindenRequest,
  Forwarded,
  Cookie,
  IfModifiedSince,
} from "../index.js";

const port = 8080;
const url = `http://localhost:${port}`;

suite("BindenRequest", () => {
  let server: Server<typeof BindenRequest>;

  setup((done) => {
    server = createServer({ IncomingMessage: BindenRequest }).listen(
      port,
      done,
    );
  });

  test(".accept_encoding", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (request, response) => {
        try {
          deepEqual(request.accept_encoding.length, 4);

          deepEqual(request.accept_encoding[0].encoding, "*");
          deepEqual(request.accept_encoding[0].q_value, null);

          deepEqual(request.accept_encoding[1].encoding, "x-gzip");
          deepEqual(request.accept_encoding[1].q_value, 0.3);

          deepEqual(request.accept_encoding[2].encoding, "br");
          deepEqual(request.accept_encoding[2].q_value, 0.2);

          deepEqual(request.accept_encoding[3].encoding, "compress");
          deepEqual(request.accept_encoding[3].q_value, 0.15);
        } catch (error) {
          reject(error);
        } finally {
          response.end(resolve);
        }
      });
    });
    await fetch(url, {
      headers: { "Accept-Encoding": "compress;q=0.15,br;q=0.2,x-gzip;q=0.3,*" },
    });
    await serverPromise;
  });

  test(".authorization", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (request, response) => {
        try {
          deepEqual(request.authorization?.type, "Basic");
          deepEqual(
            request.authorization.credentials,
            "YWxhZGRpbjpvcGVuc2VzYW1l",
          );
        } catch (error) {
          reject(error);
        } finally {
          response.end(resolve);
        }
      });
    });
    await fetch(url, {
      headers: { Authorization: "Basic YWxhZGRpbjpvcGVuc2VzYW1l" },
    });
    await serverPromise;
  });

  test(".content_encoding", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (request, response) => {
        try {
          const { content_encoding } = request;
          deepEqual(content_encoding.length, 3);

          deepEqual(content_encoding[0].encoding, "x-gzip");
          deepEqual(content_encoding[0].q_value, null);

          deepEqual(content_encoding[1].encoding, "br");
          deepEqual(content_encoding[1].q_value, null);

          deepEqual(content_encoding[2].encoding, "compress");
          deepEqual(content_encoding[2].q_value, null);
        } catch (error) {
          reject(error);
        } finally {
          response.end(resolve);
        }
      });
    });
    await fetch(url, {
      headers: { "Content-Encoding": "compress, br, x-gzip" },
    });
    await serverPromise;
  });

  test(".content_type", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (request, response) => {
        try {
          const { content_type } = request;
          ok(content_type);
          deepEqual(content_type.charset, null);
          deepEqual(content_type.type, "multipart/form-data");
          deepEqual(content_type.boundary, "something");
        } catch (error) {
          reject(error);
        } finally {
          response.end(resolve);
        }
      });
    });
    await fetch(url, {
      headers: { "Content-Type": "multipart/form-data; boundary=something" },
    });
    await serverPromise;
  });

  test(".id", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (request, response) => {
        try {
          const { id } = request;
          ok(id);
          ok(typeof id === "string");
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

  test("secure", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (request, response) => {
        try {
          deepEqual(request.secure, false);
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

  test("protocol", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (request, response) => {
        try {
          deepEqual(request.protocol, "http:");
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

  test(".query()", async () => {
    const query = { a: 1, b: ["2", "3"], c: "4" };
    const expected = { ...parse(stringify(query)) };
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (request, response) => {
        try {
          ok(Array.isArray(request.query.b));
          deepEqual(request.query.b.pop(), "3");
          deepEqual(request.query, expected);
        } catch (error) {
          reject(error);
        } finally {
          response.end(resolve);
        }
      });
    });

    const urlQuery = new URL(url);
    urlQuery.search = stringify(query);
    await fetch(urlQuery.toString());
    await serverPromise;
  });

  test(".body", async () => {
    const body = { a: 1 } as Record<string, number>;
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (request, response) => {
        try {
          deepEqual(typeof request.body, "undefined");
          request.body = body;
          deepEqual(request.body, body);
          request.body = {};
          deepEqual(request.body, body);
          body.b = 3;
          deepEqual(request.body, body);
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

  test(".cookies", async () => {
    const cookie = new Cookie({ key: "key", value: "value" });
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (request, response) => {
        try {
          deepEqual(request.cookies, [cookie]);
          deepEqual(request.cookies[0].key, cookie.key);
          deepEqual(request.cookies[0].value, cookie.value);
          deepEqual(request.cookies[0].secure, cookie.secure);
          deepEqual(request.cookies[0].domain, cookie.domain);
          deepEqual(request.cookies[0].expires, cookie.expires);
          deepEqual(request.cookies[0].http_only, cookie.http_only);
          deepEqual(request.cookies[0].max_age, cookie.max_age);
          deepEqual(request.cookies[0].path, cookie.path);
          deepEqual(request.cookies[0].same_site, cookie.same_site);
        } catch (error) {
          reject(error);
        } finally {
          response.end(resolve);
        }
      });
    });

    await fetch(url, { headers: { Cookie: "key=value" } });
    await serverPromise;
  });

  test(".forwarded", async () => {
    const forwarded = new Forwarded({ for: "8:8:8:8", proto: "https" });
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (request, response) => {
        try {
          deepEqual(request.protocol, "https:");
          ok(request.secure);
          deepEqual(request.forwarded, [forwarded]);
          deepEqual(request.forwarded[0].for, forwarded.for);
          deepEqual(request.forwarded[0].proto, forwarded.proto);
          deepEqual(request.forwarded[0].by, forwarded.by);
          deepEqual(request.forwarded[0].secret, forwarded.secret);
          deepEqual(request.forwarded[0].host, forwarded.host);
        } catch (error) {
          reject(error);
        } finally {
          response.end(resolve);
        }
      });
    });

    await fetch(url, { headers: { Forwarded: "for=8:8:8:8;proto=https" } });
    await serverPromise;
  });

  test(".if_modified_since", async () => {
    const ims = new IfModifiedSince({ date: new Date() });
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (request, response) => {
        try {
          ok(request.if_modified_since);
          deepEqual(
            request.if_modified_since.date,
            new Date(ims.date.toUTCString()),
          );
          deepEqual(request.if_modified_since.toString(), ims.toString());
        } catch (error) {
          reject(error);
        } finally {
          response.end(resolve);
        }
      });
    });
    await fetch(url, { headers: { "If-Modified-Since": ims.toString() } });
    await serverPromise;
  });

  test(".range", async () => {
    const range = new Range({ start: 0, end: 499 });
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (request, response) => {
        try {
          deepEqual(request.range.length, 1);
          const [actual] = request.range;
          ok(actual instanceof Range);
          deepEqual(actual.start, range.start);
          deepEqual(actual.end, range.end);
          deepEqual(actual.toString(), range.toString());
        } catch (error) {
          reject(error);
        } finally {
          response.end(resolve);
        }
      });
    });
    await fetch(url, { headers: { Range: range.toString() } });
    await serverPromise;
  });

  test(".URL", async () => {
    const newUrl = new URL("/p/a/t/h?a=1&a=2&b=3c", url);
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (request, response) => {
        try {
          deepEqual(request.URL, newUrl);
        } catch (error) {
          reject(error);
        } finally {
          response.end(resolve);
        }
      });
    });

    await fetch(newUrl.toString());
    await serverPromise;
  });

  test(".header()", async () => {
    const value = "some value";
    const headers = { "X-CUSTOM-HEADER": value };
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (request, response) => {
        try {
          deepEqual(request.header("X-CUSTOM-HEADER"), value);
          deepEqual(request.header("x-custom-header"), value);
        } catch (error) {
          reject(error);
        } finally {
          response.end(resolve);
        }
      });
    });

    await fetch(url, { headers });
    await serverPromise;
  });

  teardown((done) => server.close(done));
});
