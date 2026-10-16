import {
  Binden,
  BindenResponse,
  type Context,
  type IResponseOptions,
  validateResponseOptions,
} from "../index.js";
import { type IReply, type ITestServer, listen } from "./http.js";
import { IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { PassThrough, Readable } from "node:stream";
import { Socket, connect } from "node:net";
import { afterEach, suite, test } from "node:test";
import { deepStrictEqual, ok, rejects, throws } from "node:assert/strict";
import { listen as listenApp, within } from "./helpers.js";
import { createHash } from "node:crypto";
import { once } from "node:events";

/** A response with the dynamic `ETag` */
class EtagResponse extends BindenResponse {
  // eslint-disable-next-line class-methods-use-this -- the options of a subclass
  protected override get options(): Readonly<IResponseOptions> {
    return validateResponseOptions({ etag: true });
  }
}

/** The strong `ETag` of a body */
function etagOf(body: Buffer): string {
  return `"${createHash("sha256").update(body).digest("base64url")}"`;
}

/** `undefined`, which the linter does not let the tests write */
const none = ({} as { value?: undefined }).value;

/** The settled value of a promise: `null` once resolved, or its error */
function settle(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

/** Sends raw requests on one connection, and reads until the server closes it */
async function raw(url: string, data: string): Promise<string> {
  const socket = connect(Number(new URL(url).port), "localhost");
  await once(socket, "connect");
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  const closed = once(socket, "close");
  socket.write(data);
  await within(closed, 5000);
  return Buffer.concat(chunks).toString("latin1");
}

suite("BindenResponse (bodies)", () => {
  const servers: ITestServer[] = [];

  const start = async (etag = false): Promise<ITestServer> => {
    const app = await listen(etag ? { Response: EtagResponse } : {});
    servers.push(app);
    return app;
  };

  /** Replies one request with the handler (on a server of its own) */
  const reply = async (
    handler: (response: BindenResponse) => Promise<unknown>,
    options: { method?: string; headers?: OutgoingHttpHeaders } = {},
    etag = false,
  ): Promise<IReply> => {
    const app = await start(etag);
    const handled = app.handle(async (_request, response) => handler(response));
    const received = await app.request(options);
    deepStrictEqual(await handled, null);
    return received;
  };

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (app) => app.close()));
  });

  test("the declared length of a stream is read once, before its first write", async () => {
    // As a compression, which removes the length when it starts
    const removing = (response: BindenResponse): void => {
      const write = response.write.bind(response);
      response.write = (...args: unknown[]): boolean => {
        response.removeHeader("Content-Length");
        return Reflect.apply(write, response, args) as boolean;
      };
    };
    for (const chunks of [["abc"], ["ab", "cdef"]]) {
      const app = await start();
      let error: unknown = null;
      const handled = app.handle(async (_request, response) => {
        removing(response);
        response.setHeader("Content-Length", 4);
        error = await settle(response.send(Readable.from(chunks)));
      });
      // Cut: never a complete (chunked) body
      await rejects(app.request(), (reason: unknown) => {
        ok(reason instanceof Error);
        return true;
      });
      deepStrictEqual(await handled, null);
      deepStrictEqual(
        (error as { code?: unknown }).code,
        "ERR_HTTP_CONTENT_LENGTH_MISMATCH",
      );
    }
  });

  test("`send(string, encoding)` encodes the string once: its bytes give the length and the `ETag`", async () => {
    const encoded = Buffer.from("x".repeat(120)).toString("base64");
    // Not canonical: line breaks every 76 characters
    const base64 = encoded.replaceAll(/(?<line>.{76})/gu, "$<line>\r\n");
    const bytes = Buffer.from(base64, "base64");
    deepStrictEqual(bytes.length, 120);
    const received = await reply(
      (response) => response.send(base64, "base64"),
      {},
      true,
    );
    deepStrictEqual(received.headers["content-length"], "120");
    deepStrictEqual(received.headers.etag, etagOf(bytes));
    ok(received.body.equals(bytes));

    // The next response of the connection is not read as a part of the body
    const app = await start();
    app
      .handle(async (_request, response) => response.send(base64, "base64"))
      .catch(() => null);
    app
      .handle(async (_request, response) => response.send("next"))
      .catch(() => null);
    const both = await raw(
      app.url,
      "GET / HTTP/1.1\r\nHost: a\r\n\r\nGET / HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n",
    );
    ok(both.endsWith("\r\n\r\nnext"), both);
    ok(both.includes(`\r\n\r\n${"x".repeat(120)}HTTP/1.1 200 OK`), both);

    // Invalid hex: what is decoded (nothing) is sent
    const hex = await reply((response) => response.send("zz", "hex"));
    deepStrictEqual([hex.headers["content-length"], hex.body.length], ["0", 0]);
  });

  test("`GET` and `HEAD` are framed alike, with a `Content-Type` only for a status with a body", async () => {
    const cases: [
      string,
      (response: BindenResponse) => Promise<void>,
      [string | null, string | null],
    ][] = [
      ["send()", async (r): Promise<void> => r.send(), ["0", null]],
      ['send("")', async (r): Promise<void> => r.send(""), ["0", "text/plain"]],
      [
        "send(empty Buffer)",
        async (r): Promise<void> => r.send(Buffer.alloc(0)),
        ["0", "text/plain"],
      ],
      [
        "404 send() with a type",
        async (r): Promise<void> => r.status(404).type("text/html").send(),
        ["0", "text/html"],
      ],
      [
        "204 send(body)",
        async (r): Promise<void> => r.status(204).send("x"),
        [null, null],
      ],
      [
        "304 send(body)",
        async (r): Promise<void> => r.status(304).send("x"),
        [null, null],
      ],
    ];
    for (const [name, handler, expected] of cases) {
      for (const method of ["GET", "HEAD"]) {
        const { headers, body } = await reply(handler, { method });
        deepStrictEqual(
          [
            headers["content-length"] ?? null,
            headers["content-type"] ?? null,
            body.length,
          ],
          [...expected, 0],
          `${method} ${name}`,
        );
        ok(!("transfer-encoding" in headers), `${method} ${name}`);
      }
    }
    // A length given to `HEAD` (of the body of `GET`) is kept
    for (const [method, length] of [
      ["HEAD", "42"],
      ["GET", "0"],
    ] as const) {
      const { headers } = await reply(
        async (r): Promise<void> => r.setHeader("Content-Length", 42).send(),
        { method },
      );
      deepStrictEqual(headers["content-length"], length, method);
    }
  });

  test("an empty string has the `ETag` of an empty body", async () => {
    const empty = etagOf(Buffer.alloc(0));
    for (const body of ["", Buffer.alloc(0)]) {
      for (const method of ["GET", "HEAD"]) {
        const sent = await reply(
          (response) => response.send(body),
          { method },
          true,
        );
        deepStrictEqual([sent.status, sent.headers.etag], [200, empty], method);
        const cached = await reply(
          (response) => response.send(body),
          { method, headers: { "If-None-Match": "*" } },
          true,
        );
        deepStrictEqual(
          [
            cached.status,
            cached.headers.etag,
            cached.headers["content-length"],
          ],
          [304, empty, "0"],
          method,
        );
      }
    }
  });

  test("a stream that has ended is an empty body, of the declared length", async () => {
    const ended = async (): Promise<Readable> => {
      const source = Readable.from(["abc"]);
      source.resume();
      await once(source, "end");
      return source;
    };
    const source = await ended();
    const received = await reply((response) => response.send(source));
    deepStrictEqual(
      [
        received.status,
        received.headers["content-length"],
        received.body.length,
      ],
      [200, "0", 0],
    );

    // Not of its length: rejected before anything is sent
    let error: unknown = null;
    const declared = await ended();
    const failed = await reply(async (response) => {
      response.setHeader("Content-Length", 3);
      error = await settle(response.send(declared));
      ok(!response.started);
      await response.status(500).send();
    });
    deepStrictEqual(failed.status, 500);
    deepStrictEqual(
      (error as { code?: unknown }).code,
      "ERR_HTTP_CONTENT_LENGTH_MISMATCH",
    );
  });

  test("a stream that has been destroyed rejects at once", async () => {
    const source = Readable.from(["abc"]);
    source.destroy();
    await once(source, "close");
    let error: unknown = null;
    const received = await reply(async (response) => {
      error = await within(settle(response.send(source)), 1000);
      ok(!response.started);
      await response.status(500).send();
    });
    deepStrictEqual(received.status, 500);
    deepStrictEqual(
      (error as { code?: unknown }).code,
      "ERR_STREAM_PREMATURE_CLOSE",
    );
  });

  test("a stream that fails before its first chunk leaves no framing, unless the response is framed since", async () => {
    const range = "bytes 0-9/20";
    const changes: [string, (response: BindenResponse) => void, unknown[]][] = [
      [
        "nothing",
        (): void => {
          // The framing of the send stays
        },
        [none, none],
      ],
      // Of another header: the framing is still the one of the send
      [
        "another header",
        (response): void => {
          response.setHeader("X-Other", "1");
        },
        [none, none],
      ],
      [
        "a length set",
        (response): void => {
          response.setHeader("Content-Length", 4);
        },
        [4, range],
      ],
      [
        "a range removed",
        (response): void => {
          response.removeHeader("Content-Range");
        },
        [10, none],
      ],
      [
        "a transfer coding set",
        (response): void => {
          response.setHeader("Transfer-Encoding", "chunked");
        },
        [10, range],
      ],
      [
        // Framed as if it had never been attempted
        "a head that Node.js refuses",
        (response): void => {
          throws(
            () =>
              response.writeHead(206, { "Content-Length": 10, Trailer: "X-T" }),
            { code: "ERR_HTTP_TRAILER_INVALID" },
          );
        },
        [none, none],
      ],
      [
        "a range appended",
        (response): void => {
          response.appendHeader("Content-Range", range);
        },
        [10, [range, range]],
      ],
      // Set again, to the same value: framed since all the same
      [
        "the same length set again",
        (response): void => {
          response.setHeader("Content-Length", 10);
        },
        [10, range],
      ],
      // Refused by Node.js: nothing has changed
      [
        "a length that Node.js refuses",
        (response): void => {
          throws(() => response.setHeader("Content-Length", none as never), {
            code: "ERR_HTTP_INVALID_HEADER_VALUE",
          });
        },
        [none, none],
      ],
      [
        "a length appended that Node.js refuses",
        (response): void => {
          throws(() => response.appendHeader("Content-Length", none as never), {
            code: "ERR_HTTP_INVALID_HEADER_VALUE",
          });
        },
        [none, none],
      ],
    ];
    for (const [name, change, expected] of changes) {
      let framing: unknown[] = [];
      let error: unknown = null;
      const received = await reply(async (response) => {
        const source = new PassThrough();
        response
          .set({ "Content-Length": 10, "Content-Range": range })
          .status(206);
        const sent = settle(response.send(source));
        change(response);
        source.destroy(new Error("Failed"));
        error = await within(sent, 1000);
        framing = [
          response.getHeader("Content-Length"),
          response.getHeader("Content-Range"),
        ];
        response.removeHeader("Content-Length");
        response.removeHeader("Content-Range");
        await response.status(500).send("failed");
      });
      deepStrictEqual(framing, expected, name);
      deepStrictEqual((error as Error).message, "Failed", name);
      deepStrictEqual(
        [received.status, received.body.toString()],
        [500, "failed"],
        name,
      );
    }
  });

  test("a 1xx status is not sent as the final response", async () => {
    const message = new TypeError(
      "Status code 103 is informational (use writeEarlyHints())",
    );
    const response = new BindenResponse(new IncomingMessage(new Socket()));
    response.status(103);
    await rejects(response.send("data"), message);
    await rejects(response.json({ a: 1 }), message);
    const source = Readable.from(["data"]);
    await rejects(response.send(source), message);
    // Released
    ok(source.destroyed);
    ok(!response.started);
    ok(!response.headersSent);
  });

  test("a reply without a body has no `Trailer`, which Node.js refuses without chunks", async () => {
    const trailer = (response: BindenResponse): BindenResponse =>
      response.setHeader("Trailer", "X-T");
    const stream = (): Readable => Readable.from(["abc"]);
    const file = import.meta.filename;
    /** Replies, the method of their request, and the status and the body that they get */
    const cases: [
      string,
      (response: BindenResponse) => Promise<unknown>,
      string,
      number,
      string,
    ][] = [
      // Chunked: with its trailers
      [
        "stream",
        async (r): Promise<void> => {
          trailer(r).addTrailers({ "X-T": "1" });
          await r.send(stream());
        },
        "GET",
        200,
        "abc",
      ],
      [
        "stream",
        async (r): Promise<unknown> => trailer(r).send(stream()),
        "HEAD",
        200,
        "",
      ],
      [
        "empty",
        async (r): Promise<unknown> => trailer(r).send(),
        "HEAD",
        200,
        "",
      ],
      [
        "bytes",
        async (r): Promise<unknown> => trailer(r).send("abc"),
        "HEAD",
        200,
        "",
      ],
      [
        "304",
        async (r): Promise<unknown> => trailer(r).status(304).send(),
        "GET",
        304,
        "",
      ],
      [
        "204 stream",
        async (r): Promise<unknown> => trailer(r).status(204).send(stream()),
        "GET",
        204,
        "",
      ],
      [
        "205",
        async (r): Promise<unknown> => trailer(r).status(205).send("abc"),
        "GET",
        205,
        "",
      ],
      [
        "file",
        async (r): Promise<unknown> => trailer(r).sendFile(file),
        "HEAD",
        200,
        "",
      ],
      [
        "204 file",
        async (r): Promise<unknown> => trailer(r).status(204).sendFile(file),
        "GET",
        204,
        "",
      ],
    ];
    for (const [name, handler, method, status, body] of cases) {
      const received = await reply(handler, { method });
      const key = `${method} ${name}`;
      deepStrictEqual(
        [received.status, received.body.toString()],
        [status, body],
        key,
      );
      deepStrictEqual(
        received.headers.trailer,
        status === 200 && method === "GET" ? "X-T" : none,
        key,
      );
    }
    // The `304` of the dynamic `ETag`, and of a file
    const headers = { "If-None-Match": "*" };
    const notModified = [
      await reply(
        async (r): Promise<unknown> => trailer(r).send("abc"),
        { headers },
        true,
      ),
      await reply(async (r): Promise<unknown> => trailer(r).sendFile(file), {
        headers,
      }),
    ];
    for (const received of notModified) {
      deepStrictEqual([received.status, received.headers.trailer], [304, none]);
    }
  });

  test(".type() accepts only parameters of a token and a token or a quoted string", () => {
    const response = new BindenResponse(new IncomingMessage(new Socket()));
    for (const [valid, expected] of [
      ["text/plain;", "text/plain"],
      ['text/plain; a="b c"; d=e', 'text/plain; a="b c"; d=e'],
      ['text/plain ;\ta="\\"q\\""', 'text/plain; a="\\"q\\""'],
    ]) {
      deepStrictEqual(response.type(valid).getHeader("Content-Type"), expected);
    }
    for (const invalid of [
      "text/plain; charset",
      "text/plain; a=b c",
      "text/plain; =x",
      'text/plain; a="unterminated',
      "text/plain; a=b;c",
      "text/plain; a=(b)",
      "text/plain, text/html",
      42,
    ]) {
      throws(
        () => response.type(invalid as string),
        new TypeError(`Invalid media type: ${String(invalid)}`),
      );
    }
  });
});

suite("The framing of a send that fails", () => {
  test("is removed after a setter that Node.js refuses: the error reply has its own length", async () => {
    const setters: Record<string, (response: BindenResponse) => unknown> = {
      set: (response) => response.setHeader("Content-Length", none as never),
      append: (response) =>
        response.appendHeader("Content-Length", none as never),
    };
    const refused: unknown[] = [];
    const app = new Binden({
      error_handler: ({ response }: Context): void => {
        response.end("ERR");
      },
    }).use(async ({ request, response }: Context) => {
      const setter = setters[(request.url ?? "/").slice(1)];
      if (typeof setter === "undefined") {
        response.end("next");
        return;
      }
      const source = new PassThrough();
      response.setHeader("Content-Length", 10);
      const pending = response.send(source);
      try {
        setter(response);
      } catch (error: unknown) {
        refused.push((error as { code?: unknown }).code);
      }
      source.destroy();
      await pending;
    });
    const listening = await listenApp(app);
    try {
      for (const name of Object.keys(setters)) {
        const data = await raw(
          listening.url,
          `GET /${name} HTTP/1.1\r\nHost: a\r\n\r\n` +
            "GET /next HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n",
        );
        const [failed = "", next = "", ...rest] = data
          .replaceAll(/\r\nDate: [^\r]*/gu, "")
          .split(/(?=HTTP\/1\.1 )/u);
        deepStrictEqual(
          [failed, rest],
          [
            // Removed by the framework (see `removeHeader()`): chunked
            "HTTP/1.1 200 OK\r\nConnection: keep-alive\r\nKeep-Alive: timeout=5\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nERR\r\n0\r\n\r\n",
            [],
          ],
          name,
        );
        ok(next.startsWith("HTTP/1.1 200 OK\r\n"), `${name}: ${next}`);
        ok(next.endsWith("\r\n\r\nnext"), `${name}: ${next}`);
      }
      deepStrictEqual(refused, [
        "ERR_HTTP_INVALID_HEADER_VALUE",
        "ERR_HTTP_INVALID_HEADER_VALUE",
      ]);
    } finally {
      await listening.close();
    }
  });
});
