import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { ServerResponse, STATUS_CODES } from "http";
import { Readable } from "stream";
import { pathToFileURL } from "url";
import ContentRange from "./headers/content-range.js";
import Cookie from "./headers/cookie.js";
import IfModifiedSince from "./headers/if-modified-since.js";
import Range from "./headers/range.js";
import KauaiRequest from "./request.js";

export const ct_json = "application/json";
export const ct_text = "plain/text";
export const ct_html = "text/html";
export const ct_form = "application/x-www-form-urlencoded";

type IHeaders = Record<string, string | number | readonly string[]>;

export class KauaiResponse extends ServerResponse {
  #cookies?: Set<Cookie>;

  public get cookies(): Set<Cookie> {
    if (!this.#cookies) {
      this.#cookies = new Set<Cookie>();
    }
    return this.#cookies;
  }

  /** Set the status code */
  public status(code: number): this {
    if (!STATUS_CODES[code]) {
      throw new TypeError(`Status code ${code} is invalid`);
    }

    this.statusCode = code;
    return this;
  }

  /** Set headers */
  public set(headers: IHeaders): this {
    for (const name in headers) {
      const value = headers[name];
      this.setHeader(
        name,
        typeof value === "string" || typeof value === "number"
          ? value
          : [...value]
      );
    }

    return this;
  }

  /** Send a response */
  public send(
    data?: string | number | Buffer | bigint | Readable
  ): Promise<void>;
  public send(data: string, encoding: BufferEncoding): Promise<void>;
  public send(
    data?: string | number | Buffer | bigint | Readable,
    encoding?: BufferEncoding
  ): Promise<void> {
    if (this.writableEnded) {
      return Promise.resolve();
    } else if (!this.headersSent && this.cookies?.size) {
      const setCookie = this.getHeader("Set-Cookie");
      const values = [...this.cookies].map((c) => c.toString());

      this.setHeader(
        "Set-Cookie",
        !setCookie
          ? values
          : Array.isArray(setCookie)
          ? [...setCookie, ...values]
          : [`${setCookie}`, ...values]
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

    if (!this.headersSent && !this.getHeader("Content-Type")) {
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
      this.end(data?.toString(), resolve);
    });
  }

  /** Send response as `application/json` */
  public async json(data: Record<string, unknown>): Promise<void> {
    const msg = JSON.stringify(data);
    await this.set({ "Content-Type": ct_json }).send(msg);
  }

  /** Send response as `plain/text` */
  public text(data: string): Promise<void> {
    return this.set({ "Content-Type": ct_text }).send(data);
  }

  /** Send response as `text/html` */
  public html(data: string): Promise<void> {
    return this.set({ "Content-Type": ct_html }).send(data);
  }

  /** Send response as `application/x-www-form-urlencoded` */
  public form(params: URLSearchParams): Promise<void> {
    return this.set({ "Content-Type": ct_form }).send(params.toString());
  }

  /** Send a file */
  public async sendFile(path: URL | string): Promise<void> {
    const url = path instanceof URL ? new URL(path.href) : pathToFileURL(path);

    if (url.protocol !== "file:") {
      throw new TypeError(`Protocol ${url.protocol} is not supported`);
    }

    const stats = await stat(url);

    if (!stats.isFile()) {
      throw new Error(`Provided path does not correspond to a regular file`);
    }

    const { mtime, size } = stats;
    const lm = new Date(mtime.toUTCString());

    this.set({ "Last-Modified": lm.toUTCString(), "Accept-Ranges": "bytes" });

    const ims =
      this.req instanceof KauaiRequest
        ? this.req.if_modified_since
        : IfModifiedSince.fromString(this.req.headers["if-modified-since"]);

    const { method = "GET" } = this.req;

    if ((method === "GET" || method === "HEAD") && ims && ims.date >= lm) {
      return this.status(304).send();
    }

    const range =
      this.req instanceof KauaiRequest
        ? this.req.range.shift()
        : Range.fromString(this.req.headers.range).shift();

    const ifRange = new Date((this.req.headers["if-range"] ?? "") as string);

    if (!range || ifRange < lm) {
      const stream = createReadStream(url);
      return this.setHeader("Content-Length", size).status(200).send(stream);
    } else if (typeof range.start !== "undefined" && range.start >= size) {
      const cr = new ContentRange({ size }).toString();
      return this.setHeader("Content-Range", cr).status(416).send();
    }

    const opts = { start: range?.start ?? 0, end: size - 1 };

    if (typeof range?.end !== "undefined") {
      if (typeof range.start === "undefined") {
        const suffix = size - range.end;
        opts.start = suffix < 0 ? 0 : suffix;
      } else if (range.end < opts.end) {
        opts.end = range.end;
      }
    }

    const { start, end } = opts;

    if (end - start + 1 === size) {
      const stream = createReadStream(url);
      return this.setHeader("Content-Length", size).status(200).send(stream);
    }

    const stream = createReadStream(url, { start, end });
    const cr = new ContentRange({ size, start, end }).toString();
    return this.status(206)
      .setHeader("Content-Range", cr)
      .setHeader("Content-Length", `${end - start + 1}`)
      .send(stream);
  }
}

export default KauaiResponse;
