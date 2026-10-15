import { deepStrictEqual, ok } from "node:assert/strict";
import { validateHeaderValue } from "node:http";
import { suite, test } from "node:test";
import fc from "fast-check";

import {
  Accept,
  AcceptCharset,
  AcceptEncoding,
  AcceptLanguage,
  Authorization,
  ContentEncoding,
  ContentRange,
  ContentType,
  Cookie,
  Forwarded,
  type IAcceptEncodings,
  type IAuthenticationType,
  type IEncodings,
  IfModifiedSince,
  Range,
} from "../../index.js";
import { quote, split, unquote } from "../../src/headers/list.js";
import { anyString, check, fieldValueChar, qvalue, token } from "./check.js";

/** The characters and fragments of the syntax of the headers */
const syntax: readonly string[] = [
  ",",
  ", ",
  ";",
  "; ",
  "=",
  '"',
  "\\",
  " ",
  "\t",
  "/",
  "*",
  "-",
  ":",
  "[",
  "]",
  "_",
  "q=",
  "q=0.5",
  "Q=1",
  "q=1.5",
  "0",
  "1",
  "9",
  "a",
  "Z",
  "text/html",
  "*/*",
  "utf-8",
  "en-US",
  "gzip",
  "X-GZIP",
  "br",
  "Basic",
  "bytes",
  "bytes=",
  "for=",
  "proto=",
  "host=",
  "unknown",
  "GMT",
  "Sun, ",
  "\xA0",
  "\xFF",
  "\x7F",
  "\0",
  "\r\n",
  "\u0100",
  "\u2028",
];

/** A value as a list: empty for `null` */
function present<T>(value: T | null): T[] {
  return value === null ? [] : [value];
}

/** A string of field-value characters */
function text(minLength = 0): fc.Arbitrary<string> {
  return fc.string({ unit: fieldValueChar, minLength, maxLength: 8 });
}

/** A header class: how its field values are parsed and serialized */
interface IHeader<T, F> {
  /** Every element of a field value (`[]` for none) */
  parse(input: string): T[];
  /** What an element is made of, as given to its constructor */
  fields(element: T): F;
  /** An element of its fields */
  create(fields: F): T;
  /** A field value of one element */
  serialize(element: T): string;
  /** Valid fields of an element */
  readonly valid: fc.Arbitrary<F>;
  /** Fields of an element, valid or not (see `valid` without them) */
  readonly any?: fc.Arbitrary<F> | undefined;
  /** The fields of the element of a field value of valid fields (as parsed) */
  parsed(fields: F): F;
}

/**
 * Field values of valid elements, alone, in lists, or with one fragment of
 * the syntax inserted anywhere
 */
function inputs<T, F>(header: IHeader<T, F>): fc.Arbitrary<string> {
  const valid = header.valid.map((fields) =>
    header.serialize(header.create(fields)),
  );
  return fc.oneof(
    anyString(syntax),
    valid,
    fc.array(valid, { maxLength: 3 }).map((values) => values.join(", ")),
    fc
      .tuple(valid, fc.nat(), fc.constantFrom(...syntax))
      .map(([value, at, fragment]) => {
        const index = at % (value.length + 1);
        return `${value.slice(0, index)}${fragment}${value.slice(index)}`;
      }),
  );
}

/** The result of a function, or the `TypeError` that it throws */
function attempt<T>(fn: () => T): T | TypeError {
  try {
    return fn();
  } catch (error: unknown) {
    ok(error instanceof TypeError, String(error));
    return error;
  }
}

/** The properties of the parser and the serialization of a header class */
function properties<T, F>(name: string, header: IHeader<T, F>): void {
  suite(name, () => {
    test("parses any field value, into elements that its constructor accepts and that are parsed back as they are", () => {
      check(
        fc.property(inputs(header), (input) => {
          for (const element of header.parse(input)) {
            const fields = header.fields(element);
            deepStrictEqual(header.fields(header.create(fields)), fields);
            deepStrictEqual(
              header
                .parse(header.serialize(element))
                .map((e) => header.fields(e)),
              [header.parsed(fields)],
            );
          }
        }),
      );
    });

    test("serializes valid elements into field values that are parsed back", () => {
      check(
        fc.property(header.valid, (fields) => {
          const element = header.create(fields);
          validateHeaderValue(name, header.serialize(element));
          deepStrictEqual(
            header
              .parse(header.serialize(element))
              .map((e) => header.fields(e)),
            [header.parsed(header.fields(element))],
          );
        }),
      );
    });

    const { any } = header;
    if (any) {
      test("refuses (`TypeError`) the elements that it cannot serialize, and serializes the others", () => {
        check(
          fc.property(any, (fields) => {
            const element = attempt(() => header.create(fields));
            if (element instanceof TypeError) {
              return;
            }
            validateHeaderValue(name, header.serialize(element));
            deepStrictEqual(
              header
                .parse(header.serialize(element))
                .map((e) => header.fields(e)),
              [header.parsed(header.fields(element))],
            );
          }),
          1000,
        );
      });
    }
  });
}

/** The elements of a list header are the same in one field line or several */
function lines(
  parse: (input: string[] | string) => { toString(): string }[],
): void {
  check(
    fc.property(fc.array(anyString(syntax), { maxLength: 3 }), (values) => {
      deepStrictEqual(
        parse(values).map(String),
        parse(values.join(",")).map(String),
      );
    }),
  );
}

/** Negotiation picks one of the offers, or `false` */
function negotiates(
  negotiate: (offers: readonly string[], input?: string) => string | false,
  offer: fc.Arbitrary<string>,
): void {
  check(
    fc.property(
      fc.array(offer, { maxLength: 4 }),
      fc.option(anyString(syntax)),
      (offers, input) => {
        const preferred =
          input === null ? negotiate(offers) : negotiate(offers, input);
        ok(preferred === false || offers.includes(preferred));
        if (input === null) {
          deepStrictEqual(preferred, offers.at(0) ?? false);
        }
      },
    ),
  );
}

/** A media range: `*\/*`, `type/*` or `type/subtype` */
const mediaRange = fc.oneof(
  fc.constant("*/*"),
  token.filter((type) => type !== "*").map((type) => `${type}/*`),
  fc
    .tuple(token, token)
    .filter(([type]) => type !== "*")
    .map(([type, subtype]) => `${type}/${subtype}`),
);

/** A media type (`type/subtype`), in any case */
const mediaType = fc.oneof(
  fc.constantFrom(
    "multipart/form-data",
    "Multipart/Form-Data",
    "MULTIPART/FORM-DATA",
    "Text/Plain",
  ),
  fc.tuple(token, token).map(([type, subtype]) => `${type}/${subtype}`),
);

/** A language tag (RFC 4647, section 2.1) */
const languageTag = fc.stringMatching(
  /^[A-Za-z]{1,8}(?:-[A-Za-z\d]{1,8}){0,2}$/u,
);

/** The cookie-octets (RFC 6265, section 4.1.1) */
const cookieOctet = fc.constantFrom(
  ..."!#$%&'()*+-./0123456789:<=>?@ABCXYZ[]^_`abcxyz{|}~".split(""),
);

const knownCodings: readonly IEncodings[] = [
  "br",
  "compress",
  "deflate",
  "gzip",
  "x-gzip",
  "zstd",
];

const schemes: readonly IAuthenticationType[] = [
  "AWS4-HMAC-SHA256",
  "Basic",
  "Bearer",
  "Digest",
  "HOBA",
  "Mutual",
  "OAuth",
  "SCRAM-SHA-1",
  "SCRAM-SHA-256",
  "vapid",
];

/** A safe integer position */
const position = fc.maxSafeNat();

/** Parameters by name: tokens (other than `q`) and field values */
const parameters = fc.dictionary(
  token.filter((name) => name.toLowerCase() !== "q"),
  text(),
  { maxKeys: 3 },
);

suite("Headers (properties)", () => {
  properties("Accept", {
    parse: (input) => Accept.fromString(input),
    fields: ({ type, parameters: all, q_value }) => ({
      type,
      parameters: all,
      q_value,
    }),
    create: (fields) => new Accept(fields),
    serialize: (element) => element.toString(),
    valid: fc.record({ type: mediaRange, parameters, q_value: qvalue }),
    // The media range in lowercase
    parsed: (fields) => ({ ...fields, type: fields.type.toLowerCase() }),
  });

  properties("Accept-Charset", {
    parse: (input) => AcceptCharset.fromString(input),
    fields: ({ charset, q_value }) => ({ charset, q_value }),
    create: (fields) => new AcceptCharset(fields),
    serialize: (element) => element.toString(),
    valid: fc.record({ charset: token, q_value: qvalue }),
    parsed: (fields) => fields,
  });

  properties("Accept-Encoding", {
    parse: (input) => AcceptEncoding.fromString(input),
    fields: ({ encoding, q_value }) => ({ encoding, q_value }),
    create: (fields) => new AcceptEncoding(fields),
    serialize: (element) => element.toString(),
    valid: fc.record({
      encoding: fc.constantFrom<IAcceptEncodings>(
        ...knownCodings,
        "*",
        "identity",
      ),
      q_value: qvalue,
    }),
    parsed: (fields) => fields,
  });

  properties("Accept-Language", {
    parse: (input) => AcceptLanguage.fromString(input),
    fields: ({ language, q_value }) => ({ language, q_value }),
    create: (fields) => new AcceptLanguage(fields),
    serialize: (element) => element.toString(),
    valid: fc.record({
      language: fc.oneof(fc.constant("*"), languageTag),
      q_value: qvalue,
    }),
    parsed: (fields) => fields,
  });

  properties("Authorization", {
    parse: (input) => present(Authorization.fromString(input)),
    fields: ({ type, credentials }) => ({ type, credentials }),
    create: (fields) => new Authorization(fields),
    serialize: (element) => element.toString(),
    valid: fc.record({
      type: fc.constantFrom(...schemes),
      credentials: fc.option(text(1).filter((value) => value === value.trim())),
    }),
    parsed: (fields) => fields,
  });

  properties("Content-Encoding", {
    parse: (input) => ContentEncoding.fromString(input) ?? [],
    fields: ({ encoding }) => ({ encoding }),
    create: (fields) => new ContentEncoding(fields),
    serialize: (element) => element.toString(),
    valid: fc.record({ encoding: fc.constantFrom(...knownCodings) }),
    parsed: (fields) => fields,
  });

  properties("Content-Range", {
    parse: (input) => ContentRange.fromString(input),
    fields: ({ start, end, size }) => ({ start, end, size }),
    create: (fields) => new ContentRange(fields),
    serialize: (element) => element.toString(),
    valid: fc.oneof(
      fc
        .tuple(position, position, position)
        .map((numbers) => numbers.toSorted((a, b) => a - b))
        .filter(([, end, size]) => end < size)
        .map(([start, end, size]) => ({ start, end, size })),
      fc
        .tuple(position, position)
        .map(([a, b]) => ({ start: Math.min(a, b), end: Math.max(a, b) }))
        .map(({ start, end }) => ({ start, end, size: "*" as const })),
      position.map((size) => ({ start: null, end: null, size })),
    ),
    // `{ size: "*" }` among them, which is not a content range (`bytes *\/*`)
    any: fc.record({
      start: fc.option(fc.nat(9)),
      end: fc.option(fc.nat(9)),
      size: fc.oneof(fc.constant("*" as const), fc.nat(9)),
    }),
    parsed: (fields) => fields,
  });

  properties("Content-Type", {
    parse: (input) => present(ContentType.fromString(input)),
    fields: ({ type, charset, boundary, parameters: all }) => ({
      type,
      charset,
      boundary,
      parameters: all,
    }),
    create: (fields) => new ContentType(fields),
    serialize: (element) => element.toString(),
    valid: fc.record({
      type: mediaType,
      charset: fc.option(text()),
      boundary: text(1),
      parameters,
    }),
    // A `boundary` of `multipart/form-data` may be missing
    any: fc.record({
      type: mediaType,
      charset: fc.option(text()),
      boundary: fc.option(text()),
      parameters,
    }),
    // The media type and the charset in lowercase
    parsed: (fields) => {
      const charset = fields.charset?.toLowerCase() ?? null;
      return {
        ...fields,
        type: fields.type.toLowerCase(),
        charset,
        parameters:
          charset === null
            ? fields.parameters
            : { ...fields.parameters, charset },
      };
    },
  });

  properties("Cookie", {
    parse: (input) => Cookie.fromString(input),
    fields: ({ key, value }) => ({ key, value }),
    create: (fields) => new Cookie(fields),
    serialize: ({ key, value }) => `${key}=${value}`,
    valid: fc.record({
      key: token,
      value: fc
        .tuple(fc.string({ unit: cookieOctet, maxLength: 8 }), fc.boolean())
        .map(([value, quoted]) => (quoted ? `"${value}"` : value)),
    }),
    // Without the double quotes of the value
    parsed: ({ key, value }) => ({
      key,
      value: /^".*"$/su.test(value) ? value.slice(1, -1) : value,
    }),
  });

  properties("Forwarded", {
    parse: (input) => Forwarded.fromString(input),
    fields: (element) => ({
      for: element.for,
      by: element.by,
      host: element.host,
      proto: element.proto,
      secret: element.secret,
    }),
    create: (fields) => new Forwarded(fields),
    serialize: (element) => element.toString(),
    valid: fc.record({
      for: text(),
      by: fc.option(text()),
      host: fc.option(text()),
      proto: fc.option(text()),
      secret: fc.option(text()),
    }),
    parsed: (fields) => fields,
  });

  properties("If-Modified-Since", {
    parse: (input) => present(IfModifiedSince.fromString(input)),
    fields: ({ date }) => ({ date }),
    create: (fields) => new IfModifiedSince(fields),
    serialize: (element) => element.toString(),
    // Every year of four digits
    valid: fc
      .date({
        min: new Date("0000-01-01T00:00:00Z"),
        max: new Date("9999-12-31T23:59:59Z"),
        noInvalidDate: true,
      })
      .map((date) => ({
        date: new Date(date.getTime() - (date.getTime() % 1000)),
      })),
    parsed: (fields) => fields,
  });

  properties("Range", {
    parse: (input) => Range.fromString(input),
    fields: ({ start, end }) => ({ start, end }),
    create: (fields) => new Range(fields),
    serialize: (element) => element.toString(),
    valid: fc.oneof(
      position.map((start) => ({ start, end: null })),
      position.map((end) => ({ start: null, end })),
      fc
        .tuple(position, position)
        .map(([a, b]) => ({ start: Math.min(a, b), end: Math.max(a, b) })),
    ),
    parsed: (fields) => fields,
  });

  test("the lists of weighted values are the same in one field line or several", () => {
    lines((input) => Accept.fromString(input));
    lines((input) => AcceptCharset.fromString(input));
    lines((input) => AcceptEncoding.fromString(input));
    lines((input) => AcceptLanguage.fromString(input));
  });

  test("a negotiation picks one of the offers, or none", () => {
    negotiates(
      (offers, input) => Accept.negotiate(offers, input),
      fc
        .tuple(token, token)
        .filter(([type, subtype]) => type !== "*" && subtype !== "*")
        .map(([type, subtype]) => `${type}/${subtype}`),
    );
    negotiates(
      (offers, input) => AcceptCharset.negotiate(offers, input),
      token.filter((charset) => charset !== "*"),
    );
    negotiates(
      (offers, input) => AcceptEncoding.negotiate(offers, input),
      token.filter((coding) => coding !== "*"),
    );
    negotiates(
      (offers, input) => AcceptLanguage.negotiate(offers, input),
      languageTag,
    );
  });

  test("Content-Encoding lists the codings in the order to remove them", () => {
    check(
      fc.property(
        fc.array(fc.constantFrom(...knownCodings), { maxLength: 4 }),
        (codings) => {
          deepStrictEqual(
            ContentEncoding.fromString(codings.join(", "))?.map(String),
            codings.toReversed(),
          );
        },
      ),
    );
  });

  test("a quoted string is unquoted as it was, and never split", () => {
    check(
      fc.property(
        anyString(syntax),
        anyString(syntax),
        fc.constantFrom(",", ";"),
        (a, b, separator) => {
          deepStrictEqual(unquote(quote(a)), a);
          deepStrictEqual(
            split(`${quote(a)}${separator}${quote(b)}`, separator),
            [quote(a), quote(b)],
          );
        },
      ),
    );
  });
});
