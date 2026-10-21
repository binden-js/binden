import { BindenResponse, kValidateHead } from "../index.js";
import { IncomingMessage, ServerResponse } from "node:http";
import { deepStrictEqual, ok } from "node:assert/strict";
import { suite, test } from "node:test";
import { Socket } from "node:net";
import { kSeal } from "../src/seal.js";

/** A value that counts its conversions, which converts to `converted` */
interface ICounting {
  readonly value: object;
  conversions(): number;
}

/** A value whose `toString()`, `valueOf()` and `@@toPrimitive` count their calls */
function counting(converted: number | string): ICounting {
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
}

/** A response of binden, or of plain Node.js, to an HTTP/1.1 request without a connection */
function responseOf(binden: boolean): ServerResponse {
  const request = new IncomingMessage(new Socket());
  request.httpVersionMajor = 1;
  request.httpVersionMinor = 1;
  return binden ? new BindenResponse(request) : new ServerResponse(request);
}

/** What a call has done to a response: what it threw, or the head that it has committed (without its `Date`) */
function outcome(response: ServerResponse, run: () => unknown): unknown {
  try {
    run();
  } catch (error: unknown) {
    const { code, message } = error as { code?: unknown; message: string };
    return [(error as Error).constructor.name, code, message];
  }
  return String(Reflect.get(response, "_header")).replaceAll(
    /Date: [^\r]*\r\n/gu,
    "",
  );
}

/** The calls of `writeHead()` with a counting value, as an argument or a header value */
const calls: Record<
  string,
  [(response: ServerResponse, value: object) => unknown, number | string]
> = {
  "an invalid status": [
    (response, value): unknown => response.writeHead(value as never),
    "a",
  ],
  "a valid status": [
    (response, value): unknown => response.writeHead(value as never),
    201,
  ],
  "a value of an object": [
    (response, value): unknown =>
      response.writeHead(200, { "x-a": value as never }),
    "a",
  ],
  "a value of an object after a reason phrase": [
    (response, value): unknown =>
      response.writeHead(200, "OK", { "x-a": value as never }),
    "a",
  ],
  "a value of flat pairs": [
    (response, value): unknown =>
      response.writeHead(200, ["x-a", value as never]),
    "a",
  ],
  "a value of nested pairs": [
    (response, value): unknown =>
      response.writeHead(200, [["x-a", value]] as never),
    "a",
  ],
  "an element of the values of a header": [
    (response, value): unknown =>
      response.writeHead(200, { "x-a": [value] as never }),
    "a",
  ],
  "an invalid value": [
    (response, value): unknown =>
      response.writeHead(200, { "x-a": value as never }),
    "a\n",
  ],
  "a name of flat pairs": [
    (response, value): unknown =>
      response.writeHead(200, [value as never, "b"]),
    "x-a",
  ],
};

suite(
  "writeHead() reads what it checks once, and gives it to Node.js (R27-R3-4)",
  () => {
    test("converts the status and the values (and the names) of the headers as often as plain Node.js, with the same outcome, also once headers have been set", () => {
      for (const [name, [call, converted]] of Object.entries(calls)) {
        for (const set of [false, true]) {
          const counts: number[] = [];
          const outcomes: unknown[] = [];
          for (const binden of [false, true]) {
            const response = responseOf(binden);
            if (set) {
              response.setHeader("x-b", "c");
            }
            const value = counting(converted);
            outcomes.push(outcome(response, () => call(response, value.value)));
            counts.push(value.conversions());
          }
          const [node, ours] = counts as [number, number];
          deepStrictEqual(ours, node, `${name} (set: ${String(set)})`);
          deepStrictEqual(
            outcomes[1],
            outcomes[0],
            `${name} (set: ${String(set)})`,
          );
        }
      }
    });

    test("reads each value once: Node.js gets exactly the values that binden has checked (a getter that changes them, a proxy of the headers)", () => {
      let reads = 0;
      const changing = {
        get "x-a"(): string {
          reads += 1;
          return reads === 1 ? "first" : "bad\n";
        },
      };
      const response = responseOf(true);
      response.writeHead(200, changing);
      ok(
        String(Reflect.get(response, "_header")).includes("x-a: first\r\n"),
        "the value checked",
      );
      deepStrictEqual(reads, 1);
      // A value that is invalid when it is checked: refused, read once
      reads = 1;
      const refusing = responseOf(true);
      const failed = outcome(refusing, () => refusing.writeHead(200, changing));
      deepStrictEqual(
        [failed, reads, refusing.headersSent],
        [
          [
            "TypeError",
            "ERR_INVALID_CHAR",
            'Invalid character in header content ["x-a"]',
          ],
          2,
          false,
        ],
      );
      // The indexes of an array (also of its pairs) read once each
      const indexes = new Map<string, number>();
      const counted = <T extends object>(target: T, path: string): T =>
        new Proxy(target, {
          get(object: T, key: PropertyKey): unknown {
            if (typeof key === "string" && /^\d+$/u.test(key)) {
              const at = `${path}.${key}`;
              indexes.set(at, (indexes.get(at) ?? 0) + 1);
            }
            return Reflect.get(object, key);
          },
        });
      for (const given of [
        counted(["x-a", "b", "x-c", "d"], "flat"),
        counted([counted(["x-a", "b"], "pair")], "nested"),
        { "x-a": counted(["b", "c"], "values") },
      ]) {
        responseOf(true).writeHead(200, given as never);
      }
      deepStrictEqual(Object.fromEntries(indexes), {
        "flat.0": 1,
        "flat.1": 1,
        "flat.2": 1,
        "flat.3": 1,
        "nested.0": 1,
        "pair.0": 1,
        "pair.1": 1,
        "values.0": 1,
        "values.1": 1,
      });
    });

    test("converts the status once, and Node.js gets that number; refuses it as Node.js does, by the value given, before anything is read", () => {
      let conversions = 0;
      const changing = {
        valueOf(): number {
          conversions += 1;
          return conversions === 1 ? 202 : 99;
        },
      };
      const response = responseOf(true);
      response.writeHead(changing as never);
      deepStrictEqual(
        [response.statusCode, response.headersSent, conversions],
        [202, true, 1],
      );
      for (const status of ["abc", 99, 1000, 1.5e9]) {
        let read = false;
        const headers = {
          get "x-a"(): string {
            read = true;
            return "b";
          },
        };
        const [node, ours] = [false, true].map((binden) => {
          const refusing = responseOf(binden);
          return outcome(refusing, () =>
            refusing.writeHead(status as never, headers),
          );
        });
        deepStrictEqual(ours, node, String(status));
        ok(Array.isArray(ours) && ours[1] === "ERR_HTTP_INVALID_STATUS_CODE");
        deepStrictEqual(read, false);
      }
    });

    test("[kValidateHead]() throws ERR_HTTP_HEADERS_SENT once the head is committed, as writeHead() of Node.js, reading and converting nothing", () => {
      const response = responseOf(true) as BindenResponse;
      response.writeHead(200);
      const status = counting(200);
      let read = false;
      const headers = {
        get "x-a"(): string {
          read = true;
          return "b";
        },
      };
      deepStrictEqual(
        outcome(response, () =>
          response[kValidateHead](status.value, "OK", headers),
        ),
        [
          "Error",
          "ERR_HTTP_HEADERS_SENT",
          "Cannot write headers after they are sent to the client",
        ],
      );
      deepStrictEqual([status.conversions(), read], [0, false]);
      // As it returns them before: the status converted, the copies
      const fresh = responseOf(true) as BindenResponse;
      const [code, reason, given] = fresh[kValidateHead](status.value, {
        "x-a": ["b"],
      });
      deepStrictEqual([code, reason, given], [200, null, { "x-a": ["b"] }]);
    });
  },
);

suite(
  "writeEarlyHints(), addTrailers() and cookies.add() read their argument once (R27-R3)",
  () => {
    test("writeEarlyHints() reads the link and each other hint once, and Node.js gets the copy; without a link, nothing else is read", () => {
      let links = 0;
      const hints = {
        get link(): string {
          links += 1;
          return links === 1 ? "</a.css>; rel=preload" : "bad\n";
        },
        "x-a": "b",
      };
      const informing = responseOf(true);
      informing.writeEarlyHints(hints);
      const queued = (
        Reflect.get(informing, "outputData") as { data: unknown }[]
      )
        .map(({ data }) => String(data))
        .join("");
      ok(queued.includes("Link: </a.css>; rel=preload\r\n"), queued);
      ok(queued.includes("x-a: b\r\n"), queued);
      deepStrictEqual(links, 1);
      let read = false;
      const none = responseOf(true);
      none.writeEarlyHints({
        link: null,
        get "x-a"(): string {
          read = true;
          return "b";
        },
      } as never);
      deepStrictEqual(
        [read, (Reflect.get(none, "outputData") as unknown[]).length],
        [false, 0],
      );
    });

    test("addTrailers() reads each pair (by its name and its value) and each trailer once, and Node.js gets the copy", () => {
      const reads = new Map<string, number>();
      const counted = <T extends object>(target: T, path: string): T =>
        new Proxy(target, {
          get(object: T, key: PropertyKey): unknown {
            if (typeof key === "string" && /^\d+$/u.test(key)) {
              const at = `${path}.${key}`;
              reads.set(at, (reads.get(at) ?? 0) + 1);
            }
            return Reflect.get(object, key);
          },
        });
      const pairs = responseOf(true);
      pairs.addTrailers(
        counted(
          [counted(["x-t", "v"], "pair"), ["x-u", ["1", "2"]]],
          "pairs",
        ) as never,
      );
      deepStrictEqual(
        [Reflect.get(pairs, "_trailer"), Object.fromEntries(reads)],
        [
          "x-t: v\r\nx-u: 1\r\nx-u: 2\r\n",
          { "pairs.0": 1, "pairs.1": 1, "pair.0": 1, "pair.1": 1 },
        ],
      );
      let values = 0;
      const object = responseOf(true);
      object.addTrailers({
        get "x-t"(): string {
          values += 1;
          return values === 1 ? "v" : "bad\n";
        },
      });
      deepStrictEqual(
        [Reflect.get(object, "_trailer"), values],
        ["x-t: v\r\n", 1],
      );
    });

    test("cookies.add() refuses anything but an object (a Cookie, or one whose toString() gives its Set-Cookie), described and formatted, before it adds it; a sealed response ignores it", () => {
      const formatted = new WeakSet<object>();
      const previous: unknown = Reflect.get(Error, "prepareStackTrace");
      Reflect.set(Error, "prepareStackTrace", (error: Error): string => {
        formatted.add(error);
        return `${error.name}: ${error.message}`;
      });
      const response = responseOf(true) as BindenResponse;
      try {
        for (const [given, described] of [
          [null, "null"],
          [Reflect.get({}, "absent"), "undefined"],
          ["a=b", "a=b"],
          [Symbol("s"), "(a symbol)"],
          [5, "5"],
          [(): string => "a=b", "(a function)"],
        ] as const) {
          let thrown: unknown = null;
          try {
            response.cookies.add(given as never);
          } catch (error: unknown) {
            thrown = error;
          }
          ok(thrown instanceof TypeError, described);
          deepStrictEqual(
            [thrown.message, formatted.has(thrown)],
            [`\`cookie\` is not an object: ${described}`, true],
          );
        }
      } finally {
        Reflect.set(Error, "prepareStackTrace", previous);
      }
      deepStrictEqual(response.cookies.size, 0);
      const own = { toString: (): string => "a=b" };
      response.cookies.add(own as never);
      deepStrictEqual([...response.cookies], [own]);
      response.writeHead(200);
      ok(
        String(Reflect.get(response, "_header")).includes(
          "Set-Cookie: a=b\r\n",
        ),
      );
      // Ignored once sealed: nothing is read nor refused
      const sealed = responseOf(true) as BindenResponse;
      sealed[kSeal]();
      sealed.cookies.add(null as never);
      deepStrictEqual(sealed.cookies.size, 0);
    });
  },
);
