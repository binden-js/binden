import { type Context, type IMiddleware } from "binden";
import {
  type IServed,
  fetchRaw,
  serve,
  sleep,
  text,
  within,
} from "./helpers.js";
import { afterEach, suite, test } from "node:test";
import { Compression } from "../index.js";
import { deepStrictEqual } from "node:assert/strict";
// The owners of the works (internal to binden), which the callbacks keep
import { owners } from "../../binden/dist/src/seal.js";

const gzip = { "Accept-Encoding": "gzip" };

/** A callback as it has been called: its name, owner, receiver and arguments */
type ICall = [string, string, string, unknown[]];

/** What a callback has been called with, as the tests compare it */
function describe(value: unknown): unknown {
  return value instanceof Error
    ? (value as { code?: unknown }).code
    : value === null
      ? null
      : typeof value;
}

/**
 * Records the calls of the callbacks of a work: by the owner of the work
 * that calls them (`stack`, or `none` for a work of no request), and by
 * their receiver (`response`, the list of the end callbacks of Node.js 26,
 * `none`, or the buffered write of the socket that Node.js 24 calls the
 * callback of a write with)
 */
function recorder(
  calls: ICall[],
  response: object,
): (name: string) => () => void {
  const stack = owners.getStore();
  return (name: string) =>
    function recorded(this: unknown, ...args: unknown[]): void {
      const owner = owners.getStore();
      calls.push([
        name,
        owner === stack ? "stack" : typeof owner === "undefined" ? "none" : "?",
        this === response
          ? "response"
          : Array.isArray(this)
            ? "list"
            : typeof this === "undefined"
              ? "none"
              : "request",
        args.map(describe),
      ]);
    };
}

/** Resolves once `count` callbacks have been called (rejects after 5 s) */
async function calledBack(
  calls: readonly ICall[],
  count: number,
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (calls.length < count) {
    if (Date.now() > deadline) {
      throw new Error(`${calls.length} of ${count} callbacks called`);
    }
    await sleep(5);
  }
}

/** The calls in the order of their names (their order differs by path) */
function sorted(calls: readonly ICall[]): ICall[] {
  return calls.toSorted(([a], [b]) => a.localeCompare(b));
}

/**
 * The replies of the tests: how they write their body, with callbacks of
 * the work and of works of no request (`owners.exit()`), which may write
 * before the response is sealed
 */
const replies: Record<
  string,
  (
    response: Context["response"],
    record: (name: string) => () => void,
  ) => Promise<void> | void
> = {
  "write() decides": (response, record) => {
    response.write(text(64), record("write"));
    owners.exit(() => response.write(text(64), "utf8", record("write none")));
    response.end(text(64), record("end"));
    owners.exit(() => response.end(record("end none")));
  },
  "end() decides": (response, record) => {
    response.end(text(64), "utf8", record("end"));
    owners.exit(() => response.end(record("end none")));
  },
  "writeHead() decides": (response, record) => {
    response.writeHead(200);
    owners.exit(() => response.write(text(64), record("write none")));
    response.end(record("end"));
  },
  "end() once the body has been sent": async (response, record) => {
    response.write(text(64), record("write"));
    await response.flush();
    await sleep(20);
    response.end(text(64), record("end"));
  },
};

/** The calls that each reply makes */
const counts: Record<string, number> = {
  "write() decides": 4,
  "end() decides": 2,
  "writeHead() decides": 2,
  "end() once the body has been sent": 2,
};

suite("The callbacks of `write()` and `end()`", () => {
  const servers: IServed[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (served) => served.close()));
  });

  /** The calls of the callbacks of a reply, with or without the compression */
  const callsOf = async (
    reply: string,
    compression: boolean,
    accept: string,
  ): Promise<{ status: number; calls: ICall[] }> => {
    const calls: ICall[] = [];
    const middlewares: IMiddleware[] = compression
      ? [new Compression({ format: "gzip", threshold: 0 })]
      : [];
    const served = await serve({}, ...middlewares, async (context: Context) => {
      const { response } = context;
      context.done = true;
      response.type("text/plain");
      await replies[reply](response, recorder(calls, response));
    });
    servers.push(served);
    const { status } = await fetchRaw(served.url, {
      headers: { "Accept-Encoding": accept },
    });
    await calledBack(calls, counts[reply]);
    // None runs twice
    await sleep(30);
    return { status, calls: sorted(calls) };
  };

  test("run once, as the work that has called them, with the receiver and the arguments of Node.js", async () => {
    for (const reply of Object.keys(replies)) {
      const plain = await callsOf(reply, false, "gzip");
      // As binden calls them: by their owner, with the receivers of the
      // version of Node.js
      deepStrictEqual(
        plain.calls.map(([name, owner]) => [name, owner]),
        plain.calls.map(([name]) => [
          name,
          name.endsWith(" none") ? "none" : "stack",
        ]),
        reply,
      );
      // The compressor (and the replacement) calls the callback of a write
      // as the callback of a stream: Node.js 24 calls those of the socket
      // with the write that it has buffered
      const written = plain.calls.map(
        ([name, owner, receiver, args]): ICall => [
          name,
          owner,
          name.startsWith("write") ? "none" : receiver,
          args,
        ],
      );
      for (const [accept, status, expected] of [
        ["identity", 200, plain.calls],
        ["gzip", 200, written],
        ["identity;q=0", 406, written],
      ] as const) {
        deepStrictEqual(
          await callsOf(reply, true, accept),
          { status, calls: expected },
          `${reply}: ${accept}`,
        );
      }
    }
  });

  test("of `end()` run once with an error when the compressed response is destroyed before its end", async () => {
    for (const reason of [null, "ECONNRESET"]) {
      const calls: ICall[] = [];
      const states: unknown[] = [];
      const served = await serve(
        {},
        new Compression({ format: "gzip", threshold: 0 }),
        (context: Context) => {
          const { response } = context;
          context.done = true;
          const record = recorder(calls, response);
          response.type("text/plain");
          response.write(text(64));
          response.end(text(64), record("end"));
          owners.exit(() => response.end(record("end none")));
          // Before the compressor has ended (e.g. the client has gone away)
          response.destroy(
            ...(reason === null
              ? []
              : [Object.assign(new Error("gone"), { code: reason })]),
          );
          states.push(response.writableEnded, response.writableFinished);
        },
      );
      servers.push(served);
      await fetchRaw(served.url, { headers: gzip }).catch(() => null);
      await calledBack(calls, 2);
      await sleep(30);

      // The error of the response, if any
      const code = reason ?? "ERR_STREAM_DESTROYED";
      deepStrictEqual(states, [true, false]);
      deepStrictEqual(sorted(calls), [
        ["end", "stack", "none", [code]],
        ["end none", "none", "none", [code]],
      ]);
    }
  });

  test("of an `end()` after a destroyed compressed response are left to Node.js", async () => {
    const calls: ICall[] = [];
    const { promise: closed, resolve } = Promise.withResolvers<null>();
    const served = await serve(
      {},
      new Compression({ format: "gzip", threshold: 0 }),
      (context: Context) => {
        const { response } = context;
        context.done = true;
        response.type("text/plain");
        response.write(text(64));
        response.once("close", () => {
          response.end(text(64), recorder(calls, response)("end"));
          resolve(null);
        });
        response.destroy();
      },
    );
    servers.push(served);
    await fetchRaw(served.url, { headers: gzip }).catch(() => null);
    await within(closed);
    await sleep(50);

    // As for an `end()` of a response that has been destroyed
    deepStrictEqual(calls, []);
  });
});
