import { deepStrictEqual, ok } from "node:assert/strict";
import type { IncomingHttpHeaders } from "node:http";
import { Socket } from "node:net";
import { suite, test } from "node:test";
import fc from "fast-check";

import {
  BindenRequest,
  type IProxyHeaders,
  type IRequestOptions,
  type ITrustProxy,
  validateRequestOptions,
} from "../../index.js";
import { check } from "./check.js";

/** What an element of a proxy header is */
type IKind = "invalid" | "obfuscated" | "unknown" | "v4" | "v6";

/** An element of a proxy header, and what it tells */
interface IElement {
  readonly kind: IKind;
  /** The address of the client of the proxy (`null`: unknown or invalid) */
  readonly address: string | null;
  /** The element of `Forwarded` */
  readonly forwarded: string;
  /** The element of `X-Forwarded-For` */
  readonly x_forwarded: string;
  /** The protocol and the host of the element of `Forwarded` */
  readonly proto: string | null;
  readonly host: string | null;
}

/** What the request tells about its client */
interface IClient {
  readonly ip: string | null;
  readonly ips: readonly string[];
  readonly protocol: string;
  readonly host: string | null;
}

/** The address of the peer, and the `Host` of the request */
const peer = "198.51.100.7";
const origin = "origin.test";

/** Malformed elements of `Forwarded`, of which none has a `,` */
const invalidForwarded: readonly string[] = [
  "for=300.1.1.1",
  'for="[192.0.2.1]"',
  "for=192.0.2.1;for=192.0.2.2",
  "for",
  "for=a b",
  "for=192.0.2.1;proto=1http",
  'for=192.0.2.1;host="a/b"',
  'for=192.0.2.1;host="user@host.test"',
  'for="192.0.2.1:99999x"',
];

/** Malformed elements of `X-Forwarded-For` */
const invalidXForwarded: readonly string[] = [
  "300.1.1.1",
  "[192.0.2.1]",
  "not-an-ip",
  "192.0.2.1:x",
  "::ffff:999.1.1.1",
  "[::1",
];

/** An element at a position (from 0, left to right): its address is unique */
function element(index: number): fc.Arbitrary<IElement> {
  const v4 = `192.0.2.${index + 1}`;
  const v6 = `2001:db8::${(index + 1).toString(16)}`;
  const proto = fc.constantFrom(null, "http", "https", "HTTPS", "ws");
  const host = fc.constantFrom(null, `h${index}.test`, `h${index}.test:8443`);
  /** A valid element of `Forwarded`, with its `proto` and `host` */
  const forwarded = (
    kind: IKind,
    address: string | null,
    nodes: readonly string[],
    x_forwarded: readonly string[],
  ): fc.Arbitrary<IElement> =>
    fc
      .record({
        node: fc.constantFrom(...nodes),
        xff: fc.constantFrom(...x_forwarded),
        proto,
        host,
      })
      .map(({ node, xff, proto: p, host: h }) => ({
        kind,
        address,
        // Without `for`, the client is unknown (an empty element is none)
        forwarded:
          [
            ...(node === "" ? [] : [node]),
            ...(p === null ? [] : [`proto=${p}`]),
            ...(h === null ? [] : [`host=${h}`]),
          ].join(";") || "for=unknown",
        x_forwarded: xff,
        proto: p?.toLowerCase() ?? null,
        host: h,
      }));
  return fc.oneof(
    forwarded("v4", v4, [`for=${v4}`, `for="${v4}:8080"`], [v4, `${v4}:8080`]),
    forwarded(
      "v6",
      v6,
      [`for="[${v6}]"`, `for="[${v6.toUpperCase()}]:443"`],
      [v6, `[${v6}]:443`, `[${v6.toUpperCase()}]`],
    ),
    forwarded("unknown", null, ["for=unknown", "for=UNKNOWN", ""], ["unknown"]),
    forwarded(
      "obfuscated",
      null,
      ["for=_hidden", 'for="_x:_y"'],
      ["_hidden", "_x.y"],
    ),
    fc
      .tuple(
        fc.constantFrom(...invalidForwarded),
        fc.constantFrom(...invalidXForwarded),
      )
      .map(([f, x]) => ({
        kind: "invalid" as const,
        address: null,
        forwarded: f,
        x_forwarded: x,
        proto: null,
        host: null,
      })),
  );
}

/** A chain of up to 6 elements */
const chain = fc
  .integer({ min: 0, max: 6 })
  .chain((length) =>
    fc.tuple(...Array.from({ length }, (_, index) => element(index))),
  )
  .map((elements): readonly IElement[] => elements);

/** How the hops are trusted: by count, by address, or all or none of them */
type ITrust =
  | { readonly kind: "addresses"; readonly trusted: readonly string[] }
  | { readonly kind: "all"; readonly value: boolean }
  | { readonly kind: "count"; readonly value: number };

const trusts: fc.Arbitrary<ITrust> = fc.oneof(
  fc.boolean().map((value) => ({ kind: "all" as const, value })),
  fc.integer({ min: 0, max: 7 }).map((value) => ({
    kind: "count" as const,
    value,
  })),
  fc
    .subarray([
      peer,
      ...Array.from({ length: 6 }, (_, i) => `192.0.2.${i + 1}`),
      ...Array.from({ length: 6 }, (_, i) => `2001:db8::${i + 1}`),
    ])
    .map((addresses) => ({ kind: "addresses" as const, trusted: addresses })),
);

/** Whether a hop is trusted */
function trusted(trust: ITrust, address: string, hop: number): boolean {
  if (trust.kind === "all") {
    return trust.value;
  } else if (trust.kind === "count") {
    return hop < trust.value;
  }
  return trust.trusted.includes(address);
}

/** The field lines of `X-Forwarded-Proto` and `X-Forwarded-Host` */
const xForwardedOrigin = fc.record({
  proto: fc.constantFrom<readonly string[]>(
    [],
    ["https"],
    ["HTTP"],
    ["https", "http"],
    ["https,http"],
    ["1bad"],
  ),
  host: fc.constantFrom<readonly string[]>(
    [],
    ["xf.test"],
    ["xf.test:8080"],
    ["a.test", "b.test"],
    ["a/b"],
  ),
});

/** The client that the request tells about (see `IClient`) */
function client(
  header: IProxyHeaders,
  trust: ITrust,
  elements: readonly IElement[],
  fields: { proto: readonly string[]; host: readonly string[] },
  calls: [string, number][],
): IClient {
  class Trusting extends BindenRequest {
    // eslint-disable-next-line class-methods-use-this -- a fixture
    protected override get options(): IRequestOptions {
      const fn = (address: string, hop: number): boolean => {
        calls.push([address, hop]);
        return trusted(trust, address, hop);
      };
      const value: ITrustProxy = trust.kind === "addresses" ? fn : trust.value;
      return {
        ...validateRequestOptions(),
        trust_proxy: { trust: value, headers: header },
      };
    }
  }
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", { value: peer });
  try {
    const request = new Trusting(socket);
    request.url = "/";
    request.method = "GET";
    const lines: [string, string[]][] = [
      ["host", [origin]],
      ["forwarded", elements.map((e) => e.forwarded)],
      ["x-forwarded-for", elements.map((e) => e.x_forwarded)],
      ["x-forwarded-proto", [...fields.proto]],
      ["x-forwarded-host", [...fields.host]],
    ];
    const headers: IncomingHttpHeaders = {};
    const distinct: NodeJS.Dict<string[]> = {};
    for (const [name, values] of lines.filter(([, v]) => v.length > 0)) {
      // As Node.js does: the field lines of a name joined, and also kept apart
      headers[name] = values.join(", ");
      distinct[name] = values;
    }
    request.headers = headers;
    request.headersDistinct = distinct;
    const { ip, ips, protocol, host } = request;
    return { ip, ips, protocol, host };
  } finally {
    socket.destroy();
  }
}

/** What the trusted proxies tell (RFC 7239 and the contract of `trust_proxy`) */
function model(
  header: IProxyHeaders,
  trust: ITrust,
  elements: readonly IElement[],
  fields: { proto: readonly string[]; host: readonly string[] },
): IClient & { readonly calls: [string, number][] } {
  const calls: [string, number][] = [[peer, 0]];
  const connection = { protocol: "http:", host: origin };
  if (!trusted(trust, peer, 0)) {
    return { ip: peer, ips: [peer], ...connection, calls };
  }
  // `X-Forwarded-Proto` and `-Host` of the trusted peer: one valid value each
  const [proto = null] = fields.proto;
  const [xHost = null] = fields.host;
  const single =
    fields.proto.length <= 1 &&
    fields.host.length <= 1 &&
    !(proto ?? "").includes(",") &&
    proto !== "1bad" &&
    xHost !== "a/b";
  let told =
    header === "x-forwarded" && single
      ? { proto: proto?.toLowerCase() ?? null, host: xHost }
      : { proto: null, host: null };
  const reply = (
    ip: string | null,
    ips: string[],
  ): IClient & { calls: [string, number][] } => ({
    ip,
    ips: ips.toReversed(),
    protocol:
      told.proto === "http" || told.proto === "https"
        ? `${told.proto}:`
        : "http:",
    host: told.host ?? origin,
    calls,
  });
  const ips = [peer];
  for (let hop = 1; hop <= elements.length; hop += 1) {
    const hopElement = elements[elements.length - hop];
    if (hopElement.kind === "invalid") {
      told = { proto: null, host: null };
      return reply(null, ips);
    } else if (header === "forwarded") {
      told = { proto: hopElement.proto, host: hopElement.host };
    }
    if (hopElement.address === null) {
      return reply(null, ips);
    }
    ips.push(hopElement.address);
    calls.push([hopElement.address, hop]);
    if (!trusted(trust, hopElement.address, hop)) {
      return reply(hopElement.address, ips);
    }
  }
  return reply(ips.at(-1) ?? null, ips);
}

suite("Trusted proxies (properties)", () => {
  test("the client, the trusted proxies, the protocol and the host are those of the trust walk", () => {
    check(
      fc.property(
        fc.constantFrom<IProxyHeaders>("forwarded", "x-forwarded"),
        trusts,
        chain,
        xForwardedOrigin,
        (header, trust, elements, fields) => {
          const calls: [string, number][] = [];
          const actual = client(header, trust, elements, fields, calls);
          const { calls: expectedCalls, ...expected } = model(
            header,
            trust,
            elements,
            fields,
          );
          deepStrictEqual(actual, expected);
          if (trust.kind === "addresses") {
            // The function sees every hop on the way once, from the peer
            deepStrictEqual(calls, expectedCalls);
          }
        },
      ),
      1000,
    );
  });

  test("no address left of an invalid element is ever the client or a trusted proxy", () => {
    check(
      fc.property(
        fc.constantFrom<IProxyHeaders>("forwarded", "x-forwarded"),
        trusts,
        chain,
        (header, trust, elements) => {
          const { ip, ips } = client(
            header,
            trust,
            elements,
            { proto: [], host: [] },
            [],
          );
          const invalid = elements.findLastIndex((e) => e.kind === "invalid");
          const left = new Set(
            elements.slice(0, invalid + 1).map((e) => e.address),
          );
          ok(ip === null || !left.has(ip), String(ip));
          ok(ips.every((address) => !left.has(address)));
          if (invalid >= 0 && ip !== null) {
            // Then the walk has stopped before the invalid element
            const index = elements.findIndex((e) => e.address === ip);
            ok(ip === peer || index > invalid);
          }
        },
      ),
      1000,
    );
  });
});
