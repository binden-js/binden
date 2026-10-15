import { deepStrictEqual, ok } from "node:assert/strict";
import { Socket } from "node:net";
import { suite, test } from "node:test";
import fc from "fast-check";

import {
  BindenError,
  BindenRequest,
  type IRequestOptions,
  validateRequestOptions,
} from "../../index.js";
import { check, visible } from "./check.js";

/** The URL of a request-target (with `Host: origin.test`), or its error */
function urlOf(
  target: string,
  { method = "GET", encoded_slashes = false } = {},
): unknown {
  class Options extends BindenRequest {
    // eslint-disable-next-line class-methods-use-this -- a fixture
    protected override get options(): IRequestOptions {
      return validateRequestOptions({ encoded_slashes });
    }
  }
  const socket = new Socket();
  try {
    const request = new Options(socket);
    request.url = target;
    request.method = method;
    request.headers = { host: "origin.test" };
    request.headersDistinct = { host: ["origin.test"] };
    return request.URL;
  } catch (error: unknown) {
    return error;
  } finally {
    socket.destroy();
  }
}

/** A dot-segment, maybe percent-encoded (RFC 3986, section 3.3) */
const dotSegment = /^(?:\.|%2e){1,2}$/iu;

/**
 * A segment of a path in a canonical form: its percent-encodings in uppercase,
 * and every other character but the unreserved ones and the sub-delimiters
 * percent-encoded, as the URL parser may do
 */
function canonical(segment: string): string {
  return segment
    .replaceAll(/%[\da-f]{2}/giu, (encoded) => encoded.toUpperCase())
    .replaceAll(
      /[^\w\-.~!$&'()*+,;=:@%]/gu,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );
}

/** The fragments of the path of a request-target */
const fragments: readonly string[] = [
  "/",
  "//",
  ".",
  "..",
  "%2e",
  "%2E",
  ".%2e",
  "%2e.",
  "%2f",
  "%2F",
  "%5c",
  "%5C",
  "%252e",
  "%25",
  "%",
  "%z",
  "%41",
  "%ff",
  "?",
  "#",
  "\\",
  "a",
  "B",
  "~",
];

/**
 * The path and query of a request-target as Node.js delivers it: visible
 * ASCII only (its parser refuses control characters, spaces and other bytes)
 */
const target = fc
  .array(fc.oneof(fc.constantFrom(...fragments), fc.constantFrom(...visible)), {
    maxLength: 16,
  })
  .map((parts) => `/${parts.join("")}`);

/** A request-target with any character, or in another form */
const anyTarget = fc.oneof(
  target,
  fc.string({ unit: "binary-ascii", maxLength: 20 }),
  fc
    .tuple(
      fc.constantFrom("http://", "HTTPS://", "ftp://", "//", "http:///"),
      fc.constantFrom("origin.test", "a:1", "user@origin.test", "[::1]", ""),
      target,
    )
    .map((parts) => parts.join("")),
  fc
    .tuple(target, fc.constantFrom("\t", "\n", "\r", "\0", " ", "\x7F"), target)
    .map(([a, control, b]) => `${a}${control}${b.slice(1)}`),
);

suite("Request-target (properties)", () => {
  test("`URL` is a URL without dot-segments, or a `400 Bad Request`", () => {
    check(
      fc.property(anyTarget, fc.boolean(), (input, encoded_slashes) => {
        const url = urlOf(input, { encoded_slashes });
        if (url instanceof URL) {
          ok(!url.pathname.split("/").some((part) => dotSegment.test(part)));
        } else {
          ok(url instanceof BindenError, String(url));
          deepStrictEqual(url.status, 400);
        }
      }),
      500,
    );
  });

  test("`URL` keeps every segment of the path of an origin-form request-target", () => {
    check(
      fc.property(target, fc.boolean(), (input, encoded_slashes) => {
        const url = urlOf(input, { encoded_slashes });
        if (url instanceof URL) {
          const [path = ""] = input.split("?");
          deepStrictEqual(
            url.pathname.split("/").map((part) => canonical(part)),
            path.split("/").map((part) => canonical(part)),
          );
          deepStrictEqual(url.host, "origin.test");
        }
      }),
      500,
    );
  });

  test("`URL` refuses an encoded slash or backslash in the path, unless `encoded_slashes`", () => {
    const encoded = /%(?:2f|5c)/iu;
    check(
      fc.property(target, (input) => {
        const [path = "", ...query] = input.split("?");
        const url = urlOf(input);
        ok(!(url instanceof URL) || !encoded.test(url.pathname));
        // Allowed, they are as any other percent-encoding
        const neutral = [
          path.replaceAll(/%(?:2f|5c)/giu, "%41"),
          ...query,
        ].join("?");
        deepStrictEqual(
          urlOf(input, { encoded_slashes: true }) instanceof URL,
          urlOf(neutral) instanceof URL,
        );
      }),
      500,
    );
  });

  test("`OPTIONS *` is the only request-target of the asterisk-form", () => {
    ok(urlOf("*", { method: "OPTIONS" }) instanceof URL);
    check(
      fc.property(
        fc.constantFrom("GET", "HEAD", "POST", "PUT", "DELETE"),
        (method) => {
          const error = urlOf("*", { method });
          ok(error instanceof BindenError && error.status === 400);
        },
      ),
      20,
    );
  });
});
