import { Binden, type Context, Cookie, type IBindenOptions } from "../index.js";
import { capture, listen } from "./helpers.js";
import { deepStrictEqual, ok } from "node:assert/strict";
import { suite, test } from "node:test";
import { converse } from "./connection.js";

/** A cookie whose `toString()` throws from its second call on */
function failingLater(): object {
  let calls = 0;
  return {
    toString(): string {
      calls += 1;
      if (calls > 1) {
        throw new Error("Failed later");
      }
      return "later=1";
    },
  };
}

/** The cookies (but the valid one) that fail whenever they are serialised */
const failing: Record<string, () => object> = {
  throwing: () => ({
    toString(): never {
      throw new Error("Failed");
    },
  }),
  "revoked proxy": () => {
    const { proxy, revoke } = Proxy.revocable(
      new Cookie({ key: "r", value: "1" }),
      {},
    );
    revoke();
    return proxy;
  },
  derived: () => Object.create(new Cookie({ key: "d", value: "1" })) as object,
  "null prototype": () => Object.create(null) as object,
  symbol: () => ({ toString: (): unknown => Symbol("s") }),
  "line break": () => ({ toString: (): string => "b=1\r\nX-Injected: 1" }),
};

/** The error of each of them (its type and message), as it is logged */
const errors: Record<string, unknown[]> = {
  throwing: ["Error", "Failed"],
  "revoked proxy": [
    "TypeError",
    "Cannot perform 'get' on a proxy that has been revoked",
  ],
  derived: [
    "TypeError",
    "Cannot read private member #key from an object whose class did not declare it",
  ],
  "null prototype": ["TypeError", "cookie.toString is not a function"],
  symbol: ["TypeError", "Cannot convert a Symbol value to a string"],
  "line break": [
    "TypeError",
    'Invalid character in header content ["Set-Cookie"]',
  ],
};

/** A request that fails, and the pipelined one after it */
const requests =
  "GET /fail HTTP/1.1\r\nHost: localhost\r\n\r\nGET /next HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n";

suite("The cookies of an error reply of binden", () => {
  test("each cookie that fails as its head is committed is dropped and logged (also one that first fails then): the reply is sent with the others, framed, and the pipelined request is answered (R3 P2-4)", async () => {
    const valid = new Cookie({ key: "a", value: "1" });
    const handlers: Record<string, IBindenOptions> = {
      default: {},
      // Its reply fails as well: the empty `500` of binden replaces it
      "failing error_handler": {
        error_handler: async ({ response }: Context): Promise<void> => {
          await response.status(503).send("handled");
        },
      },
    };
    for (const [handler, options] of Object.entries(handlers)) {
      for (const [shape, make] of Object.entries(failing)) {
        const name = `${handler}, ${shape}`;
        const captured = capture();
        const rejections: unknown[] = [];
        let kept: ReadonlySet<Cookie> = new Set();
        // A valid cookie, read once by each commit
        let conversions = 0;
        const counted = {
          toString(): string {
            conversions += 1;
            return "c=1";
          },
        };
        const app = new Binden({
          ...options,
          logger: captured.logger,
          log_error_details: true,
        });
        app.use(async ({ response, url }: Context) => {
          if (url.pathname === "/next") {
            await response.send("next");
            return;
          }
          // The second fails later, once the reply of the application has
          // failed by the third
          for (const cookie of [counted, failingLater(), make(), valid]) {
            response.cookies.add(cookie as Cookie);
          }
          kept = response.cookies;
          try {
            await response.send("x");
          } catch (error: unknown) {
            // The reply of the application is not guarded
            rejections.push(error);
            throw error;
          }
        });
        const listening = await listen(app);
        try {
          const { received, closed } = await converse(listening.port, requests);
          ok(closed, name);
          const [first = "", second = ""] = received
            .split(/(?=HTTP\/1\.1 )/u)
            .map((reply) => reply.replaceAll(/\r\nDate: [^\r]*/gu, ""));
          deepStrictEqual(
            first,
            "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nSet-Cookie: c=1\r\nSet-Cookie: a=1; Path=/; HttpOnly; SameSite=Lax\r\nConnection: keep-alive\r\nKeep-Alive: timeout=5\r\n\r\n",
            name,
          );
          ok(second.startsWith("HTTP/1.1 200 OK\r\n"), `${name}: ${second}`);
          ok(second.endsWith("\r\n\r\nnext"), `${name}: ${second}`);
        } finally {
          await listening.close();
        }
        deepStrictEqual(rejections.length, 1, name);
        // Dropped from its cookies
        deepStrictEqual([...kept], [counted, valid], name);
        // By the reply of the application, of the `error_handler`, and of
        // binden
        deepStrictEqual(conversions, handler === "default" ? 2 : 3, name);
        const dropped = captured.records.filter(
          ({ msg }) =>
            msg === "A cookie has not been sent with the error reply",
        );
        deepStrictEqual(
          dropped.map(({ level, failure }) => {
            const { location, status, type, message } = failure as Record<
              string,
              unknown
            >;
            return [level, location, status, type, message];
          }),
          [
            [40, "send", 500, "Error", "Failed later"],
            [40, "send", 500, ...errors[shape]],
          ],
          name,
        );
        deepStrictEqual(
          captured.records.filter(
            ({ msg }) => msg === "The error reply has not been sent",
          ),
          [],
          name,
        );
      }
    }
  });
});
