import { Binden, BindenResponse, type Context } from "../index.js";
import { IncomingMessage, ServerResponse } from "node:http";
import { deepStrictEqual, ok } from "node:assert/strict";
import { suite, test } from "node:test";
import { Readable } from "node:stream";
import { Socket } from "node:net";
import { converse } from "./connection.js";
import { join } from "node:path";
import { listen } from "./helpers.js";

/** A file that `sendFile()` sends */
const file = join(import.meta.dirname, "..", "package.json");

/** The calls that reply with a body (`hello`) by the status set before */
const replies: Record<string, (response: BindenResponse) => unknown> = {
  "send() of a string": async (response) => response.send("hello"),
  "send() of a Readable": async (response) =>
    response.send(Readable.from(["hello"])),
  "json()": async (response) => response.json("hello"),
  "sendFile()": async (response) => response.sendFile(file),
  "end() of a chunk": (response) => response.end("hello"),
  "write()": (response) => {
    response.write("hello");
    response.end();
  },
};

/**
 * Replies a request by a call with a status, then the pipelined request
 * that follows it with `next`: what the client receives (without the `Date`
 * of each response) until the connection closes
 */
async function received(name: string, status: number): Promise<string> {
  const reply = replies[name];
  const app = new Binden().use(async (context: Context) => {
    if (context.url.pathname === "/next") {
      await context.send("next");
      return;
    }
    context.response.statusCode = status;
    await reply(context.response);
  });
  const listening = await listen(app);
  try {
    const { received: text } = await converse(
      listening.port,
      "GET / HTTP/1.1\r\nHost: localhost\r\n\r\nGET /next HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    );
    return text.replaceAll(/Date: [^\r]*\r\n/gu, "");
  } finally {
    await listening.close();
  }
}

/**
 * A response of binden, or of plain Node.js, to an HTTP/1.1 request (`GET` by
 * default) without a connection
 */
function responseOf(binden: boolean, method = "GET"): ServerResponse {
  const request = new IncomingMessage(new Socket());
  request.httpVersionMajor = 1;
  request.httpVersionMinor = 1;
  request.method = method;
  return binden ? new BindenResponse(request) : new ServerResponse(request);
}

/**
 * Statuses that are not integers, by name, which convert to `201`: an object
 * (that counts its conversions), a string and numbers
 */
const unconverted: Record<string, (count: () => void) => unknown> = {
  object: (count) => ({
    [Symbol.toPrimitive](): number {
      count();
      return 201;
    },
  }),
  string: () => "201",
  fractional: () => 201.5,
  wrapped: () => 2 ** 32 + 201,
};

/** The calls that commit the head by the status of the response, by name */
const commits: Record<string, (response: ServerResponse) => unknown> = {
  "write()": (response) => response.write("abc"),
  'write("")': (response) => response.write(""),
  "end()": (response) => response.end(),
  'end("")': (response) => response.end(""),
  "end(callback)": (response) =>
    response.end(() => {
      // Never called by a refused head
    }),
  "end(null)": (response) => response.end(null),
  "end() of an empty Buffer": (response) => response.end(Buffer.alloc(0)),
  "end() of a chunk": (response) => response.end("abc"),
  "flushHeaders()": (response) => {
    response.flushHeaders();
  },
  "writeHead() of the status of the response": (response) =>
    response.writeHead(response.statusCode),
};

/** The code and the message of what a call throws (`null` when it does not) */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
    return null;
  } catch (error: unknown) {
    const { code, message } = error as { code?: unknown; message: string };
    return [code, message];
  }
}

suite(
  "A statusCode that is a number but not an integer is the integer that Node.js commits (H29-2)",
  () => {
    for (const name of Object.keys(replies)) {
      test(`${name}: framed as that integer, and the pipelined request that follows is answered`, async () => {
        for (const [given, integer] of [
          [204.5, 204],
          [205.5, 205],
          [304.5, 304],
          [200.5, 200],
          // As `| 0` converts it
          [2 ** 32 + 204, 204],
        ] as const) {
          const expected = await received(name, integer);
          ok(expected.endsWith("\r\n\r\nnext"), `${name} ${String(integer)}`);
          deepStrictEqual(
            await received(name, given),
            expected,
            `${name} ${String(given)}`,
          );
        }
      });
    }

    test("one out of range, also once truncated, stays as it is: Node.js refuses it by the value given, as plain Node.js", () => {
      const calls: Record<string, (response: ServerResponse) => unknown> = {
        "end()": (response) => response.end("hello"),
        "write()": (response) => response.write("hello"),
        "flushHeaders()": (response) => {
          response.flushHeaders();
        },
      };
      for (const [name, call] of Object.entries(calls)) {
        for (const status of [99.5, 1000.5, 1e10, 2 ** 32 + 99, Number.NaN]) {
          const [ours, plain] = [true, false].map((binden) => {
            const response = responseOf(binden);
            response.statusCode = status;
            return [
              thrownBy(() => call(response)),
              response.statusCode,
              response.headersSent,
            ];
          });
          deepStrictEqual(ours, plain, `${name} ${String(status)}`);
        }
      }
    });
  },
);

suite(
  "A head refused by its reason phrase stores the status, converted once, as plain Node.js: another attempt does not convert it again (H29-1)",
  () => {
    test("flushHeaders(), a write() and an end(), whose head Node.js commits by the status of the response", () => {
      const calls: Record<string, (response: ServerResponse) => unknown> = {
        "flushHeaders()": (response) => {
          response.flushHeaders();
        },
        "write()": (response) => response.write("abc"),
        "end()": (response) => response.end("abc"),
      };
      for (const [name, call] of Object.entries(calls)) {
        const [ours, plain] = [true, false].map((binden) => {
          let conversions = 0;
          const response = responseOf(binden);
          response.statusCode = {
            [Symbol.toPrimitive](): number {
              conversions += 1;
              return 201;
            },
          } as never;
          response.statusMessage = "bad\r\nx: y";
          const first = thrownBy(() => call(response));
          const status: unknown = response.statusCode;
          response.statusMessage = "Created";
          const retry = thrownBy(() => call(response));
          return [first, status, retry, response.headersSent, conversions];
        });
        deepStrictEqual(ours, plain, name);
        deepStrictEqual(
          ours,
          [
            ["ERR_INVALID_CHAR", "Invalid character in statusMessage"],
            201,
            null,
            true,
            1,
          ],
          name,
        );
      }
    });

    test("every call that commits the head by it (also an end() without a chunk, and any write of a response to HEAD) stores the integer, also of a string or a fractional number (C30-3, H30-1)", () => {
      for (const method of ["GET", "HEAD"]) {
        for (const [name, call] of Object.entries(commits)) {
          for (const [kind, status] of Object.entries(unconverted)) {
            const [ours, plain] = [true, false].map((binden) => {
              let conversions = 0;
              const response = responseOf(binden, method);
              response.statusCode = status(() => {
                conversions += 1;
              }) as never;
              response.statusMessage = "bad\r\nx: y";
              const first = thrownBy(() => call(response));
              const stored: unknown = response.statusCode;
              response.statusMessage = "Created";
              const retry = thrownBy(() => call(response));
              return [first, stored, retry, response.headersSent, conversions];
            });
            const label = `${method} ${name} ${kind}`;
            deepStrictEqual(ours, plain, label);
            deepStrictEqual(
              ours,
              [
                ["ERR_INVALID_CHAR", "Invalid character in statusMessage"],
                201,
                null,
                true,
                kind === "object" ? 1 : 0,
              ],
              label,
            );
          }
        }
      }
    });

    test("a number out of range once truncated is refused by the value given before the encoding of a chunk is checked, as plain Node.js (H30-3)", () => {
      const calls: Record<string, (response: ServerResponse) => unknown> = {
        "write()": (response) => response.write("abc", "bogus" as never),
        "end()": (response) => response.end("abc", "bogus" as never),
      };
      for (const method of ["GET", "HEAD"]) {
        for (const [name, call] of Object.entries(calls)) {
          for (const status of [
            1000,
            1000.5,
            99.9,
            -204,
            2 ** 32 + 99,
            Number.NaN,
            "1000",
          ]) {
            const [ours, plain] = [true, false].map((binden) => {
              const response = responseOf(binden, method);
              response.statusCode = status as never;
              return [
                thrownBy(() => call(response)),
                response.statusCode,
                response.headersSent,
              ];
            });
            const label = `${method} ${name} ${String(status)}`;
            deepStrictEqual(ours, plain, label);
            deepStrictEqual(
              (ours[0] as unknown[])[0],
              "ERR_HTTP_INVALID_STATUS_CODE",
              label,
            );
          }
        }
      }
    });

    test("a write() or an end() of a chunk that Node.js ignores (of a destroyed response, or once it has ended without its head) neither converts nor refuses the status, as plain Node.js; an end() without a chunk of a destroyed response does", () => {
      const calls: Record<string, (response: ServerResponse) => unknown> = {
        "write()": (response) => {
          response.destroy();
          return response.write("abc", () => {
            // Called back with the error of the destroyed response
          });
        },
        "end() of a chunk": (response) => {
          response.destroy();
          return response.end("abc");
        },
        "end() once ended without a head": (response) => {
          response.destroy();
          response.end("abc");
          return response.end();
        },
        "end()": (response) => {
          response.destroy();
          return response.end();
        },
        // Committed: the status is stored before the reason is refused
        "end(callback) refused by its reason phrase": (response) => {
          response.destroy();
          response.statusMessage = "bad\r\nx: y";
          return response.end(() => {
            // Never called by a refused head
          });
        },
      };
      for (const [name, call] of Object.entries(calls)) {
        for (const kind of ["object", "1000"]) {
          const [ours, plain] = [true, false].map((binden) => {
            let conversions = 0;
            const response = responseOf(binden);
            response.statusCode =
              kind === "object"
                ? (unconverted.object(() => {
                    conversions += 1;
                  }) as never)
                : 1000;
            const thrown = thrownBy(() => call(response));
            return [
              thrown,
              typeof response.statusCode,
              response.headersSent,
              conversions,
            ];
          });
          deepStrictEqual(ours, plain, `${name} ${kind}`);
          deepStrictEqual(
            ours[3],
            kind === "object" &&
              ["end()", "end(callback) refused by its reason phrase"].includes(
                name,
              )
              ? 1
              : 0,
            `${name} ${kind}`,
          );
        }
      }
    });

    test("a status given to writeHead() is converted by the call alone: a refused call leaves the status of the response as it was", () => {
      let conversions = 0;
      const response = responseOf(true);
      const status = {
        [Symbol.toPrimitive](): number {
          conversions += 1;
          return 201;
        },
      };
      deepStrictEqual(
        thrownBy(() => response.writeHead(status as never, "bad\r\nx: y")),
        ["ERR_INVALID_CHAR", "Invalid character in statusMessage"],
      );
      deepStrictEqual([response.statusCode, conversions], [200, 1]);
      response.writeHead(status as never, "Created");
      deepStrictEqual(
        [response.statusCode, response.headersSent, conversions],
        [201, true, 2],
      );
    });
  },
);
