import { IncomingMessage } from "http";
import { parse, ParsedUrlQuery } from "querystring";
import { TLSSocket } from "tls";

import type { Cookie } from "./headers/cookie.js";
import { Forwarded } from "./headers/forwarded.js";

export type IProtocol = "http" | "https";

export class KauaiRequest extends IncomingMessage {
  #body?: unknown;
  #cookies?: readonly Cookie[];
  #forwarded?: readonly Forwarded[];
  #query?: ParsedUrlQuery;

  public get body(): unknown {
    return this.#body;
  }

  public set body(body: unknown) {
    if (typeof this.#body === "undefined") {
      this.#body = body;
    }
  }

  public get cookies(): readonly Cookie[] | undefined {
    return this.#cookies ? [...this.#cookies] : this.#cookies;
  }

  public set cookies(cookies: readonly Cookie[] | undefined) {
    if (!this.#cookies && cookies) {
      this.#cookies = [...cookies];
    }
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

  public get protocol(): IProtocol {
    return (!this.forwarded?.length && this.socket instanceof TLSSocket) ||
      (this.forwarded?.length &&
        this.forwarded[0]?.proto?.toLowerCase() === "https")
      ? "https"
      : "http";
  }

  public get query(): ParsedUrlQuery {
    if (!this.#query) {
      this.#query = { ...parse(this.URL.search.substring(1)) };
    }

    const query = this.#query;

    return Object.keys(query).reduce((acc, key) => {
      const value = query[key];
      return { ...acc, [key]: Array.isArray(value) ? [...value] : value };
    }, {});
  }

  public get secure(): boolean {
    return this.protocol === "https";
  }

  public get URL(): URL {
    const {
      protocol,
      url = "/",
      headers: { host = "" },
    } = this;
    return new URL(url, `${protocol}://${host}`);
  }
}

export default KauaiRequest;
