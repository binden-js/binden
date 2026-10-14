import { deepStrictEqual, ok, rejects, throws } from "node:assert";
import {
  IncomingMessage,
  type OutgoingHttpHeader,
  type OutgoingHttpHeaders,
  get,
  request,
} from "node:http";
import { Socket } from "node:net";
import { Readable } from "node:stream";
import { afterEach, suite, test } from "node:test";

import { BindenResponse, Cookie } from "../index.js";
import { type ITestServer, type IListenOptions, listen } from "./http.js";

/** A response without a connection: nothing is actually sent */
function detached(): BindenResponse {
  return new BindenResponse(new IncomingMessage(new Socket()));
}

/** The settled value of a promise: `null` once resolved, or its error */
function settle(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

/** `undefined`, which the linter does not let the tests write */
const none = ({} as { value?: undefined }).value;

const cookie1 = new Cookie({ key: "c1", value: "1" });
const cookie2 = new Cookie({ key: "c2", value: "2" });
const cookies = [cookie1.toString(), cookie2.toString()];

suite("BindenResponse (headers, flush, ETag and seal)", () => {
  let server: ITestServer | null = null;

  const start = async (options?: IListenOptions): Promise<ITestServer> => {
    server = await listen(options);
    return server;
  };

  afterEach(async () => {
    const current = server;
    server = null;
    await current?.close();
  });

  test("cookies are added once, by every `writeHead()` overload", async () => {
    const app = await start();
    type IHeadersArg = OutgoingHttpHeader[] | OutgoingHttpHeaders;
    const cases: [
      string,
      (response: BindenResponse) => void,
      string[],
      Record<string, string>,
    ][] = [
      ["status only", (r): unknown => r.writeHead(200), cookies, {}],
      [
        "set before",
        (r): unknown => r.setHeader("Set-Cookie", "a=1").writeHead(201),
        ["a=1", ...cookies],
        {},
      ],
      [
        "an object, which replaces the value set before",
        (r): unknown =>
          r
            .setHeader("Set-Cookie", "old=0")
            .writeHead(200, { "Set-Cookie": "a=1", "X-A": "1" }),
        ["a=1", ...cookies],
        { "x-a": "1" },
      ],
      [
        "a reason phrase and an object",
        (r): unknown =>
          r.writeHead(200, "Fine", {
            "set-cookie": ["a=1", "b=2"],
            "SET-COOKIE": 3 as unknown as string,
          }),
        ["a=1", "b=2", "3", ...cookies],
        {},
      ],
      [
        "an object without Set-Cookie",
        (r): unknown =>
          r.setHeader("Set-Cookie", "a=1").writeHead(200, { "X-A": "1" }),
        ["a=1", ...cookies],
        { "x-a": "1" },
      ],
      [
        "a reason phrase without headers",
        (r): unknown => r.writeHead(200, "Fine"),
        cookies,
        {},
      ],
      [
        "a flat array",
        (r): unknown =>
          r
            .setHeader("Set-Cookie", "old=0")
            .writeHead(200, [
              "Set-Cookie",
              "a=1",
              "X-A",
              "1",
              "set-cookie",
              "b=2",
            ]),
        ["a=1", "b=2", ...cookies],
        { "x-a": "1" },
      ],
      [
        "pairs",
        (r): unknown =>
          r.writeHead(200, [
            ["X-A", "1"],
            ["Set-Cookie", ["a=1"]],
          ] as unknown as IHeadersArg),
        ["a=1", ...cookies],
        { "x-a": "1" },
      ],
      [
        "an array without Set-Cookie",
        (r): unknown => r.writeHead(200, ["X-A", "1"]),
        cookies,
        { "x-a": "1" },
      ],
      [
        "the second argument when it is not a reason phrase",
        (r): unknown => r.writeHead(200, none, { "X-A": "1" } as IHeadersArg),
        cookies,
        { "x-a": "1" },
      ],
    ];
    for (const [name, writeHead, expected, extra] of cases) {
      const handled = app.handle((_request, response) => {
        response.cookies.add(cookie1).add(cookie2);
        writeHead(response);
        // Once: not again when the headers are sent
        response.cookies.add(new Cookie({ key: "late", value: "1" }));
        response.end();
      });
      const { headers } = await app.request();
      deepStrictEqual(await handled, null, name);
      deepStrictEqual(headers["set-cookie"], expected, name);
      for (const [key, value] of Object.entries(extra)) {
        deepStrictEqual(headers[key], value, name);
      }
    }
  });

  test("cookies are added by the implicit headers", async () => {
    const app = await start();
    const cases: [string, (response: BindenResponse) => unknown][] = [
      [
        "write()",
        (r): void => {
          r.write("body");
          r.end();
        },
      ],
      ["end()", (r): unknown => r.end("body")],
      [
        "flushHeaders()",
        (r): void => {
          r.flushHeaders();
          r.end();
        },
      ],
      ["pipe()", (r): unknown => Readable.from(["a", "b"]).pipe(r)],
      ["send()", (r): unknown => r.status(204).send()],
    ];
    for (const [name, commit] of cases) {
      const handled = app.handle((_request, response) => {
        response.setHeader("Set-Cookie", "a=1");
        response.cookies.add(cookie1).add(cookie2);
        return commit(response);
      });
      const { headers } = await app.request();
      deepStrictEqual(await handled, null, name);
      deepStrictEqual(headers["set-cookie"], ["a=1", ...cookies], name);
    }

    // `HEAD`
    const head = app.handle((_request, response) => {
      response.cookies.add(cookie1);
      response.end();
    });
    const { headers } = await app.request({ method: "HEAD" });
    deepStrictEqual(await head, null);
    deepStrictEqual(headers["set-cookie"], [cookie1.toString()]);
  });

  test("cookies are kept for the next attempt when `writeHead()` throws", async () => {
    const app = await start();
    const handled = app.handle((_request, response) => {
      response.cookies.add(cookie1);
      throws(() => response.writeHead(1000), {
        code: "ERR_HTTP_INVALID_STATUS_CODE",
      });
      ok(!response.hasHeader("Set-Cookie"));
      response.setHeader("Set-Cookie", "a=1");
      throws(() => response.writeHead(200, { "X-Bad": "\r\n" }), {
        code: "ERR_INVALID_CHAR",
      });
      deepStrictEqual(response.getHeader("Set-Cookie"), "a=1");
      ok(!response.headersSent);
      response.writeHead(200, { "Set-Cookie": "b=2" });
      throws(() => response.writeHead(200), { code: "ERR_HTTP_HEADERS_SENT" });
      response.end();
    });
    const { headers } = await app.request();
    deepStrictEqual(await handled, null);
    deepStrictEqual(headers["set-cookie"], ["b=2", cookie1.toString()]);
  });

  test(".flush() sends the headers and what is written", async () => {
    const app = await start();
    let release = (): void => {
      // Replaced below
    };
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handled = app.handle(async (_request, response) => {
      response.cookies.add(cookie1);
      await response.flush();
      ok(response.headersSent);
      response.write("first");
      await response.flush();
      // The client has them before the end
      await released;
      response.end("last");
    });
    const received = await new Promise<string[]>((resolve, reject) => {
      const parts: string[] = [];
      get(app.url, { signal: AbortSignal.timeout(5000) }, (response) => {
        parts.push(String(response.headers["set-cookie"]));
        response
          .setEncoding("utf8")
          .on("data", (chunk: string) => {
            parts.push(chunk);
            if (chunk === "first") {
              release();
            }
          })
          .once("end", () => {
            resolve(parts);
          });
      }).once("error", reject);
    });
    deepStrictEqual(await handled, null);
    deepStrictEqual(received, [cookie1.toString(), "first", "last"]);

    // Without a body (`HEAD`), then ended and finished
    let headers = (): void => {
      // Replaced below
    };
    const sent = new Promise<void>((resolve) => {
      headers = resolve;
    });
    const head = app.handle(async (_request, response) => {
      await response.flush();
      // The client has them before the end
      await sent;
      response.end();
      const finishing = response.flush();
      await finishing;
      ok(response.writableFinished);
      await response.flush();
    });
    await new Promise<void>((resolve, reject) => {
      request(
        app.url,
        { method: "HEAD", signal: AbortSignal.timeout(5000) },
        (response) => {
          headers();
          response.resume().once("end", resolve);
        },
      )
        .once("error", reject)
        .end();
    });
    deepStrictEqual(await head, null);
  });

  test(".flush() rejects when the response is closed or fails", async () => {
    const closed = detached();
    const flushing = closed.flush();
    // Committed, but not written without a connection
    ok(closed.headersSent);
    closed.emit("close");
    deepStrictEqual(
      ((await settle(flushing)) as { code?: unknown }).code,
      "ERR_STREAM_PREMATURE_CLOSE",
    );
    deepStrictEqual(closed.listenerCount("close"), 0);

    const failing = new Error("failed");
    const errored = detached();
    const erroring = errored.flush();
    errored.emit("error", failing);
    deepStrictEqual(await settle(erroring), failing);
    deepStrictEqual(errored.listenerCount("error"), 0);

    const unknown = detached();
    const unknownFlush = unknown.flush();
    unknown.emit("error");
    deepStrictEqual(
      ((await settle(unknownFlush)) as { code?: unknown }).code,
      "ERR_STREAM_PREMATURE_CLOSE",
    );

    // A write that fails
    const write = detached();
    write.write = ((_chunk: unknown, callback: (error?: Error) => void) => {
      callback(failing);
      return false;
    }) as typeof write.write;
    deepStrictEqual(await settle(write.flush()), failing);
    deepStrictEqual(write.listenerCount("close"), 0);

    // Destroyed, or ended and then closed before it has finished
    const destroyed = detached();
    destroyed.destroy();
    deepStrictEqual(
      ((await settle(destroyed.flush())) as { code?: unknown }).code,
      "ERR_STREAM_PREMATURE_CLOSE",
    );
    const ended = detached();
    ended.end();
    const endedFlush = ended.flush();
    ended.emit("close");
    deepStrictEqual(
      ((await settle(endedFlush)) as { code?: unknown }).code,
      "ERR_STREAM_PREMATURE_CLOSE",
    );
  });

  test(".send() (rejects an unknown encoding before the response)", async () => {
    const response = detached();
    await rejects(
      () => response.send("data", "nope" as BufferEncoding),
      new TypeError("Unknown encoding: nope"),
    );
    ok(!response.started);
    ok(!response.hasHeader("Content-Length"));
  });
});
