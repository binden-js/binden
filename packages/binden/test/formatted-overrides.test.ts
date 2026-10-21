import {
  BindenResponse,
  kListen,
  kRestoreFraming,
  kValidateHead,
  validateResponseOptions,
} from "../index.js";
import { IncomingMessage, ServerResponse } from "node:http";
import { deepStrictEqual, ok } from "node:assert/strict";
import { kFramework, kRevoke } from "../src/seal.js";
import { suite, test } from "node:test";
import { Readable } from "node:stream";
import { Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** An error of the application's own (e.g. of a getter, or of a trap) */
class OwnError extends Error {}

/** What a call has thrown (or rejected with), and whether it was formatted then */
interface IOutcome {
  readonly thrown: unknown;
  readonly formatted: boolean;
}

/**
 * Runs a call while `Error.prepareStackTrace` records each error whose stack
 * V8 formats: what it throws (or its promise rejects with), and whether that
 * was formatted before the caller got it (`null` when it does not fail)
 */
async function outcome(run: () => unknown): Promise<IOutcome | null> {
  const formatted = new WeakSet<object>();
  const previous: unknown = Reflect.get(Error, "prepareStackTrace");
  Reflect.set(Error, "prepareStackTrace", (error: Error): string => {
    formatted.add(error);
    return `${error.name}: ${error.message}`;
  });
  try {
    await run();
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

/** A response to an HTTP/1.1 request, without a connection */
function detached(): BindenResponse {
  const request = new IncomingMessage(new Socket());
  request.httpVersionMajor = 1;
  request.httpVersionMinor = 1;
  return new BindenResponse(request);
}

/** A revoked proxy */
function revoked(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

/** A proxy whose every trap throws `error` */
function throwing(error: Error): object {
  const trap = (): never => {
    throw error;
  };
  return new Proxy(
    {},
    {
      get: trap,
      getOwnPropertyDescriptor: trap,
      getPrototypeOf: trap,
      has: trap,
      ownKeys: trap,
    },
  );
}

/** A function that does nothing */
function noop(): void {
  // Nothing
}

/** The calls whose errors (of Node.js or of V8) binden must format */
const failures: [string, (response: BindenResponse) => unknown][] = [
  [
    "rawListeners()",
    (r): unknown => r.rawListeners(Object.create(null) as never),
  ],
  ["emit()", (r): unknown => r.emit(Object.create(null) as never)],
  [
    "on() of a listener that is not one",
    (r): unknown => r.on("x", null as never),
  ],
  ["once() of an event name", (r): unknown => r.once(revoked() as never, noop)],
  ["addListener()", (r): unknown => r.addListener("x", Symbol("s") as never)],
  ["prependListener()", (r): unknown => r.prependListener("x", {} as never)],
  [
    "prependOnceListener()",
    (r): unknown => r.prependOnceListener("x", 1 as never),
  ],
  ["writeHead()", (r): unknown => r.writeHead(Symbol("s") as never)],
  [
    "writeHead() of headers",
    (r): unknown => r.writeHead(200, revoked() as never),
  ],
  [
    "writeHeader()",
    (r): unknown => r.writeHeader(Object.create(null) as never),
  ],
  ["write()", (r): unknown => r.write(null)],
  ["end()", (r): unknown => r.end({})],
  ["setHeader()", (r): unknown => r.setHeader("x-a", Symbol("s") as never)],
  ["getHeader()", (r): unknown => r.getHeader(null as never)],
  ["appendHeader()", (r): unknown => r.appendHeader("x a", "b")],
  ["setHeaders()", (r): unknown => r.setHeaders({} as never)],
  [
    "setTimeout()",
    (r): unknown => {
      r.assignSocket(new Socket());
      return r.setTimeout("1" as never);
    },
  ],
  [
    "removeHeader()",
    (r): unknown => {
      r.removeHeader(null as never);
      return null;
    },
  ],
  [
    "addTrailers()",
    (r): unknown => {
      r.addTrailers(null as never);
      return null;
    },
  ],
  [
    "destroy()",
    (r): unknown => {
      r.assignSocket(new Socket());
      return r.destroy(revoked() as Error);
    },
  ],
  [
    "writeEarlyHints()",
    (r): unknown => {
      r.writeEarlyHints(null as never);
      return null;
    },
  ],
  [
    "[kValidateHead]()",
    (r): unknown => {
      r[kValidateHead](200, "OK", { "x a": "b" });
      return null;
    },
  ],
  [
    "[kRestoreFraming]()",
    (r): unknown => {
      r[kRestoreFraming](null as never);
      return null;
    },
  ],
  ["[kFramework]()", (r): unknown => r[kFramework](null as never)],
  ["[kRevoke]()", (r): unknown => r[kRevoke](revoked() as never, null)],
  [
    "[kListen]() of options",
    (r): unknown => r[kListen]("close", noop, null as never),
  ],
  // Rejected
  ["send()", (r): unknown => r.status(200).send(revoked() as never)],
];

suite("The methods that binden defines over those of Node.js", () => {
  test("format what Node.js or V8 throws for their arguments (round 27)", async () => {
    for (const [label, run] of failures) {
      const failed = await outcome(() => run(detached()));
      ok(failed !== null, label);
      ok(failed.thrown instanceof TypeError, label);
      ok(failed.formatted, label);
    }
  });

  test("format what the application throws through them, which is passed on as it is", async () => {
    const calls: [string, (r: BindenResponse, own: Error) => unknown][] = [
      [
        "setHeader()",
        (r, own): unknown => r.setHeader("x-a", throwing(own) as never),
      ],
      [
        "writeHead() of a cookie",
        (r, own): unknown => {
          r.cookies.add({
            toString(): string {
              throw own;
            },
          } as never);
          return r.writeHead(200);
        },
      ],
      [
        "[kRevoke]() of a failure",
        (r, own): unknown => r[kRevoke]([], throwing(own) as never),
      ],
      [
        "sendFile() of options",
        (r, own): unknown => r.sendFile(join(tmpdir(), "a"), throwing(own)),
      ],
      [
        "sendFile() of a path",
        (r, own): unknown => r.sendFile(throwing(own) as never),
      ],
    ];
    for (const [label, run] of calls) {
      // A fresh error each time: V8 formats a stack once
      const own = new OwnError("own");
      deepStrictEqual(
        await outcome(() => run(detached(), own)),
        { thrown: own, formatted: true },
        label,
      );
    }
  });

  test("format what an override of a subclass throws through flushHeaders() and writeHeader()", async () => {
    let own = new OwnError("own");
    class Subclass extends BindenResponse {
      // eslint-disable-next-line class-methods-use-this -- throws
      public override writeHead(): this {
        throw own;
      }
    }
    for (const run of [
      (response: BindenResponse): unknown => {
        response.flushHeaders();
        return null;
      },
      (response: BindenResponse): unknown => response.writeHeader(200),
    ]) {
      own = new OwnError("own");
      deepStrictEqual(
        await outcome(() =>
          run(new Subclass(new IncomingMessage(new Socket()))),
        ),
        { thrown: own, formatted: true },
      );
    }
  });

  test("format what an override of a subclass throws through send(), text() and the like", async () => {
    let own = new OwnError("own");
    class Subclass extends BindenResponse {
      public override setHeader(name: string, value: number | string): this {
        if (name === "Content-Type") {
          throw own;
        }
        return super.setHeader(name, value);
      }
    }
    for (const run of [
      (response: BindenResponse): unknown => response.send("x"),
      (response: BindenResponse): unknown => response.text("x"),
      (response: BindenResponse): unknown => response.json({}),
    ]) {
      own = new OwnError("own");
      deepStrictEqual(
        await outcome(() =>
          run(new Subclass(new IncomingMessage(new Socket()))),
        ),
        { thrown: own, formatted: true },
      );
    }
  });

  test("sendFile() reads its path and its options inside the formatting, and refuses an option of another type without converting it", async () => {
    let conversions = 0;
    const counting = {
      toString(): string {
        conversions += 1;
        return "no-cache";
      },
    };
    const file = join(tmpdir(), "a");
    for (const options of [
      { cache_control: counting },
      { validator: counting },
    ]) {
      const failed = await outcome(() =>
        detached().sendFile(file, options as never),
      );
      ok(failed?.thrown instanceof TypeError);
      ok(failed.formatted);
    }
    deepStrictEqual(conversions, 0);
    // A getter of a subclass of `URL`, and a revoked `root`
    const own = new OwnError("own");
    class Hostile extends URL {
      // eslint-disable-next-line class-methods-use-this -- throws
      public override get protocol(): string {
        throw own;
      }
    }
    deepStrictEqual(
      await outcome(() => detached().sendFile(new Hostile("file:///a"))),
      { thrown: own, formatted: true },
    );
    const failed = await outcome(() =>
      detached().sendFile("a", { root: revoked() as never }),
    );
    ok(failed?.thrown instanceof TypeError);
    ok(failed.formatted);
  });

  test("validateResponseOptions() refuses anything but an object, and formats what reading the options throws", async () => {
    for (const [given, message] of [
      [null, "`options` is not an object: null"],
      [5, "`options` is not an object: 5"],
    ] as const) {
      const failed = await outcome(() =>
        validateResponseOptions(given as never),
      );
      ok(failed?.thrown instanceof TypeError);
      deepStrictEqual(
        [failed.thrown.message, failed.formatted],
        [message, true],
      );
    }
    const own = new OwnError("own");
    deepStrictEqual(
      await outcome(() => validateResponseOptions(throwing(own) as never)),
      { thrown: own, formatted: true },
    );
    deepStrictEqual(validateResponseOptions({ etag: true }), { etag: true });
  });

  test("a Content-Length of another type, which Node.js converts as it sends the head, is no length that binden knows: never converted, nor a failure", () => {
    let conversions = 0;
    const counting = {
      toString(): string {
        conversions += 1;
        return "2";
      },
    };
    for (const value of [counting, true, [counting]]) {
      const response = detached();
      response.setHeader("Content-Length", value as never);
      // Converted by Node.js as it checks the value: not by binden
      conversions = 0;
      const sent = response.send(
        new Readable({
          read(): void {
            // Never
          },
        }),
      );
      deepStrictEqual(response.getHeader("Content-Length"), value);
      deepStrictEqual(conversions, 0);
      response.destroy();
      // Not awaited: a response without a socket is closed by its connection
      // (see the exchange), which this one has not, and an older Node.js
      // (e.g. 24.14.1) does not close it on destroy()
      sent.catch(() => null);
    }
  });

  test("its constructor formats what the constructor of Node.js throws", async () => {
    for (const given of [null, revoked()]) {
      const failed = await outcome(
        () => new BindenResponse(given as IncomingMessage),
      );
      ok(failed?.thrown instanceof TypeError);
      ok(failed.formatted);
    }
    ok(
      new BindenResponse(new IncomingMessage(new Socket())) instanceof
        ServerResponse,
    );
  });

  test("[kListen]() refuses a listener that is not a function before it adds it, and [kRevoke]() reads its arguments at once", async () => {
    const response = detached();
    const failed = await outcome(() => response[kListen]("close", 1 as never));
    ok(failed?.thrown instanceof TypeError);
    deepStrictEqual(failed.thrown.message, "The listener is not a function: 1");
    ok(failed.formatted);
    // Nothing is added: the event is emitted as without it
    deepStrictEqual(response.emit("close"), false);
    // Once, without the default
    let runs = 0;
    response[kListen](
      "custom",
      () => {
        runs += 1;
      },
      { once: false },
    );
    response.emit("custom");
    response.emit("custom");
    deepStrictEqual(runs, 2);
  });
});
