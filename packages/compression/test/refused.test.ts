import { type BindenResponse, type Context } from "binden";
import {
  type IServed,
  converse,
  framed,
  gzips,
  serve,
  text,
} from "./helpers.js";
import { afterEach, suite, test } from "node:test";
import { deepStrictEqual, ok } from "node:assert/strict";
import { Compression } from "../index.js";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import zlib from "node:zlib";

const body = text(4096);
const length = { "content-length": 4096 };
// The dynamic `ETag` of the body
const etag = `"${createHash("sha256").update(body).digest("base64url")}"`;

/** The headers that a decision changes (as the error handler gets them) */
const decided = [
  "accept-ranges",
  "connection",
  "content-encoding",
  "content-length",
  "etag",
  "transfer-encoding",
  "vary",
];
const reply = text(2048);
const invalid = "bad\n";

/**
 * Replies that Node.js refuses (in `writeHead()`, or once the reply commits
 * its headers), by path: `kValidateHead` checks them before the decision
 */
const checked: Partial<Record<string, (response: BindenResponse) => unknown>> =
  {
    "/reason": (response) => response.writeHead(201, invalid),
    "/header": (response) => response.writeHead(201, { "X-A": invalid }),
    "/pairs": (response) => response.writeHead(201, ["X-A"]),
    "/end": (response) => {
      response.statusMessage = invalid;
      response.end(body);
    },
    "/write": (response) => {
      response.statusMessage = invalid;
      response.write(body);
    },
    "/flush": async (response) => {
      response.statusMessage = invalid;
      await response.flush();
    },
    "/send": async (response) => {
      response.statusMessage = invalid;
      await response.send(body);
    },
    // Its dynamic `ETag` chooses `406` first: the error reply does not get it
    "/send-406": async (response) => {
      response.statusMessage = invalid;
      await response.send(body);
    },
    "/stream": async (response) => {
      response.statusMessage = invalid;
      await response.send(Readable.from([body]));
    },
    "/file": async (response) => {
      response.statusMessage = invalid;
      await response.sendFile(import.meta.filename, {
        content_type: "text/plain",
        validator: '"f"',
      });
    },
  };

/**
 * Replies that Node.js refuses once the decision is taken: a status out of
 * range, and a `Trailer` of a body that is not chunked (of HTTP/1.0)
 */
const refused: Partial<Record<string, (response: BindenResponse) => unknown>> =
  {
    "/status": (response) => {
      response.statusCode = 1000;
      response.end(body);
    },
    "/trailer": (response) => {
      response.setHeader("Trailer", "X-T");
      response.writeHead(201);
    },
    "/trailer-end": (response) => {
      // Changed by the decision, then restored
      response.set({
        "Content-Length": body.length,
        ETag: '"v"',
        Trailer: "X-T",
        Vary: "Origin",
      });
      response.end(body);
    },
  };

suite("A head that Node.js refuses", () => {
  let served: IServed | null = null;

  afterEach(async () => {
    const current = served;
    served = null;
    await current?.close();
  });

  test("is an error without a compressor, replied with a decision of its own", async () => {
    // By path: the error, then the state of the response that the error
    // handler gets, and the compressors that the reply has created
    const states = new Map<string, unknown[]>();
    await gzips(async (compressors) => {
      let before = 0;
      served = await serve(
        {
          etag: true,
          app: {
            error_handler: async (
              context: Context,
              error: unknown,
            ): Promise<void> => {
              const { response } = context;
              states.set(context.url.pathname, [
                (error as { code?: unknown }).code,
                response.statusCode,
                response.headersSent,
                Object.fromEntries(
                  decided
                    .map((name) => [name, response.getHeader(name)])
                    .filter(([, value]) => typeof value !== "undefined"),
                ),
                compressors.slice(before).map(({ destroyed }) => destroyed),
              ]);
              response.statusMessage = "";
              response.removeHeader("Trailer");
              // An empty body is never refused
              await response
                .status(500)
                .type("text/plain")
                .send(context.url.pathname.endsWith("-406") ? "" : reply);
            },
          },
        },
        new Compression({ format: "gzip" }),
        async (context: Context) => {
          const { response } = context;
          before = compressors.length;
          response.type("text/plain");
          const { pathname } = context.url;
          await (checked[pathname] ?? refused[pathname])?.(response);
        },
      );
      const { url } = served;
      for (const [path, version, accept] of [
        ...Object.keys(checked).map((name) => [
          name,
          "1.1",
          name.endsWith("-406") ? "identity;q=0, gzip;q=0" : "gzip",
        ]),
        ["/status", "1.1", "gzip"],
        ["/status", "1.0", "gzip"],
        ["/trailer", "1.0", "gzip"],
        ["/trailer-end", "1.0", "gzip"],
      ] as const) {
        const responses = await converse(
          url,
          `GET ${path} HTTP/${version}\r\nHost: localhost\r\nAccept-Encoding: ${accept}\r\nConnection: close\r\n\r\n`,
        );
        const name = `${path} (HTTP/${version})`;
        deepStrictEqual(responses.length, 1, name);
        const [response] = responses as [(typeof responses)[0]];
        ok(response.head.startsWith("http/1.1 500 "), name);
        const coding = /\r\ncontent-encoding: (?<coding>\S+)/u.exec(
          response.head,
        )?.groups?.coding;
        const raw = framed(response);
        // The reply of the error has the decision of its own body
        deepStrictEqual(
          typeof coding === "undefined"
            ? [null, raw.toString()]
            : [coding, zlib.gunzipSync(raw).toString()],
          path.endsWith("-406") ? [null, ""] : ["gzip", reply],
          name,
        );
      }
    });

    deepStrictEqual(Object.fromEntries(states), {
      "/reason": ["ERR_INVALID_CHAR", 200, false, {}, []],
      "/header": ["ERR_INVALID_CHAR", 200, false, {}, []],
      "/pairs": ["ERR_INVALID_ARG_VALUE", 200, false, {}, []],
      "/end": ["ERR_INVALID_CHAR", 200, false, {}, []],
      "/write": ["ERR_INVALID_CHAR", 200, false, {}, []],
      "/flush": ["ERR_INVALID_CHAR", 200, false, {}, []],
      "/send": ["ERR_INVALID_CHAR", 200, false, { ...length, etag }, []],
      "/send-406": [
        "ERR_INVALID_CHAR",
        406,
        false,
        { "content-length": 0, etag },
        [],
      ],
      "/stream": ["ERR_INVALID_CHAR", 200, false, {}, []],
      "/file": [
        "ERR_INVALID_CHAR",
        200,
        false,
        // Without the framing of the send that has failed
        { "accept-ranges": "bytes", etag: '"f"' },
        [],
      ],
      // Created, then destroyed
      "/status": ["ERR_HTTP_INVALID_STATUS_CODE", 1000, false, {}, [true]],
      "/trailer": ["ERR_HTTP_TRAILER_INVALID", 200, false, {}, [true]],
      "/trailer-end": [
        "ERR_HTTP_TRAILER_INVALID",
        200,
        false,
        { ...length, etag: '"v"', vary: "Origin" },
        [true],
      ],
    });
  });
});
