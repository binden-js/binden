import {
  type BindenResponse,
  ContentType,
  type Context,
  Middleware,
} from "binden";
import { Compression, isCompressible, skipCompression } from "../index.js";
import { IncomingMessage, ServerResponse } from "node:http";
import { deepStrictEqual, ok } from "node:assert/strict";
import { fetchRaw, serve, within } from "./helpers.js";
import { suite, test } from "node:test";
import { Readable } from "node:stream";
import { Socket } from "node:net";

/** An error of the application's own (e.g. of a getter, or of a trap) */
class OwnError extends Error {}

/** What a call has thrown (or rejected with), and whether it was formatted then */
interface IOutcome {
  readonly thrown: unknown;
  readonly formatted: boolean;
}

/**
 * Runs a call while `Error.prepareStackTrace` records each error whose stack
 * V8 formats: what it throws, and whether that was formatted before the
 * caller got it (`null` when it does not throw)
 */
function outcome(run: () => unknown): IOutcome | null {
  const formatted = new WeakSet<object>();
  const previous: unknown = Reflect.get(Error, "prepareStackTrace");
  Reflect.set(Error, "prepareStackTrace", (error: Error): string => {
    formatted.add(error);
    return `${error.name}: ${error.message}`;
  });
  try {
    run();
    return null;
  } catch (thrown: unknown) {
    return {
      thrown,
      formatted: typeof thrown === "object" && formatted.has(thrown as object),
    };
  } finally {
    Reflect.set(Error, "prepareStackTrace", previous);
  }
}

/** A revoked proxy */
function revoked(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

/** An object whose `toString()`, `valueOf()` and `@@toPrimitive` count their calls */
function counting(): { value: object; conversions(): number } {
  let conversions = 0;
  const convert = (): string => {
    conversions += 1;
    return "utf8";
  };
  return {
    value: {
      toString: convert,
      valueOf: convert,
      [Symbol.toPrimitive]: convert,
    },
    conversions: () => conversions,
  };
}

suite(
  "The entry points of the compression format what they throw (round 27)",
  () => {
    test("new Compression(): anything but an object is refused, and what reading the options or creating a compressor throws is formatted", () => {
      for (const [options, message] of [
        [null, "`options` is not an object: null"],
        [5, "`options` is not an object: 5"],
        [Symbol("s"), "`options` is not an object: (a symbol)"],
      ] as const) {
        const failed = outcome(() => new Compression(options as never));
        ok(failed?.thrown instanceof TypeError);
        deepStrictEqual(
          [failed.thrown.message, failed.formatted],
          [message, true],
        );
      }
      for (const options of [
        revoked(),
        { gzip: { level: 99 } },
        { brotli: revoked() },
      ]) {
        const failed = outcome(() => new Compression(options));
        ok(failed?.thrown instanceof Error);
        ok(failed.formatted);
      }
      for (const make of [
        (own: Error): object => ({
          get format(): string {
            throw own;
          },
        }),
        (own: Error): object => ({
          brotli: {
            get params(): object {
              throw own;
            },
          },
        }),
      ]) {
        const own = new OwnError("own");
        deepStrictEqual(
          outcome(() => new Compression(make(own) as never)),
          { thrown: own, formatted: true },
        );
      }
    });

    test("isCompressible(), skipCompression() and run() format what reading their argument throws", () => {
      for (const run of [
        (): unknown => isCompressible({} as ContentType),
        (): unknown => isCompressible(revoked() as ContentType),
        (): unknown => {
          skipCompression(revoked() as BindenResponse);
          return null;
        },
        (): unknown => {
          new Compression().run(null as unknown as Context);
          return null;
        },
      ]) {
        const failed = outcome(run);
        ok(failed?.thrown instanceof TypeError);
        ok(failed.formatted);
      }
      deepStrictEqual(
        isCompressible(new ContentType({ type: "text/plain" })),
        true,
      );
    });

    test("the methods that it installs on a response format what they throw, and describe an encoding without converting it", async () => {
      const results: unknown[] = [];
      const counter = counting();
      const served = await serve(
        { app: { timeout: 5000 } },
        new Compression({ threshold: 0 }),
        new (class extends Middleware {
          // eslint-disable-next-line class-methods-use-this -- a middleware of the test
          public run(context: Context): void {
            const { response } = context;
            for (const run of [
              (): unknown => response.write("x", Object.create(null) as never),
              (): unknown => response.write("x", counter.value as never),
              (): unknown => response.end("x", Symbol("s") as never),
              (): unknown => response.write(null),
              (): unknown => response.end({}),
              (): unknown => response.writeHead(Symbol("s") as never),
            ]) {
              const failed = outcome(run);
              results.push(
                failed?.thrown instanceof Error
                  ? [failed.thrown.message, failed.formatted]
                  : failed,
              );
            }
            response.end("done");
          }
        })(),
      );
      try {
        const { status, body } = await within(
          fetchRaw(served.url, { headers: { "accept-encoding": "gzip" } }),
        );
        deepStrictEqual([status, body], [200, "done"]);
      } finally {
        await served.close();
      }
      deepStrictEqual(results.slice(0, 3), [
        ["Unknown encoding: (an object)", true],
        ["Unknown encoding: (an object)", true],
        ["Unknown encoding: (a symbol)", true],
      ]);
      deepStrictEqual(
        results.slice(3).map((result) => (result as unknown[])[1]),
        [true, true, true],
      );
      deepStrictEqual(counter.conversions(), 0);
    });

    test("a Content-Length of another type (an element, also a hole) is refused before the decision, never converted, as binden refuses it: the work can still reply, compressed", async () => {
      const body = "Some text to compress. ".repeat(100);
      const converted = { count: 0 };
      const object = {
        toString(): string {
          converted.count += 1;
          return String(body.length);
        },
      };
      const holed = [String(body.length)];
      holed[2] = String(body.length);
      const lengths: [unknown, string | null][] = [
        [body.length, null],
        [String(body.length), null],
        [[String(body.length)], null],
        [true, "true"],
        [object, "(an object)"],
        [[object], "(an object)"],
        [holed, "undefined"],
      ];
      const outcomes: unknown[] = [];
      for (const [length, described] of lengths) {
        const served = await serve(
          {},
          new Compression({ threshold: 4096 }),
          (context: Context): void => {
            const { response } = context;
            response.setHeader("Content-Type", "text/plain");
            response.setHeader("Content-Length", length as never);
            // Converted by Node.js as it checks the value: not by binden
            converted.count = 0;
            const failed = outcome(() => response.write(body));
            const thrown = failed?.thrown as
              { code?: unknown; message?: unknown } | undefined;
            outcomes.push([
              thrown?.message ?? null,
              thrown?.code ?? null,
              failed?.formatted ?? null,
              response.headersSent,
              converted.count,
            ]);
            if (failed !== null) {
              // Nothing has been decided: the reply is
              response.removeHeader("Content-Length");
              response.write(body);
            }
            response.end();
          },
        );
        try {
          const { headers, body: received } = await fetchRaw(served.url, {
            headers: { "accept-encoding": "gzip" },
          });
          deepStrictEqual(
            [headers["content-encoding"] ?? null, received],
            [described === null ? null : "gzip", body],
          );
        } finally {
          await served.close();
        }
      }
      deepStrictEqual(
        outcomes,
        lengths.map(([, described]): unknown[] => {
          if (described === null) {
            return [null, null, null, true, 0];
          }
          return [
            `Invalid Content-Length: ${described}`,
            "ERR_HTTP_INVALID_HEADER_VALUE",
            true,
            false,
            0,
          ];
        }),
      );
    });

    test("writeHead(), and the commit of an end() that it decides, convert the status and the header values as often as plain Node.js, and read them once (R27-R3-4)", async () => {
      /** A value that counts its conversions, which converts to `converted` */
      const countingTo = (
        converted: number | string,
      ): { value: object; conversions(): number } => {
        let conversions = 0;
        const convert = (): number | string => {
          conversions += 1;
          return converted;
        };
        return {
          value: {
            toString: convert,
            valueOf: convert,
            [Symbol.toPrimitive]: convert,
          },
          conversions: () => conversions,
        };
      };
      const variants: Record<
        string,
        [(response: ServerResponse, value: object) => unknown, number | string]
      > = {
        "an invalid status": [
          (response, value): unknown => response.writeHead(value as never),
          "a",
        ],
        "a valid status": [
          (response, value): unknown => response.writeHead(value as never),
          200,
        ],
        "a value": [
          (response, value): unknown =>
            response.writeHead(200, { "x-a": value as never }),
          "a",
        ],
        "a value of pairs after a reason phrase": [
          (response, value): unknown =>
            response.writeHead(200, "OK", ["x-a", value as never]),
          "a",
        ],
        "the status of an end()": [
          (response, value): unknown => {
            response.statusCode = value as never;
            return response.end("text");
          },
          200,
        ],
      };
      const counts = new Map<string, number>();
      const served = await serve(
        {},
        new Compression({ threshold: 0 }),
        (context: Context): void => {
          const { response } = context;
          const name = decodeURIComponent(context.url.pathname.slice(1));
          const [call, converted] = variants[name] as [
            (response: ServerResponse, value: object) => unknown,
            number | string,
          ];
          const counted = countingTo(converted);
          try {
            call(response, counted.value);
          } catch {
            // Refused as Node.js refuses it
          }
          counts.set(name, counted.conversions());
          if (!response.writableEnded) {
            response.end();
          }
        },
      );
      try {
        for (const name of Object.keys(variants)) {
          await fetchRaw(served.url, {
            path: `/${encodeURIComponent(name)}`,
            headers: { "accept-encoding": "gzip" },
          });
        }
      } finally {
        await served.close();
      }
      const plain = new Map<string, number>();
      for (const [name, [call, converted]] of Object.entries(variants)) {
        const counted = countingTo(converted);
        try {
          call(
            new ServerResponse(new IncomingMessage(new Socket())),
            counted.value,
          );
        } catch {
          // Refused
        }
        plain.set(name, counted.conversions());
      }
      deepStrictEqual(Object.fromEntries(counts), Object.fromEntries(plain));
    });

    test("an implicit commit (a write(), an end(), flushHeaders(), a send) converts a statusCode that is not a number once, as plain Node.js, compressed or sent as it is, and the reply has that status (C28-2)", async () => {
      /** A status that counts its conversions, which converts to `converted` */
      const countingTo = (
        converted: number | string,
      ): { value: object; conversions(): number } => {
        let conversions = 0;
        return {
          value: {
            [Symbol.toPrimitive](): number | string {
              conversions += 1;
              return converted;
            },
          },
          conversions: () => conversions,
        };
      };
      /** Each call, for the compression, and for plain Node.js */
      const calls: Record<
        string,
        [
          (response: BindenResponse) => unknown,
          (response: ServerResponse) => unknown,
        ]
      > = {
        "write()": [
          (response): unknown => response.write("abc"),
          (response): unknown => response.write("abc"),
        ],
        "end() of a chunk": [
          (response): unknown => response.end("abc"),
          (response): unknown => response.end("abc"),
        ],
        "end()": [
          (response): unknown => response.end(),
          (response): unknown => response.end(),
        ],
        "flushHeaders()": [
          (response): void => {
            response.flushHeaders();
          },
          (response): void => {
            response.flushHeaders();
          },
        ],
        "send() of a string": [
          async (response): Promise<void> => response.send("abc"),
          (response): unknown => response.end("abc"),
        ],
        "send() of a Readable": [
          async (response): Promise<void> =>
            response.send(Readable.from(["abc"])),
          (response): unknown => response.write("abc"),
        ],
        "json()": [
          async (response): Promise<void> => response.json("abc"),
          (response): unknown => response.end(`"abc"`),
        ],
      };
      const statuses = [201, 204, "a"];
      const counted = new Map<string, () => number>();
      const served = await serve(
        {},
        new Compression({ threshold: 0 }),
        async (context: Context): Promise<void> => {
          const { response } = context;
          const [name = "", converted = ""] = decodeURIComponent(
            context.url.pathname.slice(1),
          ).split("|");
          const [call] = calls[name] as [
            (response: BindenResponse) => unknown,
            unknown,
          ];
          const status = countingTo(
            converted === "a" ? converted : Number(converted),
          );
          counted.set(context.url.pathname, () => status.conversions());
          response.statusCode = status.value as never;
          try {
            await call(response);
          } catch {
            // Refused as Node.js refuses it
            response.statusCode = 500;
          }
          if (!response.writableEnded) {
            response.end();
          }
        },
      );
      try {
        for (const [name, [, plainly]] of Object.entries(calls)) {
          for (const converted of statuses) {
            for (const coding of ["gzip", "identity"]) {
              const path = `/${encodeURIComponent(`${name}|${String(converted)}`)}`;
              const { status } = await fetchRaw(served.url, {
                path,
                headers: { "accept-encoding": coding },
              });
              const conversions = counted.get(path) as () => number;
              const plain = countingTo(converted);
              const node = new ServerResponse(
                new IncomingMessage(new Socket()),
              );
              node.statusCode = plain.value as never;
              try {
                plainly(node);
              } catch {
                // Refused
              }
              deepStrictEqual(
                conversions(),
                plain.conversions(),
                `${name} ${String(converted)} ${coding}`,
              );
              deepStrictEqual(
                status,
                converted === "a" ? 500 : converted,
                `${name} ${String(converted)} ${coding}`,
              );
            }
          }
        }
      } finally {
        await served.close();
      }
    });
  },
);
