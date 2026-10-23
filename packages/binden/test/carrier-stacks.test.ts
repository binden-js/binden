import { carrierOf, readsSafely } from "../src/exchange.js";
import { emitterMethods, guard } from "../src/stream-like.js";
import { suite, test } from "node:test";
import { EventEmitter } from "node:events";
import { deepStrictEqual } from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** The ways of `fixtures/carrier-stacks.ts` */
const ways = [
  "emit",
  "pause",
  "resume",
  "node-pause",
  "rs4",
  "rs3",
  "redefine",
] as const;

/**
 * What the fixture prints for each way: the response is replied (`500`, of
 * the error that the work throws once the send has rejected) unless its
 * headers are committed (cut), and the source is destroyed once: with its
 * carrier, without an error once it has emitted its value (`emit`), or by the
 * application itself (`rs4`, `rs3`); the `_destroy()` of `redefine` cannot
 * redefine the `stack` of the carrier
 */
const expected: Readonly<Record<(typeof ways)[number], string>> = {
  emit: "replied rejected:V 500 destroys=none",
  pause: "cut rejected:V destroys=carrier",
  resume: "replied rejected:V 500 destroys=carrier",
  "node-pause": "cut rejected:V destroys=carrier",
  rs4: "cut rejected:V destroys=V",
  rs3: "cut rejected:V destroys=V",
  redefine: "replied rejected:V 500 destroys=carrier:refused",
};

/**
 * Runs `fixtures/carrier-stacks.ts` in a process of its own, without a
 * handler of the process: a crash (e.g. a throw into an event of a source) is
 * its exit code and output, not a failure of the test runner
 */
function fixture(...args: string[]): Record<string, unknown> {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--import",
      "tsx",
      join(import.meta.dirname, "fixtures", "carrier-stacks.ts"),
      ...args,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  return { status, stdout, stderr };
}

suite(
  "The carrier of a value whose stack Node.js cannot read safely (H25-1)",
  () => {
    test("is an Error whose stack is a value of its own, which can be neither written nor redefined, made without running any prepareStackTrace: it is decided, and Node.js reads its stack safely", () => {
      const cause = new Error("V");
      /** What the `prepareStackTrace` of the application has been given */
      const given: unknown[] = [];
      const previous: unknown = Reflect.get(Error, "prepareStackTrace");
      Reflect.set(Error, "prepareStackTrace", (error: unknown): never => {
        given.push(error);
        // As one that freezes what it formats, then fails
        Object.freeze(error);
        throw new Error("Frozen");
      });
      const carrier = ((): Error => {
        try {
          return carrierOf(cause);
        } finally {
          Reflect.set(Error, "prepareStackTrace", previous);
        }
      })();
      const reported: unknown[] = [];
      const other = new EventEmitter();
      guard(other, emitterMethods, (error) => reported.push(error));
      other.emit("error", carrier);
      deepStrictEqual(
        [
          carrier instanceof Error,
          Reflect.getPrototypeOf(carrier) === Error.prototype,
          Reflect.getOwnPropertyDescriptor(carrier, "message"),
          Reflect.getOwnPropertyDescriptor(carrier, "cause"),
          Reflect.getOwnPropertyDescriptor(carrier, "stack"),
          given,
          readsSafely(carrier),
          reported,
        ],
        [
          true,
          true,
          {
            value: "A stream has failed",
            writable: true,
            enumerable: false,
            configurable: true,
          },
          {
            value: cause,
            writable: true,
            enumerable: false,
            configurable: true,
          },
          {
            value: "Error: A stream has failed",
            writable: false,
            enumerable: false,
            configurable: false,
          },
          [],
          true,
          [],
        ],
      );
    });

    test("while a prepareStackTrace of the application redefines the stack of what it formats as a getter that cannot be configured, or freezes it and throws: the send rejects with the value, the source is destroyed once, nothing is thrown into its events, and the process does not crash", () => {
      for (const kind of ["nonconf", "freeze"]) {
        deepStrictEqual(
          fixture(kind, ...ways),
          {
            status: 0,
            stdout: ways
              .map(
                (way) =>
                  `${kind}:${way} ${expected[way]} destroyed=true threw=\n`,
              )
              .join(""),
            stderr: "",
          },
          kind,
        );
      }
    });
  },
);
