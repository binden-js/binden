import { randomUUID } from "node:crypto";
import { IncomingMessage } from "node:http";
import { parse, type ParsedUrlQuery } from "node:querystring";
import { TLSSocket } from "node:tls";

import { BindenError } from "./error.js";
import AcceptEncoding from "./headers/accept-encoding.js";
import Authorization from "./headers/authorization.js";
import ContentEncoding from "./headers/content-encoding.js";
import ContentType from "./headers/content-type.js";
import Cookie from "./headers/cookie.js";
import Forwarded from "./headers/forwarded.js";
import IfModifiedSince from "./headers/if-modified-since.js";
import Range from "./headers/range.js";

export type IProtocol = "http:" | "https:";

/**
 * The proxies in front of the server that are trusted: none (`false`), all of
 * them (`true`) or the given number of the nearest ones
 */
export type ITrustProxy = boolean | number;

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
  #range?: readonly Range[];
  #query?: ParsedUrlQuery;

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
   * The protocol of the connection or, from trusted proxies (see
   * `trust_proxy`), the one of the `Forwarded` element of the outermost of them
   */
  public get protocol(): IProtocol {
    const tls: IProtocol =
      this.socket instanceof TLSSocket ? "https:" : "http:";
    const trust = this.trust_proxy;
    // In their positions: an element that is not valid is not skipped
    const forwarded = Forwarded.parse(this.headers.forwarded);
    if (trust === false || trust === 0 || forwarded.length === 0) {
      return tls;
    }
    // Every proxy appends its element: the client controls the leftmost ones
    const index = trust === true ? 0 : Math.max(0, forwarded.length - trust);
    const proto = forwarded[index]?.proto?.toLowerCase();
    return proto === "https" ? "https:" : proto === "http" ? "http:" : tls;
  }

  /**
   * The proxies whose `Forwarded` elements are trusted (none by default).
   * `Binden` sets it from its `trust_proxy` option; with `http.createServer()`,
   * override it in a subclass.
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
    const { authority, path, query } = BindenRequest.#target(
      this.url ?? "/",
      this.method ?? "GET",
    );
    const host = authority ?? this.headers.host ?? "";
    const base = `${this.protocol}//${host}`;
    // `uri-host [ ":" port ]`: nothing that ends the authority, nor userinfo
    if (/[\s/?#@\\]/u.test(host) || !URL.canParse(base)) {
      throw new BindenError(400);
    }
    const url = new URL(base);
    // Set as a path: `//evil.test/x` is a path, not the authority of the URL
    url.pathname = path;
    url.search = query === "" ? "" : `?${query}`;
    return url;
  }

  /**
   * The authority (of the absolute-form), the path and the query of a
   * request-target, which must be in origin-form (or absolute-form with `http`
   * or `https`, or `*` for `OPTIONS`), without a fragment, a backslash, an
   * invalid percent-encoding, or dot-segments (which the URL parser would
   * remove, so that the request would be routed to another path).
   */
  static #target(
    target: string,
    method: string,
  ): { authority: string | null; path: string; query: string } {
    if (target === "*" && method === "OPTIONS") {
      return { authority: null, path: "*", query: "" };
    }

    let authority: string | null = null;
    let rest = target;
    const absolute =
      /^(?<scheme>[a-z][\d+.a-z-]*):\/\/(?<host>[^/?]*)(?<tail>.*)$/iu.exec(
        target,
      )?.groups;
    if (absolute) {
      const { scheme = "", host = "", tail = "" } = absolute;
      // The authority is then checked as `Host` (e.g. for userinfo)
      if (!["http", "https"].includes(scheme.toLowerCase()) || host === "") {
        throw new BindenError(400);
      }
      authority = host;
      // An empty path is `/`
      rest = tail.startsWith("/") ? tail : `/${tail}`;
    }

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
    return { authority, path, query };
  }
}
