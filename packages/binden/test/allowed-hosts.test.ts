import {
  BindenError,
  BindenRequest,
  type IAllowedHosts,
  type IRequestOptions,
  type IRequestOptionsInput,
  validateRequestOptions,
} from "../index.js";
import { after, suite, test } from "node:test";
import { deepStrictEqual, ok, throws } from "node:assert";
import { Socket } from "node:net";
import { TLSSocket } from "node:tls";

const sockets: Socket[] = [];

/** A request with the options, from `10.0.0.1` */
function create(
  input: IRequestOptionsInput,
  headers: Record<string, string> = {},
  { url = "/", tls = false } = {},
): BindenRequest {
  const options = validateRequestOptions(input);
  class Hosted extends BindenRequest {
    // eslint-disable-next-line class-methods-use-this -- a fixture
    protected override get options(): IRequestOptions {
      return options;
    }
  }
  const socket = tls ? new TLSSocket(new Socket()) : new Socket();
  sockets.push(socket);
  Object.defineProperty(socket, "remoteAddress", { value: "10.0.0.1" });
  const request = new Hosted(socket);
  request.url = url;
  request.headers = headers;
  // As Node.js does: one field line of each
  request.headersDistinct = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, [value]]),
  );
  return request;
}

/** Throws a `BindenError` with the status 400 */
function badRequest(error: unknown): boolean {
  return error instanceof BindenError && error.status === 400;
}

/** Whether the request is allowed, by `.host` and `.URL` */
function allowed(request: BindenRequest): boolean {
  try {
    const { host } = request;
    deepStrictEqual(request.URL.host, host);
    return true;
  } catch (error: unknown) {
    ok(badRequest(error), String(error));
    throws(() => request.URL, badRequest);
    return false;
  }
}

suite("allowed_hosts", () => {
  test("any host by default", () => {
    ok(allowed(create({}, { host: "evil.test" })));
    deepStrictEqual(create({}).host, null);
  });

  test("a list of hosts", () => {
    const allowed_hosts = [
      "Example.com",
      "api.example.com:8443",
      "[0:0::1]:3000",
      "10.0.0.1",
      "secure.test:443",
      "[::2]",
      "plain.test:80",
    ];
    const check = (host: string, tls = false): boolean =>
      allowed(create({ allowed_hosts }, { host }, { tls }));

    // In lowercase, on any port without one
    for (const host of ["example.com", "EXAMPLE.com", "example.com:8080"]) {
      ok(check(host), host);
    }
    ok(check("api.example.com:8443"));
    ok(!check("api.example.com"));
    ok(!check("api.example.com:443"));
    ok(check("[::1]:3000"));
    ok(check("[0::1]:3000"));
    ok(!check("[::1]"));
    ok(check("[::2]:9999"));
    ok(check("10.0.0.1"));
    ok(!check("10.0.0.2"));
    ok(!check("evil.test"));
    ok(!check("sub.example.com"));
    ok(!check("example.com.evil.test"));
    // The default port of the protocol
    ok(check("secure.test", true));
    ok(!check("secure.test"));
    ok(check("secure.test:443"));
    ok(check("plain.test"));
    ok(!check("plain.test", true));
    // Without a host
    throws(() => create({ allowed_hosts }).host, badRequest);
    ok(!allowed(create({ allowed_hosts })));
    // The original header is left as it is
    const request = create({ allowed_hosts }, { host: "evil.test" });
    ok(!allowed(request));
    deepStrictEqual(request.headers.host, "evil.test");
  });

  test("the effective host", () => {
    const allowed_hosts = ["example.com"];
    // The authority of a request-target in absolute-form
    ok(
      !allowed(
        create(
          { allowed_hosts },
          { host: "example.com" },
          { url: "http://evil.test/" },
        ),
      ),
    );
    ok(
      allowed(
        create(
          { allowed_hosts },
          { host: "evil.test" },
          { url: "http://example.com/" },
        ),
      ),
    );
    // The host from a trusted proxy
    const proxied = (host: string): BindenRequest =>
      create(
        { allowed_hosts, trust_proxy: 1 },
        { host: "example.com", forwarded: `for=1.1.1.1;host=${host}` },
      );
    ok(!allowed(proxied("evil.test")));
    ok(allowed(proxied("example.com")));
    // ... but not from another one
    ok(
      allowed(
        create(
          { allowed_hosts },
          { host: "example.com", forwarded: "for=1.1.1.1;host=evil.test" },
        ),
      ),
    );
  });

  test("a function", () => {
    const hosts: string[] = [];
    const allowed_hosts = (host: string): boolean => {
      hosts.push(host);
      return /\.example\.com(?::\d+)?$/u.test(host);
    };
    ok(allowed(create({ allowed_hosts }, { host: "A.example.com:8080" })));
    ok(allowed(create({ allowed_hosts }, { host: "b.example.com:80" })));
    ok(!allowed(create({ allowed_hosts }, { host: "evil.test" })));
    // `hostname[:port]`, in lowercase, without the default port
    deepStrictEqual(hosts.slice(0, 4), [
      "a.example.com:8080",
      "a.example.com:8080",
      "b.example.com",
      "b.example.com",
    ]);
    ok(hosts.includes("evil.test"));
    // Not called without a host
    hosts.length = 0;
    ok(!allowed(create({ allowed_hosts })));
    deepStrictEqual(hosts, []);
  });

  test("a function that does not return a boolean", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      const rejected = Promise.reject(new Error("Rejected"));
      for (const result of [rejected, 1, "true", {}, null]) {
        const allowed_hosts = (() => result) as unknown as IAllowedHosts;
        const request = create({ allowed_hosts }, { host: "example.com" });
        // A configuration error: a TypeError (500), never an implicit `true`
        const error = new TypeError(
          "`allowed_hosts` has not returned a boolean",
        );
        throws(() => request.host, error);
        throws(() => request.URL, error);
      }
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      deepStrictEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  test("validateRequestOptions()", () => {
    const check = (allowed_hosts: unknown): IAllowedHosts | null =>
      validateRequestOptions({
        allowed_hosts: allowed_hosts as IAllowedHosts,
      }).allowed_hosts;

    deepStrictEqual(validateRequestOptions({}).allowed_hosts, null);
    const fn = (): boolean => true;
    deepStrictEqual(check(fn), fn);
    const list = check([
      "Example.COM",
      "example.com:080",
      "a_b-c.d:65535",
      "xn--bcher-kva.example:1",
      "[0:0:0::1]",
      "[2001:DB8::1]:8080",
      "127.0.0.1",
      "localhost",
    ]);
    deepStrictEqual(list, [
      "example.com",
      "example.com:80",
      "a_b-c.d:65535",
      "xn--bcher-kva.example:1",
      "[::1]",
      "[2001:db8::1]:8080",
      "127.0.0.1",
      "localhost",
    ]);
    ok(Object.isFrozen(list));

    for (const entry of [
      "",
      "*.example.com",
      "example.com.",
      ".example.com",
      "-a.example.com",
      "a-.example.com",
      "a..b",
      "a b",
      "example.com:0",
      "example.com:65536",
      "example.com:",
      "example.com:x",
      "user@example.com",
      "example.com/x",
      "1.2.3",
      "01.2.3.4",
      "0x7f.1",
      "[1.2.3.4]",
      "[::1",
      "::1",
      "[::1]x",
      `${"a".repeat(64)}.test`,
      `${"a.".repeat(127)}ab`,
      "bücher.example",
      1,
      null,
    ]) {
      throws(
        () => check([entry]),
        new TypeError(
          `\`allowed_hosts\` has an invalid host: ${String(entry)}`,
        ),
        String(entry),
      );
    }
    throws(
      () => check([]),
      new RangeError("`allowed_hosts` is empty: no request is allowed"),
    );
    for (const value of [null, "example.com", 1, {}]) {
      throws(
        () => check(value),
        new TypeError("`allowed_hosts` is not an array or a function"),
      );
    }
  });

  after(() => {
    for (const socket of sockets.splice(0)) {
      socket.destroy();
    }
  });
});
