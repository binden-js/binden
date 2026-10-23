import { type AddressInfo, Socket } from "node:net";
import {
  Binden,
  BindenResponse,
  type Context,
  type IResponseOptions,
  kNegotiator,
  validateResponseOptions,
} from "../index.js";
import { IncomingMessage, type ServerResponse, createServer } from "node:http";
import { deepStrictEqual, ok, rejects } from "node:assert/strict";
import { listen, within } from "./helpers.js";
import { suite, test } from "node:test";
import { converse } from "./connection.js";
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
function etagOf(body: string): string {
  return `"${createHash("sha256").update(body).digest("base64url")}"`;
}

/**
 * A response without a connection to an HTTP/1.1 request (nothing is sent),
 * with the dynamic `ETag` or not
 */
function detached(
  method: string,
  headers: Record<string, string>,
  etag: boolean,
): BindenResponse {
  const request = new IncomingMessage(new Socket());
  request.httpVersionMajor = 1;
  request.httpVersionMinor = 1;
  request.method = method;
  request.headers = headers;
  return etag ? new EtagResponse(request) : new BindenResponse(request);
}

/** The value sends, by name (`hello` as a body) */
const sends: Record<string, (response: BindenResponse) => Promise<void>> = {
  "send() of a string": async (response) => response.send("hello"),
  "send() of bytes": async (response) => response.send(Buffer.from("hello")),
  "send() of a number": async (response) => response.send(5),
  "send() without a body": async (response) => response.send(),
  "json()": async (response) => response.json({ a: 1 }),
  "text()": async (response) => response.text("hello"),
  "html()": async (response) => response.html("hello"),
  "form()": async (response) => response.form(new URLSearchParams("a=1")),
};

/** What Node.js refuses as it commits the head, by name, and its code */
const refusals: Record<string, [(response: ServerResponse) => void, string]> = {
  "a reason phrase": [
    (response): void => {
      response.statusMessage = "bad\nx";
    },
    "ERR_INVALID_CHAR",
  ],
  "a status out of range": [
    (response): void => {
      response.statusCode = 1000;
    },
    "ERR_HTTP_INVALID_STATUS_CODE",
  ],
  "a status out of range once truncated": [
    (response): void => {
      response.statusCode = 99.9;
    },
    "ERR_HTTP_INVALID_STATUS_CODE",
  ],
  "a Trailer of a body that is not chunked": [
    (response): void => {
      response.setHeader("Trailer", "X-T");
    },
    "ERR_HTTP_TRAILER_INVALID",
  ],
};

/** The state of a response that a reply that follows a send inherits */
function stateOf(response: ServerResponse): unknown[] {
  return [
    response.statusCode,
    response.statusMessage,
    response.getHeaders(),
    response.headersSent,
    Reflect.get(response, "_removedContLen"),
    Reflect.get(response, "_removedTE"),
  ];
}

suite(
  "A value send whose head Node.js refuses as it commits it, while the head is not sent (H30-2)",
  () => {
    test("rejects, and leaves the response as it was before it: the reply that follows inherits neither its Content-Type, its ETag, its status nor the framing of its body", async () => {
      // To `GET` and `HEAD`, with the dynamic `ETag` (and the conditions of
      // its `304` and `412`) or without, with or without a `Content-Type` set
      // before
      const requests: [string, Record<string, string>, boolean][] = [
        ["GET", {}, false],
        ["HEAD", {}, false],
        ["GET", {}, true],
        ["GET", { "if-none-match": etagOf("hello") }, true],
        ["GET", { "if-match": '"other"' }, true],
      ];
      for (const [name, send] of Object.entries(sends)) {
        for (const [refused, [refuse, code]] of Object.entries(refusals)) {
          // A `Trailer` is removed by the send of an empty reply (see
          // `#frame()`): only the body of `GET` has it
          const refusing = requests.filter(
            ([method, headers]) =>
              refused !== "a Trailer of a body that is not chunked" ||
              (method === "GET" && Object.keys(headers).length === 0),
          );
          for (const [method, headers, etag] of refusing) {
            for (const type of [null, "text/x-app"]) {
              const label = `${name}, ${refused}, ${method} ${JSON.stringify(headers)} ${String(etag)} ${String(type)}`;
              const response = detached(method, headers, etag);
              response.setHeader("X-App", "1");
              if (type !== null) {
                response.setHeader("Content-Type", type);
              }
              refuse(response);
              const before = stateOf(response);
              // Refused before anything is sent: it rejects at once
              await rejects(within(send(response)), { code }, label);
              deepStrictEqual(stateOf(response), before, label);
            }
          }
        }
      }
    });

    test("the framing set before it is removed, as by the unwind of a file: the reply that follows frames its own body", async () => {
      for (const [header, value] of [
        ["Content-Length", 5],
        ["Transfer-Encoding", "chunked"],
      ] as const) {
        const response = detached("GET", {}, false);
        response.setHeader(header, value);
        response.statusMessage = "bad\nx";
        await rejects(within(response.send("hello")), {
          code: "ERR_INVALID_CHAR",
        });
        deepStrictEqual(
          [
            response.getHeaderNames(),
            response.headersSent,
            Reflect.get(response, "_removedContLen"),
            Reflect.get(response, "_removedTE"),
          ],
          [
            [],
            false,
            header === "Content-Length",
            header === "Transfer-Encoding",
          ],
          header,
        );
      }
    });

    test("the representation chosen for its body is forgotten: the reply that follows gets its own", async () => {
      let chosen = 0;
      let forgotten = 0;
      const response = detached("GET", {}, true);
      response[kNegotiator]({
        choose: () => {
          chosen += 1;
          return { coding: null, status: null };
        },
        forget: () => {
          forgotten += 1;
        },
      });
      response.statusMessage = "bad\nx";
      await rejects(within(response.send("hello")), {
        code: "ERR_INVALID_CHAR",
      });
      deepStrictEqual([chosen, forgotten], [1, 1]);
    });

    test("once the head is committed (e.g. Node.js throws afterwards, as it corks the socket), the response is left as it is: the send rejects with that error", async () => {
      const { promise: outcome, resolve } = Promise.withResolvers<unknown[]>();
      const app = new Binden().use(async (context: Context) => {
        const { response } = context;
        (response.socket as Socket).cork = (): void => {
          throw Object.assign(new Error("After the head"), {
            code: "E_AFTER_HEAD",
          });
        };
        const error = await response.send("hello").then(
          () => null,
          (thrown: unknown) => thrown,
        );
        resolve([
          (error as { code?: unknown } | null)?.code,
          response.headersSent,
          response.getHeader("Content-Length"),
          response.getHeader("Content-Type"),
        ]);
      });
      const listening = await listen(app);
      try {
        await converse(
          listening.port,
          "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        );
        deepStrictEqual(await within(outcome), [
          "E_AFTER_HEAD",
          true,
          5,
          "text/plain",
        ]);
      } finally {
        await listening.close();
      }
    });

    test("in an application: the reply that the work gives after the rejection is framed by its own body, as plain Node.js frames it, and the pipelined request that follows is answered", async () => {
      /**
       * Refuses the reply of a work (of `/status`, `/reason` or `/trailer`),
       * which then replies `err` itself
       */
      const refusing = new Map<string, (response: ServerResponse) => unknown>([
        [
          "status",
          (response): void => {
            response.statusCode = 1000;
          },
        ],
        [
          "reason",
          (response): void => {
            response.statusMessage = "bad\nx";
          },
        ],
        [
          "trailer",
          (response): void => {
            response.setHeader("Trailer", "X-T");
          },
        ],
      ]);
      const replied = async (
        response: ServerResponse,
        refused: string,
        reply: () => unknown,
      ): Promise<void> => {
        // Only the refusals of the test, never a member found by the path
        const refuse = refusing.get(refused);
        ok(refuse, refused);
        refuse(response);
        // Also a synchronous throw
        await Promise.resolve()
          .then(reply)
          .catch(() => null);
        Object.assign(response, {
          statusCode: 500,
          statusMessage: "Internal Server Error",
        });
        response.removeHeader("Trailer");
        response.end("err");
      };
      const app = new Binden().use(async (context: Context) => {
        const { pathname } = context.url;
        if (pathname === "/next") {
          await context.send("next");
          return;
        }
        const [, refused = "", kind = ""] = pathname.split("/");
        const { response } = context;
        await replied(response, refused, async () => {
          await (kind === "json"
            ? response.json({ a: 1 })
            : response.send("hello"));
        });
      });
      const plain = createServer((request, response) => {
        if (request.url === "/next") {
          response.end("next");
          return;
        }
        const [, refused = ""] = (request.url ?? "").split("/");
        replied(response, refused, () => response.end("hello")).catch(
          () => null,
        );
      });
      plain.listen(0, "127.0.0.1");
      await once(plain, "listening");
      const listening = await listen(app);
      /** What a server answers to a reply and the pipelined request after it */
      const received = async (port: number, path: string): Promise<string> =>
        (
          await converse(
            port,
            `GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\nGET /next HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
          )
        ).received.replaceAll(/Date: [^\r]*\r\n/gu, "");
      try {
        for (const refused of Object.keys(refusing)) {
          // Plain Node.js chunks a body that has a `Trailer`, which a value
          // send frames by its length: then as a refused reason phrase
          const expected = await received(
            (plain.address() as AddressInfo).port,
            `/${refused === "trailer" ? "reason" : refused}`,
          );
          ok(
            expected.startsWith(
              "HTTP/1.1 500 Internal Server Error\r\nConnection: keep-alive\r\nKeep-Alive: timeout=5\r\nContent-Length: 3\r\n\r\nerr",
            ),
            expected,
          );
          for (const kind of ["send", "json"]) {
            const text = await received(listening.port, `/${refused}/${kind}`);
            // The reply of the work as plain Node.js frames it, then the
            // reply of the request that follows (of binden's own `send()`)
            deepStrictEqual(
              text.slice(0, text.indexOf("err") + 3),
              expected.slice(0, expected.indexOf("err") + 3),
              `${refused} ${kind}`,
            );
            ok(
              text.endsWith("Connection: close\r\n\r\nnext"),
              `${refused} ${kind}: ${text}`,
            );
          }
        }
      } finally {
        plain.closeAllConnections();
        plain.close();
        await Promise.all([once(plain, "close"), listening.close()]);
      }
    });
  },
);
