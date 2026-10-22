import { capture, fetchRaw, serve } from "./helpers.js";
import { deepStrictEqual, ok } from "node:assert/strict";
import { Compression } from "../index.js";
import type { Context } from "binden";
import { test } from "node:test";

/** An error of the application's own */
class OwnError extends Error {}

/** The methods of a logger that the application replaces */
const methods = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "child",
] as const;

test("a filter that fails is logged by the guarded path of binden: the methods and child() of context.log replaced by throwing ones, or a throwing log getter, never run nor crash, and the response is replaced with an empty 500 all the same", async () => {
  const captured = capture();
  /** The calls of the methods that the application has replaced */
  const called: string[] = [];
  const served = await serve(
    { app: { logger: captured.logger } },
    new Compression({
      filter: (context): boolean => {
        if (context.url.pathname.endsWith("-boolean")) {
          return "true" as unknown as boolean;
        }
        throw new OwnError("filter");
      },
    }),
    async (context: Context) => {
      const { pathname } = context.url;
      // Mid-request, once the compression is installed
      if (pathname.startsWith("/getter")) {
        Object.defineProperty(context, "log", {
          configurable: true,
          get(): never {
            throw new OwnError("log");
          },
        });
      } else {
        for (const name of methods) {
          Reflect.set(context.log, name, (): never => {
            called.push(name);
            throw new OwnError(name);
          });
        }
      }
      const { response } = context;
      response.setHeader("Content-Type", "text/plain");
      await new Promise<void>((resolve) => {
        response.end("body", resolve);
      });
    },
  );
  try {
    for (const path of [
      "/methods",
      "/methods-boolean",
      "/getter",
      "/getter-boolean",
    ]) {
      const response = await fetchRaw(served.url, {
        path,
        headers: { "accept-encoding": "gzip" },
      });
      deepStrictEqual(
        [response.status, response.headers["content-length"]],
        [500, "0"],
        path,
      );
      ok(!("content-type" in response.headers), path);
      deepStrictEqual(response.raw.length, 0, path);
    }
  } finally {
    await served.close();
  }
  deepStrictEqual(called, []);
  // Written by the logger of binden itself, whatever its methods are; the
  // records of a context whose `log` throws are dropped
  await captured.waitFor(2);
  deepStrictEqual(
    captured.records.filter(({ msg }) =>
      String(msg).startsWith("The `filter` of the compression"),
    ),
    [
      { level: 50, msg: "The `filter` of the compression has failed" },
      {
        level: 50,
        msg: "The `filter` of the compression has not returned a boolean",
      },
    ],
  );
});
