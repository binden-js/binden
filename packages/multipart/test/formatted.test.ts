import { Multipart, MultipartFile, multipartInfo } from "../index.js";
import { deepStrictEqual, ok } from "node:assert/strict";
import { suite, test } from "node:test";
import type { Context } from "binden";

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

/** A revoked proxy */
function revoked(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

suite(
  "The entry points of the multipart parser format what they throw (round 27)",
  () => {
    test("new Multipart(), run() and multipartInfo() format what reading their argument throws", async () => {
      for (const run of [
        (): unknown => new Multipart(revoked()),
        (): unknown => new Multipart().run(null as unknown as Context),
        (): unknown => new Multipart().run(revoked() as Context),
        (): unknown => multipartInfo(null as unknown as Context),
        (): unknown => multipartInfo(revoked() as Context),
      ]) {
        const failed = await outcome(run);
        ok(failed?.thrown instanceof TypeError);
        ok(failed.formatted);
      }
      const own = new OwnError("own");
      deepStrictEqual(
        await outcome(
          () =>
            new Multipart({
              get limit(): number {
                throw own;
              },
            }),
        ),
        { thrown: own, formatted: true },
      );
    });

    test("new MultipartFile() formats the errors of File and what reading its options throws, and keeps `truncated` as given", async () => {
      for (const args of [
        [null, "a.txt"],
        [["a"], Symbol("s")],
        [["a"], "a.txt", revoked()],
        [["a"], "a.txt", null],
      ]) {
        const failed = await outcome(
          () => new MultipartFile(...(args as [BlobPart[], string])),
        );
        ok(failed?.thrown instanceof TypeError);
        ok(failed.formatted);
      }
      const own = new OwnError("own");
      deepStrictEqual(
        await outcome(
          () =>
            new MultipartFile(["a"], "a.txt", {
              get truncated(): boolean {
                throw own;
              },
            }),
        ),
        { thrown: own, formatted: true },
      );
      deepStrictEqual(
        [
          new MultipartFile(["a"], "a.txt").truncated,
          new MultipartFile(["a"], "a.txt", { truncated: true }).truncated,
          new MultipartFile(["a"], "a.txt", { type: "text/plain" }).type,
        ],
        [false, true, "text/plain"],
      );
    });
  },
);
