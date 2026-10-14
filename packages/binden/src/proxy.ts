import type { IncomingHttpHeaders } from "node:http";
import { SocketAddress, isIPv4, isIPv6 } from "node:net";

import Forwarded from "./headers/forwarded.js";

/**
 * Whether the address of a hop (`0` is the peer, then the addresses of the
 * header from right to left) is a trusted proxy: called synchronously, it
 * must return a boolean
 */
export type ITrustFn = (address: string, hop: number) => boolean;

/**
 * The headers of the trusted proxies: `Forwarded` (RFC 7239), or
 * `X-Forwarded-For` with `X-Forwarded-Proto` and `X-Forwarded-Host`
 */
export type IProxyHeaders = "forwarded" | "x-forwarded";

/**
 * The proxies in front of the server that are trusted: none (`false`), all of
 * them (`true`), the given number of the nearest hops, or those that a
 * function accepts; with the headers that they send (`forwarded` by default)
 */
export type ITrustProxy =
  | ITrustFn
  | boolean
  | number
  | {
      trust: ITrustFn | boolean | number;
      headers?: IProxyHeaders | undefined;
    };

/** A checked `trust_proxy` option, with its headers */
export interface IProxyTrust {
  readonly trust: ITrustFn | boolean | number;
  readonly headers: IProxyHeaders;
}

/** What the trusted proxies tell about the client */
export interface IProxyResult {
  /** The address of the client, or `null` when it is unknown */
  readonly ip: string | null;
  /** The client (unless unknown) and the trusted proxies, left to right */
  readonly ips: readonly string[];
  /** The protocol from a trusted proxy, or `null` for the connection's */
  readonly protocol: "http" | "https" | null;
  /** The host from a trusted proxy, or `null` for the request's own */
  readonly host: string | null;
}

/** A hop: its address (`null` for `unknown` or an obfuscated one) */
interface IHop {
  readonly address: string | null;
  /** The protocol and the host that the proxy received (`Forwarded`) */
  readonly protocol: string | null;
  readonly host: string | null;
}

/** `nodename [ ":" node-port ]` (RFC 7239, section 6) */
const node =
  /^(?:\[(?<v6>[^\]]*)\]|(?<name>[^:[\]]+))(?::(?:\d{1,5}|_[\w.-]+))?$/u;

/** A URI scheme (RFC 3986, section 3.1) */
const scheme = /^[A-Za-z][\d+.A-Za-z-]*$/u;

/** An IPv4-mapped IPv6 address */
const mapped = /^::ffff:(?<v4>\d{1,3}(?:\.\d{1,3}){3})$/iu;

/**
 * An IPv6 address in its canonical form: in lowercase and compressed (with its
 * zone), and as IPv4 when it is an IPv4-mapped address
 */
function canonical(address: string): string {
  const [ip = "", ...zone] = address.split("%");
  const { address: v6 } = new SocketAddress({ address: ip, family: "ipv6" });
  const v4 = mapped.exec(v6)?.groups?.v4;
  if (typeof v4 === "string") {
    return v4;
  }
  return zone.length > 0 ? `${v6}%${zone.join("%")}` : v6;
}

/**
 * A node of a proxy header: an IP address (`[v6]`, `v4`, or a bare IPv6
 * address, with an optional port) as `{ address }`, `unknown` or an
 * obfuscated identifier (`_x`) as `{ address: null }`, `null` when invalid
 */
export function parseNode(value: string): { address: string | null } | null {
  if (isIPv6(value)) {
    return { address: canonical(value) };
  }
  const { v6, name = "" } = node.exec(value)?.groups ?? {};
  if (typeof v6 === "string") {
    return isIPv6(v6) ? { address: canonical(v6) } : null;
  } else if (isIPv4(name)) {
    return { address: name };
  } else if (/^unknown$/iu.test(name) || /^_[\w.-]+$/u.test(name)) {
    return { address: null };
  }
  return null;
}

/**
 * Whether a value is `uri-host [ ":" port ]` (RFC 9110, section 7.2): nothing
 * that ends the authority of a URL, nor userinfo
 */
export function isAuthority(value: string): boolean {
  return !/[\s/?#@\\]/u.test(value) && URL.canParse(`http://${value}`);
}

/**
 * Throws a `TypeError` unless the result of a synchronous callback is a
 * boolean: a promise (whose rejection is handled) or any other value is a
 * configuration error, never an implicit `true`
 */
export function strictBoolean(result: unknown, name: string): boolean {
  if (typeof result === "boolean") {
    return result;
  } else if (
    typeof (result as { then?: unknown } | null)?.then === "function"
  ) {
    Promise.resolve(result).catch(() => null);
  }
  throw new TypeError(`\`${name}\` has not returned a boolean`);
}

/** `true`, `false`, a function, or a non-negative safe integer */
function checkTrust(trust: unknown): ITrustFn | boolean | number {
  if (
    typeof trust === "boolean" ||
    (typeof trust === "number" && Number.isSafeInteger(trust) && trust >= 0)
  ) {
    return trust;
  } else if (typeof trust === "number") {
    throw new RangeError("`trust_proxy` is not a non-negative integer");
  } else if (typeof trust !== "function") {
    throw new TypeError("`trust_proxy` is not a boolean, number or function");
  }
  return trust as ITrustFn;
}

/**
 * The `trust_proxy` option with its headers, checked: a `TypeError` (or a
 * `RangeError` for a number that is not a non-negative safe integer) otherwise
 */
export function checkTrustProxy(value: unknown): IProxyTrust {
  if (typeof value !== "object" || value === null) {
    return Object.freeze({ trust: checkTrust(value), headers: "forwarded" });
  }
  const { trust, headers = "forwarded" } = value as Record<string, unknown>;
  if (headers !== "forwarded" && headers !== "x-forwarded") {
    throw new TypeError(
      '`trust_proxy.headers` is not "forwarded" or "x-forwarded"',
    );
  }
  return Object.freeze({ trust: checkTrust(trust), headers });
}

/** The trust of a hop, as a function */
function trusting(trust: ITrustFn | boolean | number): ITrustFn {
  if (typeof trust === "function") {
    return (address, hop) => strictBoolean(trust(address, hop), "trust_proxy");
  } else if (typeof trust === "number") {
    return (_address, hop) => hop < trust;
  }
  return () => trust;
}

/** The elements of `Forwarded` as hops, `null` for an invalid one */
function forwardedHops(header?: string): (IHop | null)[] {
  return Forwarded.parse(header).map((element) => {
    const found = element === null ? null : parseNode(element.for);
    if (
      element === null ||
      found === null ||
      (element.proto !== null && !scheme.test(element.proto)) ||
      (element.host !== null && !isAuthority(element.host))
    ) {
      return null;
    }
    const protocol = element.proto?.toLowerCase() ?? null;
    return { address: found.address, protocol, host: element.host };
  });
}

/** The addresses of `X-Forwarded-For` as hops, `null` for an invalid one */
function xForwardedHops(header?: string[] | string): (IHop | null)[] {
  // Field lines are joined with `,` (also those of an array)
  return String(header ?? "")
    .split(",")
    .map((element) => element.trim())
    .filter((element) => element !== "")
    .map((element) => {
      const found = parseNode(element);
      return found === null
        ? null
        : { address: found.address, protocol: null, host: null };
    });
}

/**
 * The protocol and the host that the trusted peer has set: one field line of
 * one value each. When one of them is duplicated, a list or malformed, those
 * of the request are used for both.
 */
function xForwardedOrigin(
  distinct: NodeJS.Dict<string[]>,
): Pick<IHop, "host" | "protocol"> {
  const none = { protocol: null, host: null };
  const fields = ["x-forwarded-proto", "x-forwarded-host"].map(
    (name) => distinct[name] ?? [],
  );
  if (
    fields.some(
      (values) =>
        values.length > 1 || values.some((value) => value.includes(",")),
    )
  ) {
    return none;
  }
  const [[proto = null] = [], [host = null] = []] = fields;
  if (
    (proto !== null && !scheme.test(proto)) ||
    (host !== null && !isAuthority(host))
  ) {
    return none;
  }
  return { protocol: proto?.toLowerCase() ?? null, host };
}

/**
 * What the trusted proxies tell about the client. The hops are the peer (hop
 * 0), then the addresses of the header from right to left (every proxy
 * appends the address of its own client): they are walked while they are
 * trusted. The client is the first one that is not, or the leftmost one when
 * all of them are. The walk stops on `unknown` or an obfuscated identifier
 * (an unknown client), and on an invalid element (an unknown client, and the
 * protocol and host of the request).
 *
 * The protocol and the host are those of the element of the farthest trusted
 * proxy (`Forwarded`), or those that a trusted peer has set (`X-Forwarded-*`).
 */
export function resolveProxy(
  peer: string | undefined,
  { trust, headers }: IProxyTrust,
  fields: IncomingHttpHeaders,
  distinct: NodeJS.Dict<string[]>,
): IProxyResult {
  const first = typeof peer === "string" ? parseNode(peer) : null;
  if (typeof first?.address !== "string") {
    return { ip: null, ips: [], protocol: null, host: null };
  }
  const trusts = trusting(trust);
  const addresses = [first.address];
  if (!trusts(first.address, 0)) {
    return { ip: first.address, ips: addresses, protocol: null, host: null };
  }

  const forwarded = headers === "forwarded";
  const hops = forwarded
    ? forwardedHops(fields.forwarded)
    : xForwardedHops(fields["x-forwarded-for"]);
  let origin = forwarded
    ? { protocol: null, host: null }
    : xForwardedOrigin(distinct);
  const result = (ip: string | null): IProxyResult => {
    const { protocol, host } = origin;
    return {
      ip,
      ips: addresses.toReversed(),
      protocol: protocol === "http" || protocol === "https" ? protocol : null,
      host,
    };
  };

  for (let hop = 1; hop <= hops.length; hop += 1) {
    // Appended by the proxy of the previous hop, which is trusted
    const element = hops[hops.length - hop];
    if (element === null) {
      return {
        ip: null,
        ips: addresses.toReversed(),
        protocol: null,
        host: null,
      };
    } else if (forwarded) {
      origin = element;
    }
    if (element.address === null) {
      return result(null);
    }
    addresses.push(element.address);
    if (!trusts(element.address, hop)) {
      return result(element.address);
    }
  }
  return result(addresses[addresses.length - 1]);
}
