/* eslint-disable init-declarations */
import { deepStrictEqual, ok, throws } from "node:assert";
import { Server, createServer } from "node:http";
import { type AddressInfo, Socket } from "node:net";
import { TLSSocket } from "node:tls";
import { stringify, parse } from "node:querystring";
import { afterEach, beforeEach, suite, test } from "node:test";
import fetch from "node-fetch";

import {
  Range,
  BindenError,
  BindenRequest,
  Forwarded,
  Cookie,
  IfModifiedSince,
  type IRequestOptions,
  type IRequestOptionsInput,
  type ITrustProxy,
  validateRequestOptions,
} from "../index.js";

/** The port of a listening server */
function portOf(server: { address(): unknown }): number {
  return (server.address() as AddressInfo).port;
}

let url = "";

suite("BindenRequest", () => {
  let server: Server<typeof BindenRequest>;

  beforeEach((_t, done) => {
    server = createServer({ IncomingMessage: BindenRequest }).listen(0, () => {
      url = `http://localhost:${portOf(server)}`;
      done();
    });
  });

  test(".accept_encoding", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (request, response) => {
        try {
          deepStrictEqual(request.accept_encoding.length, 4);

          deepStrictEqual(request.accept_encoding[0].encoding, "*");
          deepStrictEqual(request.accept_encoding[0].q_value, null);

          deepStrictEqual(request.accept_encoding[1].encoding, "x-gzip");
          deepStrictEqual(request.accept_encoding[1].q_value, 0.3);

          deepStrictEqual(request.accept_encoding[2].encoding, "br");
          deepStrictEqual(request.accept_encoding[2].q_value, 0.2);

          deepStrictEqual(request.accept_encoding[3].encoding, "compress");
          deepStrictEqual(request.accept_encoding[3].q_value, 0.15);
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

  test(".accepts() and the like (content negotiation)", () => {
    const request = new BindenRequest(new Socket());
    // Without the headers: the first offer
    deepStrictEqual(
      request.accepts("text/html", "application/json"),
      "text/html",
    );
    deepStrictEqual(request.acceptsCharsets("utf-8", "latin1"), "utf-8");
    deepStrictEqual(request.acceptsEncodings("gzip", "identity"), "gzip");
    deepStrictEqual(request.acceptsLanguages("en", "fr"), "en");
    deepStrictEqual(request.accepts(), false);

    request.headers = {
      accept: "application/json, text/*;q=0.5",
      "accept-charset": "latin1;q=0.5, utf-8",
      "accept-encoding": "br, gzip;q=0.5",
      "accept-language": "fr, en;q=0.5",
    };
    deepStrictEqual(
      request.accepts("text/html", "application/json"),
      "application/json",
    );
    deepStrictEqual(request.accepts("image/png"), false);
    deepStrictEqual(request.acceptsCharsets("latin1", "utf-8"), "utf-8");
    deepStrictEqual(request.acceptsEncodings("gzip", "br"), "br");
    deepStrictEqual(request.acceptsLanguages("en", "fr"), "fr");
    throws(() => request.accepts("html"), TypeError);
  });

  test(".authorization", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (request, response) => {
        try {
          deepStrictEqual(request.authorization?.type, "Basic");
          deepStrictEqual(
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

  test(".content_encoding (an unknown coding)", () => {
    const request = new BindenRequest(new Socket());
    request.headers = { "content-encoding": "gzip, foo" };

    deepStrictEqual(request.content_encoding, null);
    // Parsed once
    deepStrictEqual(request.content_encoding, null);
  });

  test(".content_encoding", async () => {
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (request, response) => {
        try {
          const { content_encoding } = request;
          deepStrictEqual(
            content_encoding?.map(({ encoding }) => encoding),
            ["x-gzip", "br", "compress"],
          );
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
          deepStrictEqual(content_type.charset, null);
          deepStrictEqual(content_type.type, "multipart/form-data");
          deepStrictEqual(content_type.boundary, "something");
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
          deepStrictEqual(request.secure, false);
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
          deepStrictEqual(request.protocol, "http:");
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
          deepStrictEqual(request.query.b.pop(), "3");
          deepStrictEqual(request.query, expected);
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
          deepStrictEqual(request.cookies, [cookie]);
          deepStrictEqual(request.cookies[0].key, cookie.key);
          deepStrictEqual(request.cookies[0].value, cookie.value);
          deepStrictEqual(request.cookies[0].secure, cookie.secure);
          deepStrictEqual(request.cookies[0].domain, cookie.domain);
          deepStrictEqual(request.cookies[0].expires, cookie.expires);
          deepStrictEqual(request.cookies[0].http_only, cookie.http_only);
          deepStrictEqual(request.cookies[0].max_age, cookie.max_age);
          deepStrictEqual(request.cookies[0].path, cookie.path);
          deepStrictEqual(request.cookies[0].same_site, cookie.same_site);
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

  test(".URL (an invalid `Host`)", () => {
    const request = new BindenRequest(new Socket());
    request.url = "/";
    request.headers = { host: "a b" };

    throws(
      () => request.URL,
      (error: unknown) => error instanceof BindenError && error.status === 400,
    );
  });

  test(".URL (request-targets)", () => {
    const create = (
      target: string,
      method = "GET",
      host = "trusted.test",
    ): BindenRequest => {
      const request = new BindenRequest(new Socket());
      request.url = target;
      request.method = method;
      request.headers = { host };
      return request;
    };
    const valid: [string, string, string][] = [
      ["/p?a=1", "GET", "http://trusted.test/p?a=1"],
      // A path, not the authority of a network-path reference
      ["//evil.test/x", "GET", "http://trusted.test//evil.test/x"],
      [
        "/a%20b/:@!$&'()*+,;=",
        "GET",
        "http://trusted.test/a%20b/:@!$&'()*+,;=",
      ],
      ["/a?b?c", "GET", "http://trusted.test/a?b?c"],
      ["/a??b", "GET", "http://trusted.test/a??b"],
      ["/a?", "GET", "http://trusted.test/a"],
      ["/...", "GET", "http://trusted.test/..."],
      // Absolute-form: its authority, but the protocol of the connection
      ["https://evil.test/x?y", "GET", "http://evil.test/x?y"],
      ["HTTP://evil.test:8080", "GET", "http://evil.test:8080/"],
      ["http://evil.test?x=1", "GET", "http://evil.test/?x=1"],
      ["*", "OPTIONS", "http://trusted.test/*"],
    ];
    for (const [target, method, expected] of valid) {
      deepStrictEqual(create(target, method).URL.href, expected, target);
    }
    deepStrictEqual(create("https://evil.test/x").secure, false);
    // Of the connection: known without a valid URL
    deepStrictEqual(create("/%zz", "GET", "a b").secure, false);
    // Without a request-target (not parsed from a request): `/`
    const bare = create("/");
    Reflect.deleteProperty(bare, "url");
    deepStrictEqual(bare.URL.href, "http://trusted.test/");
    // Without `Host` (e.g. HTTP/1.0)
    const anonymous = create("/");
    anonymous.headers = {};
    throws(
      () => anonymous.URL,
      (error: unknown) => error instanceof BindenError && error.status === 400,
    );

    const invalid: [string, string, string][] = [
      ["/\\evil.test/x", "GET", "trusted.test"],
      ["/%zz", "GET", "trusted.test"],
      ["/a%2", "GET", "trusted.test"],
      ["/a#b", "GET", "trusted.test"],
      ["/a?b#c", "GET", "trusted.test"],
      // Dot-segments (also percent-encoded) route to another path
      ["/a/../b", "GET", "trusted.test"],
      ["/a/./b", "GET", "trusted.test"],
      ["/..", "GET", "trusted.test"],
      ["/a/%2e%2E/b", "GET", "trusted.test"],
      ["/a/.%2e", "GET", "trusted.test"],
      ["http://user:pw@trusted.test/x", "GET", "trusted.test"],
      ["http://user@trusted.test/x", "GET", "trusted.test"],
      ["ftp://trusted.test/x", "GET", "trusted.test"],
      ["http:///x", "GET", "trusted.test"],
      ["*", "GET", "trusted.test"],
      ["x", "GET", "trusted.test"],
      ["?a", "GET", "trusted.test"],
      // `Host` is only a host and a port
      ["/", "GET", "trusted.test/x"],
      ["/", "GET", "user@trusted.test"],
      ["/", "GET", "trusted.test#x"],
      ["/", "GET", ""],
    ];
    for (const [target, method, host] of invalid) {
      throws(
        () => create(target, method, host).URL,
        (error: unknown) =>
          error instanceof BindenError && error.status === 400,
        `${target} (Host: ${host})`,
      );
    }
  });

  test(".secure (the protocol of the connection)", () => {
    const tls = new TLSSocket(new Socket());
    const request = new BindenRequest(tls);
    request.url = "http://trusted.test/";
    deepStrictEqual(request.secure, true);
    tls.destroy();
  });

  test(".query (`query.max_keys`)", () => {
    const create = (input?: IRequestOptionsInput): BindenRequest => {
      const options = validateRequestOptions(input);
      class Limited extends BindenRequest {
        // eslint-disable-next-line class-methods-use-this -- a fixture
        protected override get options(): IRequestOptions {
          return options;
        }
      }
      const request = new Limited(new Socket());
      request.url = `/?${Array.from({ length: 1002 }, (_, i) => `k${i}=${i}`).join("&")}`;
      request.headers = { host: "localhost" };
      return request;
    };
    // 1000 keys by default, the others are ignored
    deepStrictEqual(Object.keys(create().query).length, 1000);
    deepStrictEqual(Object.keys(create().query).at(-1), "k999");
    const two = create({ query: { max_keys: 2 } }).query;
    deepStrictEqual(two, { k0: "0", k1: "1" });
    deepStrictEqual(
      Object.keys(create({ query: { max_keys: Infinity } }).query).length,
      1002,
    );
    deepStrictEqual(Object.keys(create({ query: {} }).query).length, 1000);
    // The default options of a request
    const request = new BindenRequest(new Socket());
    request.url = "/?a=1&b=2";
    request.headers = { host: "localhost" };
    deepStrictEqual(request.query, { a: "1", b: "2" });
  });

  test(".trust_proxy (deprecated)", () => {
    class Trusting extends BindenRequest {
      // eslint-disable-next-line class-methods-use-this -- a fixture
      protected override get trust_proxy(): ITrustProxy {
        return 1;
      }
    }
    const socket = new Socket();
    Object.defineProperty(socket, "remoteAddress", { value: "10.0.0.1" });
    const request = new Trusting(socket);
    request.headers = { forwarded: "for=1.1.1.1;proto=https" };
    // The default `options` take it
    deepStrictEqual([request.ip, request.protocol], ["1.1.1.1", "https:"]);
    socket.destroy();
  });

  test(".query (keeps its prototype)", () => {
    const request = new BindenRequest(new Socket());
    request.url = "/?__proto__=a&__proto__=b&x=1";
    request.headers = { host: "localhost" };
    const { query } = request;

    deepStrictEqual(Object.getPrototypeOf(query), Object.prototype);
    deepStrictEqual(
      Object.getOwnPropertyDescriptor(query, "__proto__")?.value,
      ["a", "b"],
    );
    deepStrictEqual(query.x, "1");
    deepStrictEqual(Object.keys(query).sort(), ["__proto__", "x"]);
  });

  test(".forwarded", async () => {
    const forwarded = new Forwarded({ for: "8:8:8:8", proto: "https" });
    const serverPromise = new Promise<void>((resolve, reject) => {
      server.once("request", (request, response) => {
        try {
          // A client can send the header: proxies are not trusted by default
          deepStrictEqual(request.protocol, "http:");
          ok(!request.secure);
          deepStrictEqual(request.forwarded, [forwarded]);
          deepStrictEqual(request.forwarded[0].for, forwarded.for);
          deepStrictEqual(request.forwarded[0].proto, forwarded.proto);
          deepStrictEqual(request.forwarded[0].by, forwarded.by);
          deepStrictEqual(request.forwarded[0].secret, forwarded.secret);
          deepStrictEqual(request.forwarded[0].host, forwarded.host);
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
          deepStrictEqual(
            request.if_modified_since.date,
            new Date(ims.date.toUTCString()),
          );
          deepStrictEqual(request.if_modified_since.toString(), ims.toString());
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
          deepStrictEqual(request.range.length, 1);
          const [actual] = request.range;
          ok(actual instanceof Range);
          deepStrictEqual(actual.start, range.start);
          deepStrictEqual(actual.end, range.end);
          deepStrictEqual(actual.toString(), range.toString());
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
          deepStrictEqual(request.URL, newUrl);
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
          deepStrictEqual(request.header("X-CUSTOM-HEADER"), value);
          deepStrictEqual(request.header("x-custom-header"), value);
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

  afterEach((_t, done) => server.close(done));
});

suite("validateRequestOptions()", () => {
  test("defaults", () => {
    const options = validateRequestOptions();
    deepStrictEqual(options, {
      trust_proxy: { trust: false, headers: "forwarded" },
      query: { max_keys: 1000 },
    });
    ok(Object.isFrozen(options));
    ok(Object.isFrozen(options.query));
    ok(Object.isFrozen(options.trust_proxy));
    deepStrictEqual(validateRequestOptions({}), options);
    // Other options are ignored
    deepStrictEqual(
      validateRequestOptions({ auto_head: true } as IRequestOptionsInput),
      options,
    );
  });

  test("`trust_proxy`", () => {
    const trust = (): boolean => true;
    deepStrictEqual(validateRequestOptions({ trust_proxy: 2 }).trust_proxy, {
      trust: 2,
      headers: "forwarded",
    });
    deepStrictEqual(
      validateRequestOptions({
        trust_proxy: { trust, headers: "x-forwarded" },
      }).trust_proxy,
      { trust, headers: "x-forwarded" },
    );
    throws(
      () => validateRequestOptions({ trust_proxy: -1 }),
      new RangeError("`trust_proxy` is not a non-negative integer"),
    );
    throws(
      () =>
        validateRequestOptions({ trust_proxy: "1" as unknown as ITrustProxy }),
      new TypeError("`trust_proxy` is not a boolean, number or function"),
    );
  });

  test("`query`", () => {
    deepStrictEqual(validateRequestOptions({ query: { max_keys: 1 } }).query, {
      max_keys: 1,
    });
    deepStrictEqual(
      validateRequestOptions({ query: { max_keys: Infinity } }).query,
      { max_keys: Infinity },
    );
    for (const max_keys of [0, -1, 1.5, Number.NaN, 2 ** 53, -Infinity]) {
      throws(
        () => validateRequestOptions({ query: { max_keys } }),
        new RangeError("`query.max_keys` is not a positive integer"),
        `${max_keys}`,
      );
    }
    throws(
      () =>
        validateRequestOptions({
          query: { max_keys: "1" as unknown as number },
        }),
      new TypeError("`query.max_keys` is not a number"),
    );
    for (const query of [null, 1, "a"]) {
      throws(
        () =>
          validateRequestOptions({
            query: query as unknown as IRequestOptionsInput["query"],
          }),
        new TypeError("`query` is not an object"),
      );
    }
    for (const input of [null, 1, "a"]) {
      throws(
        () => validateRequestOptions(input as unknown as IRequestOptionsInput),
        new TypeError("`options` is not an object"),
      );
    }
  });
});
