import { BindenResponse, type IRedirectStatus } from "../index.js";
import { type ITestServer, listen } from "./http.js";
import { afterEach, suite, test } from "node:test";
import { deepStrictEqual, ok } from "node:assert";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { redirectLocation } from "../src/redirect.js";

const base = new URL("http://example.com:8080/dir/page?q=1");
const { origin } = base;

/** The `Location` of a redirect from `base`, or the message of its error */
function locate(
  location: URL | string,
  allow_external = false,
  from: string | null = origin,
): string {
  try {
    return redirectLocation(location, base, from, allow_external);
  } catch (error: unknown) {
    ok(error instanceof TypeError, String(error));
    return `TypeError: ${error.message}`;
  }
}

const external =
  "TypeError: The location is external: set `allow_external` to allow it";
const userinfo = "TypeError: The location has userinfo";
const forbidden =
  "TypeError: The location has a control character, whitespace or a backslash";

suite("redirect", () => {
  let server: ITestServer | null = null;

  afterEach(async () => {
    const current = server;
    server = null;
    await current?.close();
  });

  test("redirectLocation() (relative references stay relative)", () => {
    const cases: [string, string][] = [
      ["/", "/"],
      ["/a/b?c=d#e", "/a/b?c=d#e"],
      // Normalized and percent-encoded, as by the WHATWG URL parser
      ["/a/../b/./c", "/b/c"],
      ["/a/%2e%2e/b", "/b"],
      [
        "/путь?ключ=з#ф",
        "/%D0%BF%D1%83%D1%82%D1%8C?%D0%BA%D0%BB%D1%8E%D1%87=%D0%B7#%D1%84",
      ],
      ["/@me", "/@me"],
      ["/a%2F%2Fb", "/a%2F%2Fb"],
      // Resolved against the URL of the request
      ["next", "/dir/next"],
      ["../up", "/up"],
      ["?page=2", "/dir/page?page=2"],
      ["#top", "/dir/page?q=1#top"],
      // A path that starts with `//` is not an authority
      ["/.//evil.example", "/.//evil.example"],
      ["/a/..//evil.example", "/.//evil.example"],
      ["..//evil.example", "/.//evil.example"],
    ];
    for (const [location, expected] of cases) {
      deepStrictEqual(locate(location), expected, location);
      // Also on an origin that is not known
      deepStrictEqual(locate(location, false, null), expected, location);
    }
  });

  test("redirectLocation() (absolute URLs)", () => {
    // The same origin
    deepStrictEqual(
      locate("http://example.com:8080/x"),
      "http://example.com:8080/x",
    );
    deepStrictEqual(
      locate("HTTP://EXAMPLE.com:8080"),
      "http://example.com:8080/",
    );
    deepStrictEqual(
      locate(new URL("/x?y#z", base)),
      "http://example.com:8080/x?y#z",
    );
    deepStrictEqual(locate("http:same"), "http://example.com:8080/dir/same");

    // Another origin (scheme, host or port)
    for (const location of [
      "https://example.com:8080/",
      "http://example.com/",
      "http://other.example:8080/",
      "https:other.example",
      new URL("https://other.example/x"),
    ]) {
      deepStrictEqual(locate(location), external, String(location));
    }
    deepStrictEqual(
      locate("https://other.example/a%20b", true),
      "https://other.example/a%20b",
    );
    deepStrictEqual(
      locate("https:other.example", true),
      "https://other.example/",
    );
    deepStrictEqual(
      locate("https://xn--e1afmkfd.example/", true),
      "https://xn--e1afmkfd.example/",
    );
    deepStrictEqual(
      locate("https://пример.example/", true),
      "https://xn--e1afmkfd.example/",
    );
    // No absolute URL is of an origin that is not known
    deepStrictEqual(locate("http://example.com:8080/x", false, null), external);
    deepStrictEqual(
      locate("http://example.com:8080/x", true, null),
      "http://example.com:8080/x",
    );
  });

  test("redirectLocation() (network-path references)", () => {
    deepStrictEqual(locate("//other.example/x"), external);
    // Even to the same host
    deepStrictEqual(locate("//example.com:8080/x"), external);
    deepStrictEqual(
      locate("//other.example/x?y#z", true),
      "//other.example/x?y#z",
    );
    deepStrictEqual(locate("///other.example/x", true), "//other.example/x");
  });

  test("redirectLocation() (never)", () => {
    const cases: [URL | string, string][] = [
      ["http://user@example.com:8080/", userinfo],
      ["http://user:pass@other.example/", userinfo],
      ["http://@other.example/", userinfo],
      ["http://:@example.com:8080/", userinfo],
      ["//user@other.example/", userinfo],
      ["https:@other.example", userinfo],
      ["http:///user@other.example", userinfo],
      [new URL("http://user:pass@example.com:8080/"), userinfo],
      [
        // Not written as a literal, which the linter reports
        ["javascript", "alert(1)"].join(":"),
        "TypeError: The location has the scheme javascript:",
      ],
      ["data:text/html,x", "TypeError: The location has the scheme data:"],
      ["mailto:a@b.example", userinfo],
      ["ftp://other.example/", "TypeError: The location has the scheme ftp:"],
      [
        new URL("file:///etc/passwd"),
        "TypeError: The location has the scheme file:",
      ],
      ["/a b", forbidden],
      [" /a", forbidden],
      ["/a\t", forbidden],
      ["/a\r\nX-Injected: 1", forbidden],
      ["/a\u0000", forbidden],
      ["/a\u007F", forbidden],
      [`/a${String.fromCodePoint(0x85)}`, forbidden],
      [`/a${String.fromCodePoint(0xa0)}`, forbidden],
      [`/a${String.fromCodePoint(0x2028)}`, forbidden],
      ["/\\evil.example", forbidden],
      ["http:\\\\evil.example", forbidden],
      ["", "TypeError: The location is not a non-empty string or a URL"],
      [
        1 as unknown as string,
        "TypeError: The location is not a non-empty string or a URL",
      ],
      ["http://[::1", "TypeError: The location is not a valid URL"],
      ["http://a:99999/", "TypeError: The location is not a valid URL"],
    ];
    for (const [location, expected] of cases) {
      // Also with `allow_external`
      deepStrictEqual(locate(location, true), expected, String(location));
    }
  });

  test(".redirect()", async () => {
    server = await listen();
    const app = server;
    const send = async (
      reply: (response: BindenResponse) => Promise<void>,
      method = "GET",
    ): Promise<[number, unknown, unknown, string]> => {
      const handled = app.handle((_request, response) => reply(response));
      const { status, headers, body } = await app.request({
        method,
        path: "/from/here?x=1",
      });
      deepStrictEqual(await handled, null);
      return [
        status,
        headers.location,
        headers["content-length"],
        body.toString(),
      ];
    };

    deepStrictEqual(await send((r) => r.redirect("/to")), [
      302,
      "/to",
      "0",
      "",
    ]);
    deepStrictEqual(await send((r) => r.redirect("next")), [
      302,
      "/from/next",
      "0",
      "",
    ]);
    for (const status of [301, 302, 303, 307, 308] as const) {
      deepStrictEqual(await send((r) => r.redirect("/to", status)), [
        status,
        "/to",
        "0",
        "",
      ]);
    }
    // An empty body, also replacing what was set
    deepStrictEqual(
      await send(
        (r) => r.setHeader("Content-Length", 99).redirect("/to"),
        "HEAD",
      ),
      [302, "/to", "0", ""],
    );
    // The origin of the request (`Host`)
    deepStrictEqual(await send((r) => r.redirect(`${app.url}/x`)), [
      302,
      `${app.url}/x`,
      "0",
      "",
    ]);
    deepStrictEqual(
      await send((r) =>
        r.redirect("https://other.example/", 303, { allow_external: true }),
      ),
      [303, "https://other.example/", "0", ""],
    );
  });

  test(".redirect() (rejects before the response)", async () => {
    server = await listen();
    const app = server;
    const check = async (
      reply: (response: BindenResponse) => Promise<void>,
      expected: Error,
    ): Promise<void> => {
      const handled = app.handle(async (_request, response) => {
        const error = await reply(response).then(
          () => null,
          (reason: unknown) => reason,
        );
        deepStrictEqual(error, expected);
        // Nothing set nor started: the error can be replied
        ok(!response.started);
        ok(!response.hasHeader("Location"));
        deepStrictEqual(response.statusCode, 200);
        await response.send("replied");
      });
      const { body } = await app.request();
      deepStrictEqual(await handled, null);
      deepStrictEqual(body.toString(), "replied");
    };
    await check(
      (r) => r.redirect("https://other.example/"),
      new TypeError(
        "The location is external: set `allow_external` to allow it",
      ),
    );
    for (const status of [300, 304, 200, "302"]) {
      await check(
        (r) => r.redirect("/to", status as IRedirectStatus),
        new TypeError(`Status code ${status} is not a redirect`),
      );
    }
    await check(
      (r) =>
        r.redirect("/to", 302, { allow_external: "yes" as unknown as boolean }),
      new TypeError("`allow_external` is not a boolean"),
    );
  });

  test(".redirect() (a request that is not a `BindenRequest`)", async () => {
    server = await listen({ plain: true });
    const app = server;
    const send = async (
      reply: (response: BindenResponse) => Promise<void>,
      path = "/from/here?x=1",
    ): Promise<unknown> => {
      const handled = app.handle(async (_request, response) => {
        try {
          await reply(response);
        } finally {
          // Replied when the redirect is refused
          response.end();
        }
      });
      const { headers } = await app.request({ path });
      return [await handled, headers.location];
    };
    deepStrictEqual(await send((r) => r.redirect("next")), [
      null,
      "/from/next",
    ]);
    deepStrictEqual(await send((r) => r.redirect("#top")), [
      null,
      "/from/here?x=1#top",
    ]);
    // The path of the request-target, not an authority
    deepStrictEqual(await send((r) => r.redirect("#top"), "//from/here"), [
      null,
      "/.//from/here#top",
    ]);
    // Its origin is not known
    const [error] = (await send((r) => r.redirect(`${app.url}/x`))) as [
      unknown,
    ];
    deepStrictEqual(
      error,
      new TypeError(
        "The location is external: set `allow_external` to allow it",
      ),
    );

    // Without a path of the request-target
    const response = new BindenResponse(new IncomingMessage(new Socket()));
    response.req.url = "*";
    // Never sent without a connection
    response.redirect("next").catch(() => {
      // Nothing to send it to
    });
    deepStrictEqual(response.getHeader("Location"), "/next");
    deepStrictEqual(response.statusCode, 302);

    // Nor of the absolute-form
    const absolute = new BindenResponse(new IncomingMessage(new Socket()));
    absolute.req.url = "http://other.example/a/b";
    absolute.redirect("next").catch(() => {
      // Nothing to send it to
    });
    deepStrictEqual(absolute.getHeader("Location"), "/next");
  });
});
