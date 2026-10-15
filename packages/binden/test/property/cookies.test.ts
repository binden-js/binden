import {
  BindenRequest,
  BindenResponse,
  Cookie,
  type ICookie,
} from "../../index.js";
import { anyString, check, token } from "./check.js";
import { deepStrictEqual, ok } from "node:assert/strict";
import { suite, test } from "node:test";
import { Socket } from "node:net";
import fc from "fast-check";
import { validateHeaderValue } from "node:http";

/** Characters that could end a cookie, its attributes or its field line */
const injections: readonly string[] = [
  ";",
  "; ",
  "; Domain=evil.test",
  "; Path=/",
  "; Secure",
  "=",
  ",",
  " ",
  "\t",
  "\r",
  "\n",
  "\r\nSet-Cookie: a=b",
  "\0",
  "\x7F",
  '"',
  "\\",
  "\xE9",
  "\u2028",
  "a",
  "Z",
  "0",
  ".",
  "-",
  "/",
];

/** A string that may try to inject attributes or field lines */
const hostile = fc.oneof(
  anyString(injections, 12),
  { arbitrary: token, weight: 2 },
  fc
    .tuple(token, fc.constantFrom(...injections), token)
    .map((parts) => parts.join("")),
);

/** The attributes of a `Set-Cookie` value, in their order */
const attribute =
  /^(?:Max-Age=-?\d+|Expires=[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} -?\d{4,6} \d{2}:\d{2}:\d{2} GMT|Domain=[^;]+|Path=[^;]*|Secure|HttpOnly|SameSite=(?:Lax|None|Strict)|Partitioned)$/u;

/** The attributes of the cookies, any of them maybe hostile */
const cookies = fc.record(
  {
    key: hostile,
    value: hostile,
    expires: fc.oneof(fc.constant(null), fc.date()),
    max_age: fc.oneof(
      fc.constant(null),
      fc.integer({ min: -1e6, max: 1e9 }),
      fc.double(),
    ),
    domain: fc.oneof(fc.constant(null), fc.domain(), hostile),
    path: fc.oneof(fc.constant(null), fc.webPath(), hostile),
    secure: fc.boolean(),
    http_only: fc.boolean(),
    same_site: fc.constantFrom<"Lax" | "None" | "Strict">(
      "Lax",
      "None",
      "Strict",
    ),
    partitioned: fc.boolean(),
  },
  { requiredKeys: ["key", "value"] },
);

/** The cookie, or the error of its constructor */
function create(input: ICookie): unknown {
  try {
    return new Cookie(input);
  } catch (error: unknown) {
    return error;
  }
}

/** Checks that a `Set-Cookie` value has the cookie and its attributes only */
function checkSetCookie(cookie: Cookie): void {
  const value = cookie.toString();
  // A valid field value of visible ASCII and spaces, on one line
  ok(/^[\x20-\x7E]*$/u.test(value), value);
  validateHeaderValue("Set-Cookie", value);
  const [pair = "", ...attributes] = value.split("; ");
  deepStrictEqual(pair, `${cookie.key}=${cookie.value}`);
  // Every `;` separates an attribute
  deepStrictEqual(value.split(";").length, attributes.length + 1);
  for (const item of attributes) {
    ok(attribute.test(item), item);
  }
  deepStrictEqual(
    attributes.filter((item) => item.startsWith("Domain=")),
    cookie.domain === null ? [] : [`Domain=${cookie.domain}`],
  );
  deepStrictEqual(
    attributes.filter((item) => item.startsWith("Path=")),
    cookie.path === null ? [] : [`Path=${cookie.path}`],
  );
}

suite("Cookies (properties)", () => {
  test("a cookie is refused (`TypeError`), or serialized without injecting attributes or field lines", () => {
    check(
      fc.property(cookies, (input) => {
        const cookie = create(input);
        if (cookie instanceof Cookie) {
          checkSetCookie(cookie);
        } else {
          ok(cookie instanceof TypeError, String(cookie));
        }
      }),
      1000,
    );
  });

  test("a cookie that the `Cookie` header carries is parsed back as it is", () => {
    check(
      fc.property(
        fc.array(fc.tuple(hostile, hostile), { maxLength: 4 }),
        (pairs) => {
          const valid = pairs.flatMap(([key, value]) => {
            const cookie = create({ key, value });
            return cookie instanceof Cookie ? [cookie] : [];
          });
          const header = valid.map(({ key, value }) => `${key}=${value}`);
          const parsed = Cookie.fromString(header.join("; "));
          for (const cookie of parsed) {
            const same = valid.find(({ key }) => key === cookie.key);
            ok(same);
            deepStrictEqual(
              cookie.value,
              /^".*"$/su.test(same.value)
                ? same.value.slice(1, -1)
                : same.value,
            );
          }
          deepStrictEqual(
            parsed.map(({ key }) => key),
            [...new Set(valid.map(({ key }) => key))],
          );
        },
      ),
      500,
    );
  });

  test("`clearCookie()` refuses an attribute (`TypeError`), or sends a valid `Set-Cookie`", () => {
    check(
      fc.property(
        hostile,
        fc.record(
          {
            domain: fc.oneof(fc.constant(null), fc.domain(), hostile),
            path: fc.oneof(fc.constant(null), fc.webPath(), hostile),
            secure: fc.boolean(),
            same_site: fc.constantFrom<"Lax" | "None" | "Strict">(
              "Lax",
              "None",
              "Strict",
            ),
            partitioned: fc.boolean(),
          },
          { requiredKeys: [] },
        ),
        (name, attributes) => {
          const socket = new Socket();
          try {
            const response = new BindenResponse(new BindenRequest(socket));
            try {
              response.clearCookie(name, attributes);
            } catch (error: unknown) {
              ok(error instanceof TypeError, String(error));
              return;
            }
            const [cookie] = response.cookies;
            ok(cookie instanceof Cookie);
            checkSetCookie(cookie);
            deepStrictEqual(cookie.value, "");
            deepStrictEqual(cookie.max_age, 0);
            // The headers are sent with it, whatever the attributes
            response.writeHead(200);
            deepStrictEqual(response.getHeader("Set-Cookie"), [
              cookie.toString(),
            ]);
          } finally {
            socket.destroy();
          }
        },
      ),
      500,
    );
  });
});
