import { randomUUID } from "node:crypto";
import { IncomingMessage } from "node:http";
import { parse, type ParsedUrlQuery } from "node:querystring";
import { TLSSocket } from "node:tls";

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
  #content_encoding?: readonly ContentEncoding[];
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

  public get content_encoding(): ContentEncoding[] {
    if (!this.#content_encoding) {
      this.#content_encoding = ContentEncoding.fromString(
        this.headers["content-encoding"],
      );
    }
    return [...this.#content_encoding];
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
    const { forwarded } = this;
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

    const query: ParsedUrlQuery = {};

    for (const key in this.#query) {
      const value = this.#query[key];
      query[key] = Array.isArray(value) ? [...value] : value;
    }

    return query;
  }

  public get range(): Range[] {
    if (typeof this.#range === "undefined") {
      this.#range = Range.fromString(this.headers.range);
    }
    return [...this.#range];
  }

  public get secure(): boolean {
    return this.URL.protocol === "https:";
  }

  public get URL(): URL {
    const { protocol, url = "/", headers } = this;
    const { host = "" } = headers;
    return new URL(url, `${protocol}//${host}`);
  }
}
