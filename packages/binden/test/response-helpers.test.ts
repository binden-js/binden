/* eslint-disable init-declarations */
import { BindenResponse, Cookie, ct_json } from "../index.js";
import { type ITestServer, listen } from "./http.js";
import { afterEach, beforeEach, suite, test } from "node:test";
import { deepStrictEqual, ok, throws } from "node:assert";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";

/** `undefined`, which the linter does not let the tests write */
const none = ({} as { value?: undefined }).value;

/** A response without a connection: nothing is actually sent */
function detached(): BindenResponse {
  return new BindenResponse(new IncomingMessage(new Socket()));
}

suite("BindenResponse helpers", () => {
  let server: ITestServer;

  beforeEach(async () => {
    server = await listen();
  });

  afterEach(async () => {
    await server.close();
  });

  test(".json() (any JSON value)", async () => {
    for (const value of [null, 0, -1.5, "text", true, [1, "2"], { a: [] }]) {
      const handled = server.handle((_request, response) =>
        response.json(value),
      );
      const { headers, body } = await server.request();
      deepStrictEqual(await handled, null);
      deepStrictEqual(headers["content-type"], ct_json);
      deepStrictEqual(JSON.parse(body.toString()), value);
    }
  });

  test(".json() (rejects what has no JSON text before the response)", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const values: [unknown, RegExp][] = [
      [none, /^TypeError: A undefined is not a JSON value$/u],
      [(): number => 1, /^TypeError: A function is not a JSON value$/u],
      [Symbol("s"), /^TypeError: A symbol is not a JSON value$/u],
      [1n, /^TypeError: A bigint is not a JSON value$/u],
      // Nested, by `JSON.stringify()`
      [{ big: 1n }, /^TypeError: Do not know how to serialize a BigInt$/u],
      [cyclic, /^TypeError: Converting circular structure to JSON/u],
      // `toJSON()` without a value
      [{ toJSON: (): undefined => none }, /^TypeError: The JSON text/u],
    ];
    for (const [value, error] of values) {
      const response = detached();
      const sent = await response.json(value).then(
        () => null,
        (reason: unknown) => reason,
      );
      ok(error.test(String(sent)), String(sent));
      // Nothing is set nor started: the error can be replied
      ok(!response.started);
      ok(!response.hasHeader("Content-Type"));
    }
  });

  test(".json() (a custom `stringify` must return a string)", async () => {
    const response = detached();
    const sent = await response
      .json({ a: 1 }, () => 1 as unknown as string)
      .then(
        () => null,
        (reason: unknown) => reason,
      );
    deepStrictEqual(sent, new TypeError("The JSON text is not a string"));
    ok(!response.started);

    // Its own errors, and the values it accepts (e.g. a `bigint`)
    const failing = new Error("stringify");
    const rejected = await detached()
      .json({}, () => {
        throw failing;
      })
      .then(
        () => null,
        (reason: unknown) => reason,
      );
    deepStrictEqual(rejected, failing);

    const handled = server.handle((_request, res) =>
      res.json({ n: 1n }, (data) => `{"n":${String(data.n)}}`),
    );
    const { body } = await server.request();
    deepStrictEqual(await handled, null);
    deepStrictEqual(body.toString(), `{"n":1}`);
  });

  test(".text() and .html() (UTF-8)", async () => {
    const text = server.handle((_request, response) => response.text("😀"));
    const plain = await server.request();
    deepStrictEqual(await text, null);
    deepStrictEqual(plain.headers["content-type"], "text/plain; charset=utf-8");
    deepStrictEqual(plain.body.toString(), "😀");

    const html = server.handle((_request, response) => response.html("<p>"));
    const page = await server.request();
    deepStrictEqual(await html, null);
    deepStrictEqual(page.headers["content-type"], "text/html; charset=utf-8");
    deepStrictEqual(page.body.toString(), "<p>");
  });

  test(".text(), .html(), .json() and .form() refused by send() (data that it cannot send, a view of a detached ArrayBuffer, a 1xx status) change nothing of the response: the Content-Type is set once send() accepts them (R26-R3-5)", async () => {
    const transferred = new Uint8Array(2);
    transferred.buffer.transfer();
    const params = new URLSearchParams({ a: "b" });
    const refused: [string, (response: BindenResponse) => Promise<void>][] = [
      [
        "text({})",
        async (response): Promise<void> => response.text({} as string),
      ],
      [
        "html(null)",
        async (response): Promise<void> =>
          response.html(null as unknown as string),
      ],
      [
        "text(detached view)",
        async (response): Promise<void> =>
          response.text(transferred as unknown as string),
      ],
      [
        "status(101).text()",
        async (response): Promise<void> => response.status(101).text("x"),
      ],
      [
        "status(101).html()",
        async (response): Promise<void> => response.status(101).html("x"),
      ],
      [
        "status(101).json()",
        async (response): Promise<void> => response.status(101).json({}),
      ],
      [
        "status(101).form()",
        async (response): Promise<void> => response.status(101).form(params),
      ],
    ];
    for (const [label, run] of refused) {
      const response = detached();
      const reason = await run(response).then(
        () => null,
        (error: unknown) => error,
      );
      ok(reason instanceof TypeError, label);
      deepStrictEqual(
        [response.getHeaderNames(), response.headersSent],
        [[], false],
        label,
      );
    }
    // Ignored once the response has ended, as `send()` (without a header
    // set on the ended response)
    const ended = detached();
    ended.end();
    await ended.text("x");
    await ended.html("x");
    await ended.json({});
    await ended.form(params);
    deepStrictEqual(ended.getHeader("Content-Type"), none);
  });

  test(".type()", () => {
    const response = detached();
    ok(response.type(" Text/HTML ; Charset=UTF-8; q=x") === response);
    deepStrictEqual(
      response.getHeader("Content-Type"),
      "text/html; charset=utf-8; q=x",
    );
    for (const invalid of ["text", "text/html\r\nX-Injected: 1", "", "a b/c"]) {
      throws(
        () => response.type(invalid),
        new TypeError(`Invalid media type: ${invalid}`),
      );
    }
    deepStrictEqual(
      response.getHeader("Content-Type"),
      "text/html; charset=utf-8; q=x",
    );
  });

  test(".attachment()", () => {
    const response = detached();
    ok(response.attachment() === response);
    deepStrictEqual(response.getHeader("Content-Disposition"), "attachment");

    const cases: [string, string, string][] = [
      ["report.pdf", "report.pdf", "report.pdf"],
      // Not `attr-char` (RFC 8187): percent-encoded
      ["a b'(c)*%.txt", "a b'(c)*%.txt", "a%20b%27%28c%29%2A%25.txt"],
      // Not in a quoted string, nor ASCII
      [`"q"\\.txt`, "_q__.txt", "%22q%22%5C.txt"],
      [
        "отчёт €.csv",
        "_____ _.csv",
        "%D0%BE%D1%82%D1%87%D1%91%D1%82%20%E2%82%AC.csv",
      ],
      ["tab\t\r\n.txt", "tab___.txt", "tab%09%0D%0A.txt"],
      ["!#$&+-.^_`|~", "!#$&+-.^_`|~", "!#$&+-.^_`|~"],
    ];
    for (const [name, ascii, encoded] of cases) {
      response.attachment(name);
      deepStrictEqual(
        response.getHeader("Content-Disposition"),
        `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`,
      );
    }

    for (const invalid of ["", "\uD800.txt", 1 as unknown as string]) {
      throws(
        () => response.attachment(invalid),
        new TypeError("The filename is not a non-empty well-formed string"),
      );
    }
  });

  test(".vary()", () => {
    const response = detached();
    ok(response.vary() === response);
    ok(!response.hasHeader("Vary"));

    response.vary("Accept-Encoding");
    deepStrictEqual(response.getHeader("Vary"), "Accept-Encoding");
    // Once each, case-insensitively, after the values set before
    response.setHeader("Vary", ["Origin, accept-encoding", " ", "Cookie"]);
    response.vary("Accept-Encoding", "Accept", "ACCEPT", "Cookie");
    deepStrictEqual(
      response.getHeader("Vary"),
      "Origin, accept-encoding, Cookie, Accept",
    );
    response.setHeader("Vary", "Origin");
    response.vary();
    deepStrictEqual(response.getHeader("Vary"), "Origin");

    // `*` replaces them all, and stays
    response.vary("Accept", "*");
    deepStrictEqual(response.getHeader("Vary"), "*");
    response.vary("Accept");
    deepStrictEqual(response.getHeader("Vary"), "*");

    for (const invalid of ["", "A B", "X\r\nY: z", "a,b"]) {
      throws(
        () => response.vary("Accept", invalid),
        new TypeError(`Invalid field name: ${invalid}`),
      );
    }
    deepStrictEqual(response.getHeader("Vary"), "*");
  });

  test(".clearCookie()", async () => {
    const handled = server.handle(async (_request, response) => {
      response.cookies
        .add(new Cookie({ key: "session", value: "1" }))
        .add(new Cookie({ key: "session", value: "2", path: "/app" }))
        .add(new Cookie({ key: "other", value: "3" }));
      ok(response.clearCookie("session") === response);
      response.clearCookie("chips", {
        domain: "example.com",
        path: "/x",
        same_site: "None",
        partitioned: true,
      });
      response.clearCookie("plain", { secure: true, same_site: "Strict" });
      await response.send();
    });
    const { headers } = await server.request();
    deepStrictEqual(await handled, null);
    deepStrictEqual(headers["set-cookie"], [
      // Another path: another cookie
      "session=2; Path=/app; HttpOnly; SameSite=Lax",
      "other=3; Path=/; HttpOnly; SameSite=Lax",
      // Replaces the cookie of the same name, domain and path
      "session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax",
      "chips=; Max-Age=0; Domain=example.com; Path=/x; Secure; HttpOnly; SameSite=None; Partitioned",
      "plain=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict",
    ]);

    throws(
      () => detached().clearCookie("a b"),
      new TypeError("Invalid cookie name: a b"),
    );
  });

  test("Cookie (`partitioned` implies `Secure`)", () => {
    const cookie = new Cookie({ key: "k", value: "v", partitioned: true });
    deepStrictEqual(cookie.partitioned, true);
    deepStrictEqual(cookie.secure, true);
    deepStrictEqual(
      cookie.toString(),
      "k=v; Path=/; Secure; HttpOnly; SameSite=Lax; Partitioned",
    );
    const unpartitioned = new Cookie({ key: "k", value: "v" });
    deepStrictEqual(unpartitioned.partitioned, false);
    deepStrictEqual(unpartitioned.secure, false);
  });
});
