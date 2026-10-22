import { type BindenResponse, type Context } from "binden";
import { type IServed, converse, serve } from "./helpers.js";
import { type ServerResponse, createServer } from "node:http";
import { deepStrictEqual, ok } from "node:assert/strict";
import { suite, test } from "node:test";
import type { AddressInfo } from "node:net";
import { Compression } from "../index.js";
import { Readable } from "node:stream";
import { join } from "node:path";
import { once } from "node:events";

/** A file that `sendFile()` sends */
const file = join(import.meta.dirname, "..", "package.json");

/** Replies a request to a path (of an `IServers`) */
type IHandler = (response: ServerResponse, path: string) => unknown;

/** The servers of a handler, by name, which `close()` closes */
interface IServers {
  readonly urls: Readonly<Record<"plain" | "binden" | "gzip", string>>;
  close(): Promise<void>;
}

/**
 * Serves a handler by plain Node.js (`plain`), by binden alone (`binden`), and
 * by binden with a compression that compresses any body with `gzip` (`gzip`)
 */
async function servers(handler: IHandler): Promise<IServers> {
  const middleware = async (context: Context): Promise<void> => {
    await handler(context.response, context.url.pathname);
  };
  const plain = createServer((request, response) => {
    Promise.resolve(handler(response, request.url ?? "/")).catch(() => null);
  });
  plain.listen(0, "127.0.0.1");
  await once(plain, "listening");
  const served: IServed[] = [
    await serve({}, middleware),
    await serve(
      {},
      new Compression({
        threshold: 0,
        format: "gzip",
        filter: (): boolean => true,
      }),
      middleware,
    ),
  ];
  const [binden, gzip] = served as [IServed, IServed];
  const { port } = plain.address() as AddressInfo;
  return {
    urls: {
      plain: `http://127.0.0.1:${String(port)}`,
      binden: binden.url,
      gzip: gzip.url,
    },
    close: async (): Promise<void> => {
      plain.closeAllConnections();
      plain.close();
      await Promise.all([
        once(plain, "close"),
        ...served.map(async (each) => each.close()),
      ]);
    },
  };
}

/** The status lines of the responses to the requests of `text`, as received */
async function statusLines(url: string, text: string): Promise<string[]> {
  return (await converse(url, text)).map(({ head }) => head.split("\r\n")[0]);
}

/** A request for a path, accepting `gzip`, after which the connection closes */
function closing(path: string, coding = "gzip"): string {
  return `GET ${path} HTTP/1.1\r\nHost: localhost\r\nAccept-Encoding: ${coding}\r\nConnection: close\r\n\r\n`;
}

/** A status that counts its conversions, which converts to `converted` */
function counting(converted: number): { value: object; conversions(): number } {
  let conversions = 0;
  return {
    value: {
      [Symbol.toPrimitive](): number {
        conversions += 1;
        return converted;
      },
    },
    conversions: () => conversions,
  };
}

/** The code of what a call throws (`null` when it does not) */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
    return null;
  } catch (error: unknown) {
    return (error as { code?: unknown }).code;
  }
}

suite(
  "The compression decides by the status as binden converts it, once, never as it is (H29-1, H29-2)",
  () => {
    test("a chunk in an unknown encoding of an object or a string 204 or 304 status is ignored, as by plain Node.js and binden alone, and a 200 refuses it: the status is converted as often", async () => {
      const calls: Record<string, (response: ServerResponse) => unknown> = {
        write: (response) => response.write("abc", "bogus" as never),
        end: (response) => response.end("abc", "bogus" as never),
      };
      const outcomes = new Map<string, unknown[]>();
      const handled = await servers((response, path) => {
        const [server = "", call = "", kind = "", code = ""] = path
          .slice(1)
          .split("-");
        const status = counting(Number(code));
        response.statusCode = (
          kind === "object" ? status.value : code
        ) as never;
        const thrown = thrownBy(() => (calls[call] as IHandler)(response, ""));
        outcomes.set(`${server}-${call}-${kind}-${code}`, [
          thrown,
          status.conversions(),
          typeof response.statusCode,
        ]);
        if (!response.headersSent) {
          response.statusCode = thrown === null ? response.statusCode : 500;
        }
        response.end();
      });
      const lines = new Map<string, unknown>();
      try {
        for (const [server, url] of Object.entries(handled.urls)) {
          for (const call of Object.keys(calls)) {
            for (const kind of ["object", "string"]) {
              for (const code of ["200", "204", "304"]) {
                const path = `/${server}-${call}-${kind}-${code}`;
                lines.set(path, await statusLines(url, closing(path)));
              }
            }
          }
        }
      } finally {
        await handled.close();
      }
      for (const call of Object.keys(calls)) {
        for (const kind of ["object", "string"]) {
          for (const code of ["200", "204", "304"]) {
            const name = `${call}-${kind}-${code}`;
            const gzip = outcomes.get(`gzip-${name}`);
            deepStrictEqual(gzip, outcomes.get(`plain-${name}`), name);
            deepStrictEqual(gzip, outcomes.get(`binden-${name}`), name);
            deepStrictEqual(
              gzip,
              [
                code === "200" ? "ERR_UNKNOWN_ENCODING" : null,
                kind === "object" ? 1 : 0,
                "number",
              ],
              name,
            );
            // binden refuses the encoding before it commits the head
            deepStrictEqual(
              lines.get(`/gzip-${name}`),
              lines.get(`/binden-${name}`),
              name,
            );
          }
        }
      }
    });

    test("the encoding is refused before the reason phrase or a Content-Length that the commit refuses, as by binden alone", async () => {
      const outcomes = new Map<string, unknown[]>();
      const handled = await servers((response, path) => {
        const [server = "", call = "", refused = ""] = path.slice(1).split("-");
        const status = counting(200);
        response.statusCode = status.value as never;
        if (refused === "reason") {
          response.statusMessage = "bad\r\nx: y";
        } else {
          response.setHeader("Content-Length", ["1", "2"]);
        }
        const thrown = thrownBy(() => {
          if (call === "write") {
            response.write("abc", "bogus" as never);
          } else {
            response.end("abc", "bogus" as never);
          }
        });
        outcomes.set(`${server}-${call}-${refused}`, [
          thrown,
          status.conversions(),
        ]);
        response.statusMessage = "";
        response.removeHeader("Content-Length");
        response.statusCode = 500;
        response.end();
      });
      try {
        for (const server of ["binden", "gzip"] as const) {
          for (const call of ["write", "end"]) {
            for (const refused of ["reason", "length"]) {
              const path = `/${server}-${call}-${refused}`;
              deepStrictEqual(
                await statusLines(handled.urls[server], closing(path)),
                ["http/1.1 500 internal server error"],
                path,
              );
            }
          }
        }
      } finally {
        await handled.close();
      }
      for (const call of ["write", "end"]) {
        for (const refused of ["reason", "length"]) {
          const name = `${call}-${refused}`;
          deepStrictEqual(
            outcomes.get(`gzip-${name}`),
            outcomes.get(`binden-${name}`),
            name,
          );
          deepStrictEqual(
            outcomes.get(`gzip-${name}`),
            ["ERR_UNKNOWN_ENCODING", 1],
            name,
          );
        }
      }
    });

    test("a head refused by its reason phrase stores the status, converted once: another attempt does not convert it again, as plain Node.js (compressed or sent as it is)", async () => {
      const calls: Record<string, (response: ServerResponse) => unknown> = {
        write: (response) => response.write("abc"),
        end: (response) => response.end("abc"),
        flushHeaders: (response) => {
          response.flushHeaders();
        },
      };
      const outcomes = new Map<string, unknown[]>();
      const handled = await servers((response, path) => {
        const [name = "", call = ""] = path.slice(1).split("-");
        const status = counting(201);
        response.statusCode = status.value as never;
        response.statusMessage = "bad\r\nx: y";
        const run = calls[call] as IHandler;
        const first = thrownBy(() => run(response, ""));
        const stored = typeof response.statusCode;
        response.statusMessage = "Created";
        const retry = thrownBy(() => run(response, ""));
        outcomes.set(name, [first, stored, retry, status.conversions()]);
        response.end();
      });
      try {
        for (const [server, url] of Object.entries(handled.urls)) {
          for (const coding of ["gzip", "identity"]) {
            for (const call of Object.keys(calls)) {
              const name = `${server}|${coding}|${call}`;
              deepStrictEqual(
                await statusLines(
                  url,
                  closing(`/${encodeURIComponent(name)}-${call}`, coding),
                ),
                ["http/1.1 201 created"],
                name,
              );
              deepStrictEqual(
                outcomes.get(encodeURIComponent(name)),
                ["ERR_INVALID_CHAR", "number", null, 1],
                name,
              );
            }
          }
        }
      } finally {
        await handled.close();
      }
    });

    test("a statusCode that is a number but not an integer is the integer that Node.js commits: framed as that integer, and the pipelined request that follows is answered", async () => {
      const replies: Record<string, (response: BindenResponse) => unknown> = {
        send: async (response) => response.send("hello"),
        stream: async (response) => response.send(Readable.from(["hello"])),
        file: async (response) => response.sendFile(file),
        end: (response) => response.end("hello"),
        // Ignored without a body, also in an unknown encoding
        write: (response) => {
          response.write("hello", "bogus" as never);
          response.end();
        },
      };
      const served = await serve(
        {},
        new Compression({
          threshold: 0,
          format: "gzip",
          filter: (): boolean => true,
        }),
        async (context: Context): Promise<void> => {
          const [name = "", status = ""] = context.url.pathname
            .slice(1)
            .split("-");
          if (name === "next") {
            await context.send("next");
            return;
          }
          context.response.statusCode = Number(status);
          await replies[name](context.response);
        },
      );
      /** What the client receives for a reply, and the request after it */
      const received = async (path: string): Promise<string> => {
        const responses = await converse(
          served.url,
          `GET ${path} HTTP/1.1\r\nHost: localhost\r\nAccept-Encoding: gzip\r\n\r\n${closing("/next", "identity")}`,
        );
        return responses
          .map(({ head, body }) =>
            [head.replaceAll(/\r\ndate: [^\r]*/gu, ""), body.toString()].join(
              "\r\n\r\n",
            ),
          )
          .join("|");
      };
      try {
        for (const name of Object.keys(replies)) {
          for (const [given, integer] of [
            [204.5, 204],
            [205.5, 205],
            [304.5, 304],
            [200.5, 200],
            [2 ** 32 + 204, 204],
          ] as const) {
            const expected = await received(`/${name}-${String(integer)}`);
            ok(expected.endsWith("\r\n\r\nnext"), `${name} ${String(integer)}`);
            deepStrictEqual(
              await received(`/${name}-${String(given)}`),
              expected,
              `${name} ${String(given)}`,
            );
          }
        }
      } finally {
        await served.close();
      }
    });

    test("a status assigned while sendFile() opens its file is converted once, by the decision, which decides by it as binden alone", async () => {
      const conversions = new Map<string, number>();
      const handled = await servers(async (response, path) => {
        const status = counting(204);
        const sent = (response as BindenResponse).sendFile(file);
        response.statusCode = status.value as never;
        await sent;
        conversions.set(path, status.conversions());
      });
      try {
        const replies = await Promise.all(
          (["binden", "gzip"] as const).map(async (server) =>
            (await converse(handled.urls[server], closing(`/${server}`))).map(
              ({ head, body }) => [
                head.replaceAll(/\r\ndate: [^\r]*/gu, ""),
                body.length,
              ],
            ),
          ),
        );
        deepStrictEqual(replies[1], replies[0]);
        ok(String(replies[0]?.[0]?.[0]).startsWith("http/1.1 204 "));
      } finally {
        await handled.close();
      }
      deepStrictEqual(Object.fromEntries(conversions), {
        "/binden": 1,
        "/gzip": 1,
      });
    });
  },
);
