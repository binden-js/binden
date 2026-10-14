import { randomUUID } from "node:crypto";
import { IncomingMessage } from "node:http";
import { parse, type ParsedUrlQuery } from "node:querystring";
import { TLSSocket } from "node:tls";

import { BindenError } from "./error.js";
import Accept from "./headers/accept.js";
import AcceptCharset from "./headers/accept-charset.js";
import AcceptEncoding from "./headers/accept-encoding.js";
import AcceptLanguage from "./headers/accept-language.js";
import Authorization from "./headers/authorization.js";
import ContentEncoding from "./headers/content-encoding.js";
import ContentType from "./headers/content-type.js";
import Cookie from "./headers/cookie.js";
import Forwarded from "./headers/forwarded.js";
import IfModifiedSince from "./headers/if-modified-since.js";
import Range from "./headers/range.js";
import {
  type IProxyResult,
  type ITrustProxy,
  checkTrustProxy,
  isAuthority,
  resolveProxy,
} from "./proxy.js";

export type { IProxyHeaders, ITrustFn, ITrustProxy } from "./proxy.js";

export type IProtocol = "http:" | "https:";

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
   * The preferred one of the offered media types (e.g. `application/json`), by
   * the `Accept` header (see `Accept.negotiate()`), or `false`
   */
  public accepts(...types: string[]): string | false {
    return Accept.negotiate(types, this.headers.accept);
  }

  /**
   * The preferred one of the offered charsets, by the `Accept-Charset` header
   * (see `AcceptCharset.negotiate()`), or `false`
   */
  public acceptsCharsets(...charsets: string[]): string | false {
    return AcceptCharset.negotiate(charsets, this.headers["accept-charset"]);
  }

  /**
   * The preferred one of the offered content codings, by the
   * `Accept-Encoding` header (see `AcceptEncoding.negotiate()`), or `false`
   */
  public acceptsEncodings(...encodings: string[]): string | false {
    return AcceptEncoding.negotiate(encodings, this.headers["accept-encoding"]);
  }

  /**
   * The preferred one of the offered language tags, by the `Accept-Language`
   * header (see `AcceptLanguage.negotiate()`), or `false`
   */
  public acceptsLanguages(...languages: string[]): string | false {
    return AcceptLanguage.negotiate(languages, this.headers["accept-language"]);
  }

  public get accept_encoding(): AcceptEncoding[] {
    if (!this.#accept_encoding) {
      const ae = this.headers["accept-encoding"];
      this.#accept_encoding = AcceptEncoding.fromString(ae);
    }
    return [...this.#accept_encoding];
  }

  public get authorization(): Authorization | null {
    if (typeof this.#authorization === "undefined") {
      const { authorization } = this.headers;
      this.#authorization = Authorization.fromString(authorization);
    }
    return this.#authorization;
  }

  public get body(): unknown {
    return this.#body;
  }

  public set body(body: unknown) {
    if (typeof this.#body === "undefined") {
      this.#body = body;
    }
  }

  /** The content codings of the body, or `null` when one of them is unknown */
  public get content_encoding(): ContentEncoding[] | null {
    if (typeof this.#content_encoding === "undefined") {
      this.#content_encoding = ContentEncoding.fromString(
        this.headers["content-encoding"],
      );
    }
    return this.#content_encoding === null ? null : [...this.#content_encoding];
  }

  public get content_type(): ContentType | null {
    if (typeof this.#content_type === "undefined") {
      this.#content_type = ContentType.fromString(this.headers["content-type"]);
    }
    return this.#content_type;
  }

  public get cookies(): Cookie[] {
    if (!this.#cookies) {
      this.#cookies = Cookie.fromString(this.headers.cookie);
    }
    return [...this.#cookies];
  }

  public get forwarded(): Forwarded[] {
    if (!this.#forwarded) {
      this.#forwarded = Forwarded.fromString(this.headers.forwarded);
    }
    return [...this.#forwarded];
  }

  public header(name: string): string[] | string | undefined {
    return this.headers[name.toLowerCase()];
  }

  public get id(): string {
    if (typeof this.#id === "undefined") {
      this.#id = randomUUID();
    }
    return this.#id;
  }

  public get if_modified_since(): IfModifiedSince | null {
    if (typeof this.#if_modified_since === "undefined") {
      const input = this.headers["if-modified-since"];
      this.#if_modified_since = IfModifiedSince.fromString(input);
    }
    return this.#if_modified_since;
  }

  /**
   * The effective host of the request (`hostname[:port]`, in lowercase, without
   * the default port of the protocol): the authority of a request-target in
   * absolute-form, otherwise the host from a trusted proxy (see `trust_proxy`),
   * otherwise `Host`. `null` without any, and a `BindenError` (400) for an
   * invalid one.
   */
  public get host(): string | null {
    const { authority } = BindenRequest.#split(this.url ?? "/");
    const origin = this.#origin(authority);
    return origin === null ? null : new URL(origin).host;
  }

  /**
   * The address of the client: the peer (without the `::ffff:` prefix of an
   * IPv4-mapped address) or, behind trusted proxies (see `trust_proxy`), the
   * first address of their header that is not trusted (the leftmost one when
   * all of them are). `null` when it is unknown (e.g. `for=unknown`, or an
   * invalid element on the way).
   */
  public get ip(): string | null {
    return this.#resolve().ip;
  }

  /** The address of the client (unless unknown) and of the trusted proxies, left to right */
  public get ips(): readonly string[] {
    return [...this.#resolve().ips];
  }

  /**
   * The protocol of the connection or, behind trusted proxies (see
   * `trust_proxy`), the one that they have received: the `proto` of the
   * `Forwarded` element of the farthest trusted proxy, or the
   * `X-Forwarded-Proto` that a trusted peer has set
   */
  public get protocol(): IProtocol {
    const { protocol } = this.#resolve();
    if (protocol === null) {
      return this.socket instanceof TLSSocket ? "https:" : "http:";
    }
    return `${protocol}:`;
  }

  /**
   * The proxies in front of the server that are trusted, and their headers
   * (none by default). `Binden` sets it from its `trust_proxy` option; with
   * `http.createServer()`, override it in a subclass.
   */
  // eslint-disable-next-line class-methods-use-this -- overridden by subclasses
  protected get trust_proxy(): ITrustProxy {
    return false;
  }

  public get query(): ParsedUrlQuery {
    if (!this.#query) {
      this.#query = parse(this.URL.search.substring(1));
    }

    // Defined, not assigned: a `__proto__` key is a key, not the prototype
    return Object.fromEntries(
      Object.entries(this.#query).map(([key, value]) => [
        key,
        Array.isArray(value) ? [...value] : value,
      ]),
    );
  }

  public get range(): Range[] {
    if (typeof this.#range === "undefined") {
      this.#range = Range.fromString(this.headers.range);
    }
    return [...this.#range];
  }

  /** Whether the protocol is `https:` (see `protocol`) */
  public get secure(): boolean {
    return this.protocol === "https:";
  }

  /**
   * The URL of the request: the protocol of the connection (see `protocol`),
   * the authority of the request-target in absolute-form (otherwise of
   * `Host`), and the path and query of the request-target (RFC 9112, section
   * 3.2). A `400 Bad Request` error without a valid one.
   */
  public get URL(): URL {
    const target = this.url ?? "/";
    const { authority, rest } = BindenRequest.#split(target);
    const { path, query } =
      target === "*" && this.method === "OPTIONS"
        ? { path: "*", query: "" }
        : BindenRequest.#target(rest);
    const origin = this.#origin(authority);
    if (origin === null) {
      throw new BindenError(400);
    }
    const url = new URL(origin);
    // Set as a path: `//evil.test/x` is a path, not the authority of the URL
    url.pathname = path;
    url.search = query === "" ? "" : `?${query}`;
    return url;
  }

  /** What the trusted proxies tell about the client, found once */
  #resolve(): IProxyResult {
    this.#proxy ??= resolveProxy(
      this.socket.remoteAddress,
      checkTrustProxy(this.trust_proxy),
      this.headers,
      this.headersDistinct,
    );
    return this.#proxy;
  }

  /**
   * The protocol and the effective authority of the request (see `host`), or
   * `null` without an authority. A `BindenError` (400) for an invalid one (not
   * `uri-host [ ":" port ]`, e.g. with userinfo).
   */
  #origin(target: string | null): string | null {
    const authority = target ?? this.#resolve().host ?? this.headers.host;
    if (typeof authority === "undefined") {
      return null;
    } else if (!isAuthority(authority)) {
      throw new BindenError(400);
    }
    return `${this.protocol}//${authority}`;
  }

  /**
   * The authority of a request-target in absolute-form (`null` otherwise) and
   * the rest of it: a `BindenError` (400) for another scheme than `http` and
   * `https`, or an empty authority
   */
  static #split(target: string): { authority: string | null; rest: string } {
    const absolute =
      /^(?<scheme>[a-z][\d+.a-z-]*):\/\/(?<host>[^/?]*)(?<tail>.*)$/iu.exec(
        target,
      )?.groups;
    if (!absolute) {
      return { authority: null, rest: target };
    }
    const { scheme = "", host = "", tail = "" } = absolute;
    // The authority is then checked as `Host` (e.g. for userinfo)
    if (!["http", "https"].includes(scheme.toLowerCase()) || host === "") {
      throw new BindenError(400);
    }
    // An empty path is `/`
    return { authority: host, rest: tail.startsWith("/") ? tail : `/${tail}` };
  }

  /**
   * The path and the query of a request-target (without its authority), which
   * must be in origin-form, without a fragment, a backslash, an invalid
   * percent-encoding, or dot-segments (which the URL parser would remove, so
   * that the request would be routed to another path).
   */
  static #target(rest: string): { path: string; query: string } {
    if (
      !rest.startsWith("/") ||
      /[#\\]/u.test(rest) ||
      /%(?![\da-f]{2})/iu.test(rest)
    ) {
      throw new BindenError(400);
    }

    const index = rest.indexOf("?");
    const path = index === -1 ? rest : rest.slice(0, index);
    const query = index === -1 ? "" : rest.slice(index + 1);
    if (path.split("/").some((part) => /^(?:\.|%2e){1,2}$/iu.test(part))) {
      throw new BindenError(400);
    }
    return { path, query };
  }
}
