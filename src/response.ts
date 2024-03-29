import { createReadStream, Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { IncomingMessage, ServerResponse, STATUS_CODES } from "node:http";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import ContentRange from "./headers/content-range.js";
import Cookie from "./headers/cookie.js";
import IfModifiedSince from "./headers/if-modified-since.js";
import Range from "./headers/range.js";
import { BindenRequest } from "./request.js";

export const ct_json = "application/json";
export const ct_text = "plain/text";
export const ct_html = "text/html";
export const ct_form = "application/x-www-form-urlencoded";

export type IHeadersValue = number | string | readonly string[];

export type IHeaders = Record<string, IHeadersValue>;

export class BindenResponse<
  Request extends IncomingMessage = IncomingMessage,
> extends ServerResponse<Request> {
  #cookies?: Set<Cookie>;

  public get cookies(): Set<Cookie> {
    if (!this.#cookies) {
      this.#cookies = new Set<Cookie>();
    }
    return this.#cookies;
  }

  /** Set the status code */
  public status(code: number): this {
    if (typeof STATUS_CODES[code] === "undefined") {
      throw new TypeError(`Status code ${code} is invalid`);
    }
    this.statusCode = code;
    return this;
  }

  /** Set headers */
  public set(headers: IHeaders): this {
    for (const name in headers) {
      this.setHeader(name, headers[name]);
    }
    return this;
  }

  /** Send a response */
  public send(
    data?: Buffer | Readable | bigint | number | string,
  ): Promise<void>;
  public send(data: string, encoding: BufferEncoding): Promise<void>;
  public send(
    data?: Buffer | Readable | bigint | number | string,
    encoding?: BufferEncoding,
  ): Promise<void> {
    if (this.writableEnded) {
      return Promise.resolve();
    } else if (!this.headersSent && this.cookies.size) {
      const setCookie = this.getHeader("Set-Cookie");
      const values = [...this.cookies].map((c) => c.toString());

      this.setHeader(
        "Set-Cookie",
        typeof setCookie === "undefined"
          ? values
          : Array.isArray(setCookie)
            ? [...setCookie, ...values]
            : [`${setCookie}`, ...values],
      );
    }

    if (typeof data === "undefined" || data === "") {
      return new Promise<void>((resolve) => {
        this.end(resolve);
      });
    } else if (data instanceof Readable) {
      return new Promise<void>((resolve, reject) => {
        data.once("error", reject).once("end", resolve).pipe(this);
      });
    }

    if (
      !this.headersSent &&
      typeof this.getHeader("Content-Type") === "undefined"
    ) {
      this.setHeader("Content-Type", ct_text);
    }

    if (typeof data === "string" && encoding) {
      return new Promise<void>((resolve) => {
        this.end(data, encoding, resolve);
      });
    } else if (data instanceof Buffer || typeof data === "string") {
      return new Promise<void>((resolve) => {
        this.end(data, resolve);
      });
    }

    return new Promise<void>((resolve) => {
      this.end(data.toString(), resolve);
    });
  }

  /** Send response as `application/json` */
  public async json(
    data: Record<string, unknown> | unknown[],
    stringify = (input: Record<string, unknown> | unknown[]): string =>
      JSON.stringify(input),
  ): Promise<void> {
    const msg = stringify(data);
    return this.setHeader("Content-Type", ct_json).send(msg);
  }

  /** Send response as `plain/text` */
  public text(data: string): Promise<void> {
    return this.setHeader("Content-Type", ct_text).send(data);
  }

  /** Send response as `text/html` */
  public html(data: string): Promise<void> {
    return this.setHeader("Content-Type", ct_html).send(data);
  }

  /** Send response as `application/x-www-form-urlencoded` */
  public form(params: URLSearchParams): Promise<void> {
    return this.setHeader("Content-Type", ct_form).send(params.toString());
  }

  /** Send a file */
  public async sendFile(
    path: URL | string,
    options?: Pick<Stats, "isFile" | "mtime" | "size">,
  ): Promise<void> {
    const url = path instanceof URL ? new URL(path.href) : pathToFileURL(path);

    if (url.protocol !== "file:") {
      throw new TypeError(`Protocol ${url.protocol} is not supported`);
    }

    const stats = options ?? (await stat(path));

    if (!stats.isFile()) {
      throw new Error(`Provided path does not correspond to a regular file`);
    }

    const { mtime, size } = stats;
    const lm = new Date(mtime.toUTCString());

    this.set({ "Last-Modified": lm.toUTCString(), "Accept-Ranges": "bytes" });

    const ims =
      this.req instanceof BindenRequest
        ? this.req.if_modified_since
        : IfModifiedSince.fromString(this.req.headers["if-modified-since"]);

    const { method = "GET" } = this.req;

    if ((method === "GET" || method === "HEAD") && ims && ims.date >= lm) {
      return this.status(304).send();
    }

    const range =
      this.req instanceof BindenRequest
        ? this.req.range.shift()
        : Range.fromString(this.req.headers.range).shift();

    const ifRange = new Date((this.req.headers["if-range"] ?? "") as string);

    if (!range || ifRange < lm) {
      const stream = createReadStream(url);
      return this.setHeader("Content-Length", size).send(stream);
    } else if (typeof range.start === "number" && range.start >= size) {
      const cr = new ContentRange({ size }).toString();
      return this.setHeader("Content-Range", cr).status(416).send();
    }

    const opts = { start: range.start ?? 0, end: size - 1 };

    if (typeof range.end === "number") {
      if (typeof range.start !== "number") {
        const suffix = size - range.end;
        opts.start = suffix < 0 ? 0 : suffix;
      } else if (range.end < opts.end) {
        opts.end = range.end;
      }
    }

    const { start, end } = opts;
    const cl = end - start + 1;

    this.setHeader("Content-Length", cl);

    if (cl === size) {
      const stream = createReadStream(url);
      return this.send(stream);
    }

    const stream = createReadStream(url, { start, end });
    const cr = new ContentRange({ size, start, end }).toString();
    return this.setHeader("Content-Range", cr).status(206).send(stream);
  }
}
