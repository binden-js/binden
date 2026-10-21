import {
  type IProxyResult,
  type ITrustProxy,
  checkTrustProxy,
  isAuthority,
  resolveProxy,
  strictBoolean,
} from "./proxy.js";
import { type ParsedUrlQuery, parse } from "node:querystring";
import { described, formatting } from "./formatting.js";
import Accept from "./headers/accept.js";
import AcceptCharset from "./headers/accept-charset.js";
import AcceptEncoding from "./headers/accept-encoding.js";
import AcceptLanguage from "./headers/accept-language.js";
import Authorization from "./headers/authorization.js";
import { BindenError } from "./error.js";
import ContentEncoding from "./headers/content-encoding.js";
import ContentType from "./headers/content-type.js";
import Cookie from "./headers/cookie.js";
import Forwarded from "./headers/forwarded.js";
import IfModifiedSince from "./headers/if-modified-since.js";
import { IncomingMessage } from "node:http";
import Range from "./headers/range.js";
import type { Socket } from "node:net";
import { TLSSocket } from "node:tls";
import { formatStack } from "./exchange.js";
import { randomUUID } from "node:crypto";
import { token } from "./headers/list.js";

/** The trusted proxies (see `IRequestOptions.trust_proxy`) */
export type { IProxyHeaders, ITrustFn, ITrustProxy } from "./proxy.js";

/** The protocol of a request, as in `URL.protocol` */
export type IProtocol = "http:" | "https:";

/**
 * The settings of the requests of an application, checked and with their
 * defaults (see `validateRequestOptions()`)
 */
export interface IRequestOptions {
  /** The trusted proxies and their headers (none by default) */
  readonly trust_proxy: ITrustProxy;
  /**
   * Whether the path of a request-target may have an encoded slash or
   * backslash (`%2F`, `%5C`): a `400 Bad Request` otherwise (by default)
   */
  readonly encoded_slashes: boolean;
  /**
   * The hosts that the effective host of a request (see `request.host`) may
   * be (any host by default): a `400 Bad Request` otherwise. A list of hosts
   * (`hostname` for any port, or `hostname:port`), or a function of the host.
   */
  readonly allowed_hosts: IAllowedHosts | null;
  /**
   * The request ids: their field name (in lowercase), whether an incoming id
   * is trusted, and whether the id is sent back in the response (by
   * `Binden`). `null` (by default): new ids, not sent back.
   */
  readonly request_id: IRequestIdSettings | null;
  /** The greatest number of keys that `request.query` parses (1000) */
  readonly query: {
    /** The greatest number of keys (a positive integer, or `Infinity`) */
    readonly max_keys: number;
  };
}

/**
 * The allowed hosts: a list of hosts (`hostname` for any port, or
 * `hostname:port`), or a function of the effective host (`hostname[:port]`,
 * see `request.host`), called synchronously, that must return a boolean
 */
export type IAllowedHosts = readonly string[] | ((host: string) => boolean);

/** The settings of the request ids, checked and with their defaults */
export interface IRequestIdSettings {
  /** The name of the field of the id, in lowercase */
  readonly header: string;
  /** Whether a valid incoming id is used instead of a new one */
  readonly trust_incoming: boolean;
  /** Whether the response sends the id back */
  readonly echo: boolean;
}

/** The request ids, as given */
export interface IRequestIdOptions {
  /** The field of the id (`x-request-id` by default) */
  header?: string | undefined;
  /**
   * Whether the id of the request (one field line of 1 to 128 letters, digits,
   * `.`, `_`, `:` and `-`) is used instead of a new one (`false` by default):
   * only when the proxies in front of the server set or check it
   */
  trust_incoming?: boolean | undefined;
  /** Whether the response sends the id back (`true` by default) */
  echo?: boolean | undefined;
}

/** The request options as given (to `Binden`), every one of them optional */
export interface IRequestOptionsInput {
  /**
   * The trusted proxies (none by default): `true` (all of them), a number of
   * the nearest hops, a function of the address and the hop, or an object
   * with one of them as `trust` and the `headers` that they set (`forwarded`
   * by default, or `x-forwarded`)
   */
  trust_proxy?: ITrustProxy | undefined;
  /**
   * Whether the path of a request-target (and so a route parameter) may have
   * an encoded slash or backslash (`%2F`, `%5C`): `false` by default (a
   * `400 Bad Request`)
   */
  encoded_slashes?: boolean | undefined;
  /** The hosts that the requests may have (any by default), see `IRequestOptions` */
  allowed_hosts?: IAllowedHosts | undefined;
  /** The request ids (new ids, not sent back, by default) */
  request_id?: IRequestIdOptions | undefined;
  /** The greatest number of keys that `request.query` parses (`1000`) */
  query?:
    | {
        /** The greatest number of keys: a positive integer, or `Infinity` */
        max_keys?: number | undefined;
      }
    | undefined;
}

/** Throws unless the value is an object (or `undefined`, for the default) */
function optionalObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value === "undefined") {
    return {};
  } else if (typeof value !== "object" || value === null) {
    throw formatStack(new TypeError(`\`${name}\` is not an object`));
  }
  return value as Record<string, unknown>;
}

/** `hostname [ ":" port ]`, the hostname being an IP literal or not */
const allowedHost = /^(?<hostname>\[[^\]]*\]|[^:]*)(?::(?<port>\d{1,5}))?$/u;

/** A name of labels of letters, digits, `_` and `-` (not at their ends) */
const hostname =
  /^[\dA-Za-z_](?:[\w-]{0,61}[\dA-Za-z_])?(?:\.[\dA-Za-z_](?:[\w-]{0,61}[\dA-Za-z_])?)*$/u;

/**
 * An allowed host, in lowercase (an IPv6 address compressed): a host name, an
 * IPv4 address or an IPv6 address in brackets, with an optional port
 */
function checkAllowedHost(entry: unknown): string {
  const { hostname: name = "", port = "" } =
    typeof entry === "string" ? (allowedHost.exec(entry)?.groups ?? {}) : {};
  const value = Number(port);
  // An IPv6 address in brackets is checked by the URL parser
  const v6 = name.startsWith("[");
  const named = !v6 && hostname.test(name) && name.length <= 253;
  // The name of a URL (e.g. not `1.2.3`, which a URL reads as `1.2.0.3`)
  const normal =
    (v6 || named) && URL.canParse(`http://${name}`)
      ? new URL(`http://${name}`).hostname
      : "";
  if (
    normal === "" ||
    (named && normal !== name.toLowerCase()) ||
    (port !== "" && (value < 1 || value > 65535))
  ) {
    throw formatStack(
      new TypeError(
        `\`allowed_hosts\` has an invalid host: ${described(entry)}`,
      ),
    );
  }
  return port === "" ? normal : `${normal}:${value}`;
}

/** The checked `allowed_hosts` option (`null` for any host) */
function checkAllowedHosts(value: unknown): IAllowedHosts | null {
  if (typeof value === "undefined") {
    return null;
  } else if (typeof value === "function") {
    return value as (host: string) => boolean;
  } else if (!Array.isArray(value)) {
    throw formatStack(
      new TypeError("`allowed_hosts` is not an array or a function"),
    );
  } else if (value.length === 0) {
    throw formatStack(
      new RangeError("`allowed_hosts` is empty: no request is allowed"),
    );
  }
  return Object.freeze(value.map((entry: unknown) => checkAllowedHost(entry)));
}

/** Whether the URL is of the allowed host (a checked one; any port without one) */
function isAllowed(entry: string, url: URL): boolean {
  // The port follows the brackets of an IPv6 address
  const index = entry.lastIndexOf(":");
  const [name, port] =
    index > entry.lastIndexOf("]")
      ? [entry.slice(0, index), entry.slice(index + 1)]
      : [entry, ""];
  const effective = url.port || (url.protocol === "https:" ? "443" : "80");
  return name === url.hostname && (port === "" || port === effective);
}

/** The checked `request_id` option, with its defaults (`null` without it) */
function checkRequestId(value: unknown): IRequestIdSettings | null {
  if (typeof value === "undefined") {
    return null;
  }
  const {
    header = "x-request-id",
    trust_incoming = false,
    echo = true,
  } = optionalObject(value, "request_id");
  if (typeof header !== "string" || !token.test(header)) {
    throw formatStack(new TypeError("`request_id.header` is not a field name"));
  } else if (typeof trust_incoming !== "boolean") {
    throw formatStack(
      new TypeError("`request_id.trust_incoming` is not a boolean"),
    );
  } else if (typeof echo !== "boolean") {
    throw formatStack(new TypeError("`request_id.echo` is not a boolean"));
  }
  return Object.freeze({ header: header.toLowerCase(), trust_incoming, echo });
}

/** An id that a request may carry */
const incomingId = /^[\w.:-]{1,128}$/u;

/** The request options with their defaults, checked (see `validateRequestOptions()`) */
function checkRequestOptions(input?: IRequestOptionsInput): IRequestOptions {
  const {
    trust_proxy = false,
    encoded_slashes = false,
    allowed_hosts,
    request_id,
    query,
  } = optionalObject(input, "options");
  const { max_keys = 1000 } = optionalObject(query, "query");
  if (typeof encoded_slashes !== "boolean") {
    throw formatStack(new TypeError("`encoded_slashes` is not a boolean"));
  } else if (typeof max_keys !== "number") {
    throw formatStack(new TypeError("`query.max_keys` is not a number"));
  } else if (
    max_keys !== Number.POSITIVE_INFINITY &&
    !(Number.isSafeInteger(max_keys) && max_keys > 0)
  ) {
    throw formatStack(
      new RangeError("`query.max_keys` is not a positive integer"),
    );
  }
  return Object.freeze({
    trust_proxy: checkTrustProxy(trust_proxy),
    encoded_slashes,
    allowed_hosts: checkAllowedHosts(allowed_hosts),
    request_id: checkRequestId(request_id),
    query: Object.freeze({ max_keys }),
  });
}

/**
 * The request options with their defaults, checked: a `TypeError` for a value
 * of another type, a `RangeError` for a value out of its range (e.g.
 * `trust_proxy: -1`, an empty `allowed_hosts`, or `query.max_keys` that is not
 * a positive integer or `Infinity`). Other properties of the input are ignored.
 * What reading them throws (e.g. a revoked proxy) is formatted (see
 * `formatting()`).
 */
export function validateRequestOptions(
  input?: IRequestOptionsInput,
): IRequestOptions {
  return formatting(() => checkRequestOptions(input));
}

/** The default options of the requests */
const defaults = validateRequestOptions();

/**
 * An incoming request (`IncomingMessage`) with its parsed headers, URL, client
 * and content negotiation: the `IncomingMessage` class of the servers
 */
export class BindenRequest extends IncomingMessage {
  #accept_encoding?: readonly AcceptEncoding[];
  #authorization?: Authorization | null;
  #body?: unknown;
  #content_encoding?: readonly ContentEncoding[] | null;
  #content_type?: ContentType | null;
  #cookies?: readonly Cookie[];
  #forwarded?: readonly Forwarded[];
  #id?: string;
  #if_modified_since?: IfModifiedSince | null;
  #proxy?: IProxyResult;
  #range?: readonly Range[];
  #query?: ParsedUrlQuery;

  /**
   * A request of a connection, as `IncomingMessage` creates it: what reading
   * the socket throws (e.g. a revoked proxy) is formatted (see
   * `formatStack()`)
   */
  public constructor(socket: Socket) {
    super(BindenRequest.#socket(socket));
  }

  /**
   * The preferred one of the offered media types (e.g. `application/json`), by
   * the `Accept` header (see `Accept.negotiate()`), or `false`
   */
  public accepts(...types: string[]): string | false {
    try {
      return Accept.negotiate(types, this.headers.accept);
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /**
   * The preferred one of the offered charsets, by the `Accept-Charset` header
   * (see `AcceptCharset.negotiate()`), or `false`
   */
  public acceptsCharsets(...charsets: string[]): string | false {
    try {
      return AcceptCharset.negotiate(charsets, this.headers["accept-charset"]);
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /**
   * The preferred one of the offered content codings, by the
   * `Accept-Encoding` header (see `AcceptEncoding.negotiate()`), or `false`
   */
  public acceptsEncodings(...encodings: string[]): string | false {
    try {
      return AcceptEncoding.negotiate(
        encodings,
        this.headers["accept-encoding"],
      );
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /**
   * The preferred one of the offered language tags, by the `Accept-Language`
   * header (see `AcceptLanguage.negotiate()`), or `false`
   */
  public acceptsLanguages(...languages: string[]): string | false {
    try {
      return AcceptLanguage.negotiate(
        languages,
        this.headers["accept-language"],
      );
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /** The known codings of `Accept-Encoding`, from the greatest weight */
  public get accept_encoding(): AcceptEncoding[] {
    try {
      if (!this.#accept_encoding) {
        const ae = this.headers["accept-encoding"];
        this.#accept_encoding = AcceptEncoding.fromString(ae);
      }
      return [...this.#accept_encoding];
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /** The `Authorization` header, or `null` (unsupported or missing) */
  public get authorization(): Authorization | null {
    try {
      if (typeof this.#authorization === "undefined") {
        const { authorization } = this.headers;
        this.#authorization = Authorization.fromString(authorization);
      }
      return this.#authorization;
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /** The parsed body (set once, e.g. by a body parser) */
  public get body(): unknown {
    return this.#body;
  }

  /** Sets the parsed body: once only, later values are ignored */
  public set body(body: unknown) {
    if (typeof this.#body === "undefined") {
      this.#body = body;
    }
  }

  /** The content codings of the body, or `null` when one of them is unknown */
  public get content_encoding(): ContentEncoding[] | null {
    try {
      if (typeof this.#content_encoding === "undefined") {
        this.#content_encoding = ContentEncoding.fromString(
          this.headers["content-encoding"],
        );
      }
      return this.#content_encoding === null
        ? null
        : [...this.#content_encoding];
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /** The `Content-Type` header, or `null` (invalid or missing) */
  public get content_type(): ContentType | null {
    try {
      if (typeof this.#content_type === "undefined") {
        this.#content_type = ContentType.fromString(
          this.headers["content-type"],
        );
      }
      return this.#content_type;
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /** The valid cookies of the `Cookie` header */
  public get cookies(): Cookie[] {
    try {
      if (!this.#cookies) {
        this.#cookies = Cookie.fromString(this.headers.cookie);
      }
      return [...this.#cookies];
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /**
   * The valid elements of `Forwarded`, from any client (see `ip` and
   * `protocol` for those of the trusted proxies)
   */
  public get forwarded(): Forwarded[] {
    try {
      if (!this.#forwarded) {
        this.#forwarded = Forwarded.fromString(this.headers.forwarded);
      }
      return [...this.#forwarded];
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /**
   * A header by its name, in any case: a name that is not a string throws a
   * `TypeError`, which describes it without converting it (see `described()`)
   */
  public header(name: string): string[] | string | undefined {
    try {
      if (typeof name !== "string") {
        throw formatStack(
          new TypeError(`The name is not a string: ${described(name)}`),
        );
      }
      return this.headers[name.toLowerCase()];
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /**
   * The id of the request: a new UUID or, with `request_id.trust_incoming`,
   * the one of the request (one field line of 1 to 128 letters, digits, `.`,
   * `_`, `:` and `-`)
   */
  public get id(): string {
    try {
      this.#id ??= this.#incomingId() ?? randomUUID();
      return this.#id;
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /** The `If-Modified-Since` header, or `null` (not an HTTP-date, or missing) */
  public get if_modified_since(): IfModifiedSince | null {
    try {
      if (typeof this.#if_modified_since === "undefined") {
        const input = this.headers["if-modified-since"];
        this.#if_modified_since = IfModifiedSince.fromString(input);
      }
      return this.#if_modified_since;
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /**
   * The effective host of the request (`hostname[:port]`, in lowercase, without
   * the default port of the protocol): the authority of a request-target in
   * absolute-form, otherwise the host from a trusted proxy (see `trust_proxy`),
   * otherwise `Host`. `null` without any, and a `BindenError` (400) for an
   * invalid one.
   */
  public get host(): string | null {
    try {
      const { authority } = BindenRequest.#split(this.url ?? "/");
      const origin = this.#origin(authority);
      return origin === null ? null : new URL(origin).host;
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /**
   * The address of the client: the peer (without the `::ffff:` prefix of an
   * IPv4-mapped address) or, behind trusted proxies (see `trust_proxy`), the
   * first address of their header that is not trusted (the leftmost one when
   * all of them are). `null` when it is unknown (e.g. `for=unknown`, or an
   * invalid element on the way).
   */
  public get ip(): string | null {
    try {
      return this.#resolve().ip;
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /** The address of the client (unless unknown) and of the trusted proxies, left to right */
  public get ips(): readonly string[] {
    try {
      return [...this.#resolve().ips];
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /**
   * The protocol of the connection or, behind trusted proxies (see
   * `trust_proxy`), the one that they have received: the `proto` of the
   * `Forwarded` element of the farthest trusted proxy, or the
   * `X-Forwarded-Proto` that a trusted peer has set
   */
  public get protocol(): IProtocol {
    try {
      const { protocol } = this.#resolve();
      if (protocol === null) {
        return this.socket instanceof TLSSocket ? "https:" : "http:";
      }
      return `${protocol}:`;
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /**
   * The settings of the requests (see `IRequestOptions`): the defaults.
   * `Binden` sets them from its options in a subclass of its own; with
   * `http.createServer()`, override it in a subclass to return the result of
   * `validateRequestOptions()`.
   */
  // eslint-disable-next-line class-methods-use-this -- overridden by subclasses
  protected get options(): Readonly<IRequestOptions> {
    return defaults;
  }

  /**
   * The query of `URL`, parsed by `querystring.parse()`: a copy, with the
   * first `query.max_keys` keys of the options (the others are ignored)
   */
  public get query(): ParsedUrlQuery {
    try {
      if (!this.#query) {
        const { max_keys } = this.options.query;
        this.#query = parse(this.URL.search.substring(1), "&", "=", {
          // `0` is no limit
          maxKeys: max_keys === Number.POSITIVE_INFINITY ? 0 : max_keys,
        });
      }

      // Defined, not assigned: a `__proto__` key is a key, not the prototype
      return Object.fromEntries(
        Object.entries(this.#query).map(([key, value]) => [
          key,
          Array.isArray(value) ? [...value] : value,
        ]),
      );
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /** The ranges of the `Range` header */
  public get range(): Range[] {
    try {
      if (typeof this.#range === "undefined") {
        this.#range = Range.fromString(this.headers.range);
      }
      return [...this.#range];
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /** Whether the protocol is `https:` (see `protocol`) */
  public get secure(): boolean {
    try {
      return this.protocol === "https:";
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /**
   * The URL of the request: the protocol of the connection (see `protocol`),
   * the authority of the request-target in absolute-form (otherwise of
   * `Host`), and the path and query of the request-target (RFC 9112, section
   * 3.2). A `400 Bad Request` error without a valid one.
   */
  public get URL(): URL {
    try {
      const target = this.url ?? "/";
      const { authority, rest } = BindenRequest.#split(target);
      const { path, query } =
        target === "*" && this.method === "OPTIONS"
          ? { path: "*", query: "" }
          : BindenRequest.#target(rest, this.options.encoded_slashes);
      const origin = this.#origin(authority);
      if (origin === null) {
        throw new BindenError(400);
      }
      const url = new URL(origin);
      // Set as a path: `//evil.test/x` is a path, not the authority of the URL
      url.pathname = path;
      url.search = query === "" ? "" : `?${query}`;
      return url;
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /**
   * The socket of a new request, read first as `IncomingMessage` reads it
   * (its `readableHighWaterMark`, when it is truthy), so that what reading it
   * throws is formatted (see `formatStack()`) before Node.js reads it again
   */
  static #socket(socket: Socket): Socket {
    const value: unknown = socket;
    try {
      // A primitive has no getter of its own
      if (
        (typeof value === "object" && value !== null) ||
        typeof value === "function"
      ) {
        Reflect.get(value, "readableHighWaterMark");
      }
      return socket;
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /** The trusted id of the request, or `null` */
  #incomingId(): string | null {
    const { request_id } = this.options;
    if (request_id?.trust_incoming !== true) {
      return null;
    }
    const values = this.headersDistinct[request_id.header.toLowerCase()] ?? [];
    return values.length === 1 && incomingId.test(values[0]) ? values[0] : null;
  }

  /** What the trusted proxies tell about the client, found once */
  #resolve(): IProxyResult {
    this.#proxy ??= resolveProxy(
      this.socket.remoteAddress,
      checkTrustProxy(this.options.trust_proxy),
      this.headers,
      this.headersDistinct,
    );
    return this.#proxy;
  }

  /**
   * The protocol and the effective authority of the request (see `host`), or
   * `null` without an authority. A `BindenError` (400) for an invalid one (not
   * `uri-host [ ":" port ]`, e.g. with userinfo), for one that `allowed_hosts`
   * does not allow (also a missing one), and for a request with several
   * `Host` field lines (RFC 9112, section 3.2), of which Node.js keeps the
   * first one while a proxy may have used another one.
   */
  #origin(target: string | null): string | null {
    const authority = target ?? this.#resolve().host ?? this.headers.host;
    const { allowed_hosts } = this.options;
    if ((this.headersDistinct.host ?? []).length > 1) {
      throw new BindenError(400);
    } else if (typeof authority === "undefined") {
      if (allowed_hosts !== null) {
        throw new BindenError(400);
      }
      return null;
    } else if (!isAuthority(authority)) {
      throw new BindenError(400);
    }
    const origin = `${this.protocol}//${authority}`;
    if (allowed_hosts === null) {
      return origin;
    }
    const url = new URL(origin);
    const allowed =
      typeof allowed_hosts === "function"
        ? strictBoolean(allowed_hosts(url.host), "allowed_hosts")
        : allowed_hosts.some((entry) => isAllowed(entry, url));
    if (!allowed) {
      throw new BindenError(400);
    }
    return origin;
  }

  /**
   * The authority of a request-target in absolute-form (`null` otherwise) and
   * the rest of it: a `BindenError` (400) for another scheme than `http` and
   * `https`, or an empty authority
   */
  static #split(target: string): { authority: string | null; rest: string } {
    // The rest is sliced off rather than matched: `.*$` after the authority
    // would backtrack quadratically on a line terminator (e.g. of a
    // rewritten `request.url`), which `.` does not match
    const absolute = /^(?<scheme>[a-z][\d+.a-z-]*):\/\/(?<host>[^/?]*)/iu.exec(
      target,
    );
    if (!absolute) {
      return { authority: null, rest: target };
    }
    const { scheme, host } = absolute.groups as Record<
      "host" | "scheme",
      string
    >;
    const tail = target.slice(absolute[0].length);
    // The authority is then checked as `Host` (e.g. for userinfo)
    if (!["http", "https"].includes(scheme.toLowerCase()) || host === "") {
      throw new BindenError(400);
    }
    // An empty path is `/`
    return { authority: host, rest: tail.startsWith("/") ? tail : `/${tail}` };
  }

  /**
   * The path and the query of a request-target (without its authority), which
   * must be in origin-form, without a fragment, a backslash, a space or a
   * control character (which the URL parser would remove or encode after the
   * checks, e.g. `.\t.` is `..`, as a rewritten `request.url` may have them), an
   * invalid percent-encoding, or dot-segments (which the URL parser would
   * remove, so that the request would be routed to another path); nor, unless
   * `encoded_slashes`, with an encoded slash or backslash in its path (a
   * segment that a router would see as several, once decoded).
   */
  static #target(
    rest: string,
    encoded_slashes: boolean,
  ): { path: string; query: string } {
    if (
      !rest.startsWith("/") ||
      /[#\\]/u.test(rest) ||
      // eslint-disable-next-line no-control-regex -- control characters on purpose
      /[\x00-\x20\x7F]/u.test(rest) ||
      /%(?![\da-f]{2})/iu.test(rest)
    ) {
      throw new BindenError(400);
    }

    const index = rest.indexOf("?");
    const path = index === -1 ? rest : rest.slice(0, index);
    const query = index === -1 ? "" : rest.slice(index + 1);
    if (
      path.split("/").some((part) => /^(?:\.|%2e){1,2}$/iu.test(part)) ||
      (!encoded_slashes && /%(?:2f|5c)/iu.test(path))
    ) {
      throw new BindenError(400);
    }
    return { path, query };
  }
}
