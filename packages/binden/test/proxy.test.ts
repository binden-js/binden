import { deepStrictEqual, ok, throws } from "node:assert";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { type AddressInfo, Socket, connect } from "node:net";
import { TLSSocket } from "node:tls";
import { after, suite, test } from "node:test";

import {
  BindenError,
  BindenRequest,
  type IRequestOptions,
  type ITrustProxy,
  validateRequestOptions,
} from "../index.js";

interface IFixture {
  /** The address of the peer (none: `undefined`) */
  peer?: string | null;
  tls?: boolean;
  url?: string;
  method?: string;
}

const sockets: Socket[] = [];

/** A request from `peer` with the field lines, behind the trusted proxies */
function create(
  trust: ITrustProxy,
  fields: [string, string][] = [],
  { peer = "10.0.0.1", tls = false, url = "/", method = "GET" }: IFixture = {},
): BindenRequest {
  class Trusting extends BindenRequest {
    // eslint-disable-next-line class-methods-use-this -- a fixture
    protected override get options(): IRequestOptions {
      // Not checked: a request checks it too
      return { ...validateRequestOptions(), trust_proxy: trust };
    }
  }
  const socket = tls ? new TLSSocket(new Socket()) : new Socket();
  sockets.push(socket);
  if (peer !== null) {
    Object.defineProperty(socket, "remoteAddress", { value: peer });
  }
  const request = new Trusting(socket);
  request.url = url;
  request.method = method;
  // As Node.js does: the field lines of a name joined, and also kept apart
  const headers: IncomingHttpHeaders = {};
  const distinct: NodeJS.Dict<string[]> = {};
  for (const [name, value] of fields) {
    const key = name.toLowerCase();
    const values = distinct[key] ?? [];
    values.push(value);
    distinct[key] = values;
    headers[key] = values.join(", ");
  }
  request.headers = headers;
  request.headersDistinct = distinct;
  return request;
}

/** The address of the client, the addresses, the protocol and the host */
function describe(
  request: BindenRequest,
): [string | null, readonly string[], string, string | null] {
  return [request.ip, request.ips, request.protocol, request.host];
}

/** Throws a `BindenError` with the status 400 */
function badRequest(error: unknown): boolean {
  return error instanceof BindenError && error.status === 400;
}

const host: [string, string] = ["Host", "origin.test"];

suite("Trusted proxies", () => {
  test("no trusted proxy", () => {
    const fields: [string, string][] = [
      host,
      ["Forwarded", "for=1.1.1.1;proto=https;host=evil.test"],
      ["X-Forwarded-For", "1.1.1.1"],
      ["X-Forwarded-Proto", "https"],
      ["X-Forwarded-Host", "evil.test"],
    ];
    for (const trust of [false, 0, (): boolean => false]) {
      deepStrictEqual(
        describe(create(trust, fields)),
        ["10.0.0.1", ["10.0.0.1"], "http:", "origin.test"],
        String(trust),
      );
      deepStrictEqual(
        describe(create({ trust, headers: "x-forwarded" }, fields)),
        ["10.0.0.1", ["10.0.0.1"], "http:", "origin.test"],
      );
    }
    // The peer without the prefix of an IPv4-mapped address
    deepStrictEqual(
      create(false, [], { peer: "::ffff:10.0.0.2" }).ip,
      "10.0.0.2",
    );
    deepStrictEqual(create(false, [], { peer: "::FFFF:a00:3" }).ip, "10.0.0.3");
    deepStrictEqual(
      create(false, [], { peer: "2001:DB8:0::1" }).ip,
      "2001:db8::1",
    );
    // An unknown peer (e.g. a closed connection)
    deepStrictEqual(
      describe(
        create(true, [host, ["Forwarded", "for=1.1.1.1;proto=https"]], {
          peer: null,
        }),
      ),
      [null, [], "http:", "origin.test"],
    );
  });

  test("the number of trusted hops (`Forwarded`)", () => {
    // The client sent the first element, the nearest proxy (the peer) the last
    const fields: [string, string][] = [
      host,
      [
        "Forwarded",
        "for=1.1.1.1;proto=https;host=a.test, for=2.2.2.2;proto=http;host=b.test",
      ],
    ];
    // The peer is trusted: its element (the last one) gives the client
    deepStrictEqual(describe(create(1, fields)), [
      "2.2.2.2",
      ["2.2.2.2", "10.0.0.1"],
      "http:",
      "b.test",
    ]);
    deepStrictEqual(describe(create(2, fields)), [
      "1.1.1.1",
      ["1.1.1.1", "2.2.2.2", "10.0.0.1"],
      "https:",
      "a.test",
    ]);
    // All of them are trusted: the leftmost one
    for (const trust of [3, 5, true, (): boolean => true]) {
      deepStrictEqual(describe(create(trust, fields)), [
        "1.1.1.1",
        ["1.1.1.1", "2.2.2.2", "10.0.0.1"],
        "https:",
        "a.test",
      ]);
    }
    // Without the header: the peer and the connection
    deepStrictEqual(describe(create(true, [host], { tls: true })), [
      "10.0.0.1",
      ["10.0.0.1"],
      "https:",
      "origin.test",
    ]);
    // The `Forwarded` field lines are one list
    deepStrictEqual(
      create(2, [
        ["Forwarded", "for=1.1.1.1"],
        ["Forwarded", "for=2.2.2.2"],
      ]).ips,
      ["1.1.1.1", "2.2.2.2", "10.0.0.1"],
    );
  });

  test("a trust function", () => {
    const calls: [string, number][] = [];
    const trust = (address: string, hop: number): boolean => {
      calls.push([address, hop]);
      return address.startsWith("10.");
    };
    const fields: [string, string][] = [
      ["X-Forwarded-For", "3.3.3.3, 1.1.1.1, 10.0.0.2"],
    ];
    const request = create({ trust, headers: "x-forwarded" }, fields);
    deepStrictEqual(request.ip, "1.1.1.1");
    deepStrictEqual(request.ips, ["1.1.1.1", "10.0.0.2", "10.0.0.1"]);
    // Found once
    deepStrictEqual(request.protocol, "http:");
    deepStrictEqual(calls, [
      ["10.0.0.1", 0],
      ["10.0.0.2", 1],
      ["1.1.1.1", 2],
    ]);
    // Called even for the leftmost address
    calls.length = 0;
    deepStrictEqual(
      create(trust, [["Forwarded", "for=10.0.0.2"]]).ip,
      "10.0.0.2",
    );
    deepStrictEqual(calls, [
      ["10.0.0.1", 0],
      ["10.0.0.2", 1],
    ]);
  });

  test("a trust function that does not return a boolean", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      const rejected = Promise.reject(new Error("Rejected"));
      let then = false;
      const thenable = {
        then(_resolve: unknown, reject: (reason: unknown) => void): void {
          then = true;
          reject(new Error("Rejected"));
        },
      };
      for (const result of [rejected, thenable, 1, "true", {}, null]) {
        const trust = (() => result) as unknown as ITrustProxy;
        // A configuration error: a TypeError (500), never an implicit `true`
        const error = new TypeError("`trust_proxy` has not returned a boolean");
        const request = create(trust, [host]);
        throws(() => request.ip, error);
        throws(() => request.protocol, error);
        throws(() => request.URL, error);
        throws(() => request.host, error);
      }
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      ok(then);
      deepStrictEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  test("an invalid `trust_proxy`", () => {
    const invalid: [unknown, Error][] = [
      [-1, new RangeError("`trust_proxy` is not a non-negative integer")],
      [1.5, new RangeError("`trust_proxy` is not a non-negative integer")],
      [
        Number.NaN,
        new RangeError("`trust_proxy` is not a non-negative integer"),
      ],
      [2 ** 53, new RangeError("`trust_proxy` is not a non-negative integer")],
      [
        "1",
        new TypeError("`trust_proxy` is not a boolean, number or function"),
      ],
      [
        null,
        new TypeError("`trust_proxy` is not a boolean, number or function"),
      ],
      [{}, new TypeError("`trust_proxy` is not a boolean, number or function")],
      [
        { trust: {} },
        new TypeError("`trust_proxy` is not a boolean, number or function"),
      ],
      [
        { trust: -1 },
        new RangeError("`trust_proxy` is not a non-negative integer"),
      ],
      [
        { trust: 1, headers: "X-Forwarded" },
        new TypeError(
          '`trust_proxy.headers` is not "forwarded" or "x-forwarded"',
        ),
      ],
    ];
    for (const [trust, error] of invalid) {
      throws(
        () => create(trust as ITrustProxy).ip,
        error,
        JSON.stringify(trust),
      );
    }
    // `headers` defaults to `forwarded`
    deepStrictEqual(
      create({ trust: 1 }, [["Forwarded", "for=1.1.1.1"]]).ip,
      "1.1.1.1",
    );
    deepStrictEqual(
      create({ trust: 1, headers: "forwarded" }, [
        ["X-Forwarded-For", "1.1.1.1"],
      ]).ip,
      "10.0.0.1",
    );
  });

  test("the addresses of `Forwarded`", () => {
    // The address, and whether the element is valid (its `proto` is used)
    const ip = (value: string): [string | null, boolean] => {
      const request = create(true, [["Forwarded", `for=${value};proto=https`]]);
      return [request.ip, request.secure];
    };

    deepStrictEqual(ip("1.2.3.4"), ["1.2.3.4", true]);
    deepStrictEqual(ip(`"1.2.3.4:8080"`), ["1.2.3.4", true]);
    deepStrictEqual(ip(`"1.2.3.4:_port"`), ["1.2.3.4", true]);
    deepStrictEqual(ip(`"[2001:DB8:0::1]:4711"`), ["2001:db8::1", true]);
    deepStrictEqual(ip(`"[2001:db8::1]"`), ["2001:db8::1", true]);
    deepStrictEqual(ip(`"[::ffff:1.2.3.4]"`), ["1.2.3.4", true]);
    deepStrictEqual(ip(`"[fe80::1%eth0]"`), ["fe80::1%eth0", true]);
    // Unquoted and bare, as some proxies send them
    deepStrictEqual(ip("2001:db8::1"), ["2001:db8::1", true]);
    deepStrictEqual(ip("[2001:db8::1]:80"), ["2001:db8::1", true]);
    // Valid, but not addresses: the client is unknown
    for (const value of [
      "unknown",
      "UNKNOWN",
      `"unknown:80"`,
      "_hidden",
      `"_a.b-c:_p"`,
    ]) {
      deepStrictEqual(ip(value), [null, true], value);
    }
    // Invalid
    for (const value of [
      "x",
      `""`,
      "1.2.3",
      "01.2.3.4",
      "256.1.1.1",
      `"1.2.3.4:"`,
      `"1.2.3.4:123456"`,
      `"[1.2.3.4]"`,
      `"[2001:db8::1"`,
      `"[::1]x"`,
      "_",
      `"_a b"`,
      "unknownx",
    ]) {
      deepStrictEqual(ip(value), [null, false], value);
    }
  });

  test("unknown and invalid elements (`Forwarded`)", () => {
    const fields = (value: string): [string, string][] => [
      host,
      ["Forwarded", value],
    ];
    // The walk stops on an unknown client, with the protocol and host of the
    // element of the farthest trusted proxy
    deepStrictEqual(
      describe(
        create(
          true,
          fields(
            "for=1.1.1.1, for=unknown;proto=https;host=a.test, for=2.2.2.2",
          ),
        ),
      ),
      [null, ["2.2.2.2", "10.0.0.1"], "https:", "a.test"],
    );
    deepStrictEqual(
      describe(
        create(true, fields("for=1.1.1.1, for=_x;proto=https, for=2.2.2.2")),
      ),
      [null, ["2.2.2.2", "10.0.0.1"], "https:", "origin.test"],
    );
    // An element without `for` is of an unknown client
    deepStrictEqual(describe(create(1, fields("proto=https"))), [
      null,
      ["10.0.0.1"],
      "https:",
      "origin.test",
    ]);
    // Empty elements are not elements
    deepStrictEqual(
      describe(create(1, fields("for=1.1.1.1;proto=https, , "))),
      ["1.1.1.1", ["1.1.1.1", "10.0.0.1"], "https:", "origin.test"],
    );
    // An invalid element on the way: an unknown client, and the protocol and
    // host of the request (its position is kept: an element of the client
    // does not take its place)
    for (const invalid of [
      "garbage",
      "for=x;proto=https",
      `for=""`,
      `for="a,b"`,
      "for=1.1.1.1;for=2.2.2.2",
      "for=2.2.2.2;proto=1x",
      `for=2.2.2.2;host="a b"`,
      "for=2.2.2.2;host=a@b.test",
    ]) {
      deepStrictEqual(
        describe(
          create(
            true,
            fields(`for=1.1.1.1;proto=https;host=a.test, ${invalid}`),
          ),
        ),
        [null, ["10.0.0.1"], "http:", "origin.test"],
        invalid,
      );
      deepStrictEqual(
        describe(
          create(
            true,
            fields(
              `for=1.1.1.1;proto=https, ${invalid}, for=2.2.2.2;host=b.test`,
            ),
          ),
        ),
        [null, ["2.2.2.2", "10.0.0.1"], "http:", "origin.test"],
        invalid,
      );
    }
    // ... but not one beyond the client
    deepStrictEqual(
      describe(
        create(1, fields("garbage, for=1.1.1.1;proto=https;host=a.test")),
      ),
      ["1.1.1.1", ["1.1.1.1", "10.0.0.1"], "https:", "a.test"],
    );
    // Another scheme than `http` and `https`: the protocol of the connection
    deepStrictEqual(
      describe(
        create(1, fields("for=1.1.1.1;proto=ftp;host=a.test"), { tls: true }),
      ),
      ["1.1.1.1", ["1.1.1.1", "10.0.0.1"], "https:", "a.test"],
    );
    deepStrictEqual(
      create(1, fields("for=1.1.1.1;proto=HTTPS")).protocol,
      "https:",
    );
    // Over TLS, a trusted `http` is `http:`, and an element without `proto`
    // keeps `https:`
    deepStrictEqual(
      create(1, fields("for=1.1.1.1;proto=http"), { tls: true }).protocol,
      "http:",
    );
    deepStrictEqual(
      create(1, fields("for=1.1.1.1"), { tls: true }).protocol,
      "https:",
    );
  });

  test("`X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host`", () => {
    const trust = (hops: ITrustProxy): ITrustProxy => ({
      trust: hops as boolean,
      headers: "x-forwarded",
    });
    const fields: [string, string][] = [
      host,
      ["X-Forwarded-For", "1.1.1.1, 2.2.2.2"],
      ["X-Forwarded-Proto", "https"],
      ["X-Forwarded-Host", "a.test"],
      // The families of headers are not mixed
      ["Forwarded", "for=3.3.3.3;proto=http;host=b.test"],
    ];
    deepStrictEqual(describe(create(trust(1), fields)), [
      "2.2.2.2",
      ["2.2.2.2", "10.0.0.1"],
      "https:",
      "a.test",
    ]);
    deepStrictEqual(describe(create(trust(true), fields)), [
      "1.1.1.1",
      ["1.1.1.1", "2.2.2.2", "10.0.0.1"],
      "https:",
      "a.test",
    ]);
    // The protocol and the host that the trusted peer has set, without
    // `X-Forwarded-For`, or one of them
    deepStrictEqual(
      describe(create(trust(1), [host, ["X-Forwarded-Proto", "HTTPS"]])),
      ["10.0.0.1", ["10.0.0.1"], "https:", "origin.test"],
    );
    deepStrictEqual(
      describe(create(trust(1), [host, ["X-Forwarded-Host", "A.test:8443"]])),
      ["10.0.0.1", ["10.0.0.1"], "http:", "a.test:8443"],
    );
    // `unknown`: an unknown client, but the protocol and host of the peer
    deepStrictEqual(
      describe(
        create(trust(true), [
          ...fields.slice(0, 1),
          ["X-Forwarded-For", "1.1.1.1, unknown"],
          ...fields.slice(2),
        ]),
      ),
      [null, ["10.0.0.1"], "https:", "a.test"],
    );
    // Empty elements are not elements, several field lines are one list
    deepStrictEqual(
      create(trust(true), [
        ["X-Forwarded-For", "1.1.1.1, , [2001:db8::1]:80"],
        ["X-Forwarded-For", "2.2.2.2:8080"],
      ]).ips,
      ["1.1.1.1", "2001:db8::1", "2.2.2.2", "10.0.0.1"],
    );
  });

  test("`X-Forwarded-*` (ambiguous or invalid)", () => {
    const trust: ITrustProxy = { trust: true, headers: "x-forwarded" };
    const origin = (...fields: [string, string][]): [string, string | null] => {
      const request = create(trust, [
        host,
        ["X-Forwarded-For", "1.1.1.1"],
        ...fields,
      ]);
      return [request.protocol, request.host];
    };
    deepStrictEqual(
      origin(["X-Forwarded-Proto", "https"], ["X-Forwarded-Host", "a.test"]),
      ["https:", "a.test"],
    );
    // A duplicated field or a list: the protocol and the host of the request
    for (const fields of [
      [
        ["X-Forwarded-Proto", "https"],
        ["X-Forwarded-Proto", "https"],
        ["X-Forwarded-Host", "a.test"],
      ],
      [
        ["X-Forwarded-Proto", "https, http"],
        ["X-Forwarded-Host", "a.test"],
      ],
      [
        ["X-Forwarded-Proto", "https"],
        ["X-Forwarded-Host", "a.test"],
        ["X-Forwarded-Host", "b.test"],
      ],
      [
        ["X-Forwarded-Proto", "https"],
        ["X-Forwarded-Host", "a.test,b.test"],
      ],
      // Malformed
      [
        ["X-Forwarded-Proto", "1x"],
        ["X-Forwarded-Host", "a.test"],
      ],
      [
        ["X-Forwarded-Proto", ""],
        ["X-Forwarded-Host", "a.test"],
      ],
      [
        ["X-Forwarded-Proto", "https"],
        ["X-Forwarded-Host", "a.test/x"],
      ],
      [
        ["X-Forwarded-Proto", "https"],
        ["X-Forwarded-Host", ""],
      ],
    ] as [string, string][][]) {
      deepStrictEqual(
        origin(...fields),
        ["http:", "origin.test"],
        JSON.stringify(fields),
      );
    }
    // Another scheme: the protocol of the connection
    deepStrictEqual(
      origin(["X-Forwarded-Proto", "ftp"], ["X-Forwarded-Host", "a.test"]),
      ["http:", "a.test"],
    );
    // An invalid address on the way: an unknown client, and the protocol and
    // host of the request
    for (const value of ["1.1.1.1, x", "1.1.1.1, 2.2.2.2:", "_"]) {
      const request = create(trust, [
        host,
        ["X-Forwarded-For", value],
        ["X-Forwarded-Proto", "https"],
        ["X-Forwarded-Host", "a.test"],
      ]);
      deepStrictEqual(
        describe(request),
        [null, ["10.0.0.1"], "http:", "origin.test"],
        value,
      );
    }
  });

  test(".URL and .host behind trusted proxies", () => {
    const fields: [string, string][] = [
      host,
      ["Forwarded", "for=1.1.1.1;proto=https;host=A.test"],
    ];
    deepStrictEqual(
      create(1, fields, { url: "/p?q=1" }).URL.href,
      "https://a.test/p?q=1",
    );
    deepStrictEqual(create(1, fields).secure, true);
    // The authority of a request-target in absolute-form comes first
    const absolute = create(1, fields, { url: "http://B.test:443/p" });
    deepStrictEqual(absolute.URL.href, "https://b.test/p");
    deepStrictEqual(absolute.host, "b.test");
    // The default port of the protocol is not a part of the host
    deepStrictEqual(
      create(1, [["Forwarded", `for=1.1.1.1;proto=https;host="a.test:443"`]])
        .host,
      "a.test",
    );
    deepStrictEqual(
      create(1, [["Forwarded", `for=1.1.1.1;host="a.test:443"`]]).host,
      "a.test:443",
    );
    deepStrictEqual(create(false, [["Host", "[::1]:80"]]).host, "[::1]");
    // `OPTIONS *`
    const options = create(1, fields, { url: "*", method: "OPTIONS" });
    deepStrictEqual(options.URL.href, "https://a.test/*");
    deepStrictEqual(options.host, "a.test");
    // Without a host
    deepStrictEqual(create(false).host, null);
    throws(() => create(false).URL, badRequest);
    // An invalid host
    for (const value of [
      "",
      "a b",
      "user@a.test",
      "a.test/x",
      "a.test:x",
      "[::1",
    ]) {
      throws(() => create(false, [["Host", value]]).host, badRequest, value);
      throws(() => create(false, [["Host", value]]).URL, badRequest, value);
    }
    throws(
      () => create(false, [host], { url: "ftp://a.test/" }).host,
      badRequest,
    );
    // Several `Host` field lines (RFC 9112, section 3.2): Node.js keeps the
    // first one, a proxy may have used another one
    for (const url of ["/", "http://a.test/"]) {
      const duplicated = create(false, [host, ["Host", "evil.test"]], { url });
      throws(() => duplicated.host, badRequest);
      throws(() => duplicated.URL, badRequest);
    }
    // Without a request-target (not parsed from a request)
    const bare = create(false, [host]);
    Reflect.deleteProperty(bare, "url");
    deepStrictEqual(bare.host, "origin.test");
  });

  test("several `Host` field lines", { timeout: 5000 }, async () => {
    const server = createServer({ IncomingMessage: BindenRequest });
    const { promise, resolve } = Promise.withResolvers<unknown>();
    server.once("request", (request, response) => {
      try {
        resolve(request.host);
      } catch (error: unknown) {
        resolve(error);
      } finally {
        response.end();
      }
    });
    await new Promise<void>((done) => {
      server.listen(0, done);
    });
    const { port } = server.address() as AddressInfo;
    const socket = connect(port, "127.0.0.1", () => {
      socket.end(
        "GET / HTTP/1.1\r\nHost: a.test\r\nHost: b.test\r\nConnection: close\r\n\r\n",
      );
    });
    socket.resume();
    try {
      ok(badRequest(await promise));
    } finally {
      socket.destroy();
      await new Promise((done) => {
        server.close(done);
      });
    }
  });

  test("a real connection", { timeout: 5000 }, async () => {
    const options = validateRequestOptions({
      trust_proxy: { trust: true, headers: "x-forwarded" },
    });
    class Trusting extends BindenRequest {
      // eslint-disable-next-line class-methods-use-this -- a fixture
      protected override get options(): IRequestOptions {
        return options;
      }
    }
    const server = createServer({ IncomingMessage: Trusting });
    const { promise, resolve, reject } =
      Promise.withResolvers<[string | null, readonly string[], string]>();
    server.once("request", (request, response) => {
      try {
        resolve([request.ip, request.ips, request.protocol]);
      } catch (error: unknown) {
        reject(error);
      } finally {
        response.end();
      }
    });
    await new Promise<void>((done) => {
      server.listen(0, done);
    });
    const { port } = server.address() as AddressInfo;
    const socket = connect(port, "127.0.0.1", () => {
      // Two field lines of `X-Forwarded-Proto`: ambiguous
      socket.end(
        "GET / HTTP/1.1\r\nHost: a.test\r\nX-Forwarded-For: 1.1.1.1\r\nX-Forwarded-Proto: https\r\nX-Forwarded-Proto: https\r\nConnection: close\r\n\r\n",
      );
    });
    socket.resume();
    try {
      // The peer is IPv4 (also through an IPv6 socket)
      deepStrictEqual(await promise, [
        "1.1.1.1",
        ["1.1.1.1", "127.0.0.1"],
        "http:",
      ]);
    } finally {
      socket.destroy();
      await new Promise((done) => {
        server.close(done);
      });
    }
  });

  after(() => {
    for (const socket of sockets.splice(0)) {
      socket.destroy();
    }
  });
});
