import { randomUUID } from "crypto";
import { IncomingMessage } from "http";
import { parse, ParsedUrlQuery } from "querystring";
import { TLSSocket } from "tls";

import AcceptEncoding from "./headers/accept-encoding.js";
import Authorization from "./headers/authorization.js";
import ContentEncoding from "./headers/content-encoding.js";
import ContentType from "./headers/content-type.js";
import Cookie from "./headers/cookie.js";
import Forwarded from "./headers/forwarded.js";
import IfModifiedSince from "./headers/if-modified-since.js";
import Range from "./headers/range.js";

export type IProtocol = "http:" | "https:";

export class KauaiRequest extends IncomingMessage {
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
        this.headers["content-encoding"]
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

  public header(name: string): string | string[] | undefined {
    return this.headers[name.toLowerCase()];
  }

  public get id(): string {
    if (!this.#id) {
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

  public get protocol(): IProtocol {
    const forwarded = this.forwarded.shift();
    return (!forwarded && this.socket instanceof TLSSocket) ||
      forwarded?.proto?.toLowerCase() === "https"
      ? "https:"
      : "http:";
  }

  public get query(): ParsedUrlQuery {
    if (!this.#query) {
      this.#query = { ...parse(this.URL.search.substring(1)) };
    }

    const query = this.#query;

    return Object.keys(query).reduce<ParsedUrlQuery>((acc, key) => {
      const value = query[key];
      return { ...acc, [key]: Array.isArray(value) ? [...value] : value };
    }, {});
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

export default KauaiRequest;
