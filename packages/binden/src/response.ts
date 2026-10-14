import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  type IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import ContentRange from "./headers/content-range.js";
import Cookie from "./headers/cookie.js";
import IfModifiedSince from "./headers/if-modified-since.js";
import { parseHttpDate } from "./headers/http-date.js";
import { split } from "./headers/list.js";
import Range from "./headers/range.js";
import { BindenRequest } from "./request.js";
import { isStatus } from "./status.js";

export const ct_json = "application/json";
export const ct_text = "text/plain";
export const ct_html = "text/html";
export const ct_form = "application/x-www-form-urlencoded";

export type IHeadersValue = number | string | readonly string[];

export type IHeaders = Record<string, IHeadersValue>;

export class BindenResponse<
  Request extends IncomingMessage = IncomingMessage,
> extends ServerResponse<Request> {
  #cookies?: Set<Cookie>;
  #started = false;

  public constructor(...args: [request: Request, options?: unknown]) {
    // node:http passes its options as well
    super(...(args as [Request]));
    // `Readable.pipe()` emits `pipe` on its destination synchronously
    this.once("pipe", () => {
      this.#started = true;
    });
  }

  public get cookies(): Set<Cookie> {
    if (!this.#cookies) {
      this.#cookies = new Set<Cookie>();
    }
    return this.#cookies;
  }

  /**
   * Whether the response has been started: by `.send()` or `.sendFile()`, by a
   * stream piped into it, or by its headers being sent
   */
  public get started(): boolean {
    return this.#started || this.headersSent || this.writableEnded;
  }

  /** Set the status code: an integer from 100 to 599 */
  public status(code: number): this {
    if (!isStatus(code)) {
      throw new TypeError(`Status code ${code} is invalid`);
    }
    this.statusCode = code;
    return this;
  }

  /** Set headers: the own properties of the object (not inherited ones) */
  public set(headers: IHeaders): this {
    for (const [name, value] of Object.entries(headers)) {
      this.setHeader(name, value);
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
      if (data instanceof Readable) {
        // Nothing of it will be sent: release it (e.g. its file)
        BindenResponse.#discard(data);
      }
      return Promise.resolve();
    }

    this.#started = true;

    if (!this.headersSent && this.cookies.size) {
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

    if (data instanceof Readable) {
      if (this.#bodiless()) {
        // Nothing of the source would be sent: it is not read at all
        BindenResponse.#discard(data);
        this.#frame(null);
        const done = this.#finished(() => false);
        this.end();
        return done;
      }
      return this.#pipe(data);
    }

    // Settles once the response has finished, or rejects when it is closed
    // before (e.g. the client went away)
    const done = this.#finished(() => false);

    if (typeof data === "undefined" || data === "" || this.destroyed) {
      // Without a body, `HEAD` keeps the length it may have been given
      this.#frame(this.req.method === "HEAD" ? null : 0);
      this.end();
      return done;
    }

    const body =
      data instanceof Buffer || typeof data === "string"
        ? data
        : data.toString();

    if (
      !this.headersSent &&
      typeof this.getHeader("Content-Type") === "undefined" &&
      (this.req.method === "HEAD" ||
        !BindenResponse.#noContent(this.statusCode))
    ) {
      this.setHeader("Content-Type", ct_text);
    }

    this.#frame(Buffer.byteLength(body, encoding));

    if (this.#bodiless()) {
      // The headers of the body (as for `GET`), but not the body itself
      this.end();
      return done;
    }

    // The body is written rather than passed to `end()`: a write that fails
    // (e.g. the client went away) rejects, although Node.js 24 emits `finish`
    // once the response is ended. Its length keeps it from being chunked.
    return new Promise<void>((resolve, reject) => {
      const written = (error?: Error | null): void => {
        if (error) {
          reject(error);
        }
      };
      if (typeof body === "string") {
        this.write(body, encoding ?? "utf8", written);
      } else {
        this.write(body, written);
      }
      this.end();
      done.then(resolve, reject);
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

  /** Send response as `text/plain` */
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
  /** A response without a body: to `HEAD`, or with a 1xx, 204, 205 or 304 status */
  #bodiless(): boolean {
    return (
      this.req.method === "HEAD" || BindenResponse.#noContent(this.statusCode)
    );
  }

  /** A status whose responses never have a body */
  static #noContent(status: number): boolean {
    return (
      (status >= 100 && status < 200) ||
      status === 204 ||
      status === 205 ||
      status === 304
    );
  }

  /**
   * Frames the response by its final status (RFC 9110, sections 8.6 and 15),
   * with the `length` of its body (`null` when it is not known): a stale
   * `Content-Length` or `Transfer-Encoding` (e.g. of a body that an error
   * replaced) would make the client wait for bytes that never come, or read
   * the next response of the connection as this body.
   */
  #frame(length: number | null): void {
    const { statusCode } = this;
    if (this.headersSent) {
      return;
    } else if (statusCode === 205) {
      // No content, framed as such (RFC 9110, section 15.3.6)
      this.removeHeader("Transfer-Encoding");
      this.setHeader("Content-Length", 0);
    } else if (BindenResponse.#noContent(statusCode)) {
      // Never a body, nor the length of one
      this.removeHeader("Content-Length");
      this.removeHeader("Transfer-Encoding");
    } else if (length !== null) {
      // Also for `HEAD`: the length of the body it would send
      this.removeHeader("Transfer-Encoding");
      this.setHeader("Content-Length", length);
    }
  }

  /**
   * Writes a `Readable` into the response (with backpressure) and settles like
   * `#finished()`. The client has the whole response (and may close the
   * connection) once the `Content-Length` bytes are flushed to the connection,
   * maybe before the source ends. The header is read when it is needed:
   * compression removes it.
   *
   * A source that fails, closes before its end, or does not have exactly its
   * `Content-Length` rejects. Nothing sent yet, the error can still be replied
   * (see `.started`); otherwise the response is destroyed, so that a truncated
   * body does not look complete, and more bytes are not read by the client as
   * the next response of the connection.
   */
  #pipe(data: Readable): Promise<void> {
    let flushed = 0;
    let sent = 0;
    const done = this.#finished(() => {
      const length = this.#length();
      return length !== null && flushed >= length;
    });
    return new Promise<void>((resolve, reject) => {
      // Once the response is closed, `#finished()` tells how it ended
      let closed = false;
      const fail = (error: Error): void => {
        if (sent === 0) {
          this.#started = false;
        } else {
          this.destroy();
        }
        reject(error);
      };
      this.once("close", () => {
        closed = true;
        // Releases the source (e.g. the file of `sendFile()`)
        if (!data.readableEnded) {
          data.destroy();
        }
      });
      data
        .on("data", (chunk: Uint8Array | string) => {
          try {
            const size = Buffer.byteLength(chunk);
            const length = this.#length();
            if (length !== null && sent + size > length) {
              data.destroy(BindenResponse.#mismatch(sent + size, length));
              return;
            }
            sent += size;
            const accepted = this.write(chunk, (error?: Error | null) => {
              if (error) {
                // Not delivered: the client went away (Node.js 24 may still
                // emit `finish` once the response is ended)
                data.destroy();
                reject(error);
              } else {
                flushed += size;
              }
            });
            if (!accepted) {
              data.pause();
              this.once("drain", () => {
                data.resume();
              });
            }
          } catch (error: unknown) {
            // Not a chunk of bytes (e.g. an object)
            data.destroy(error as Error);
          }
        })
        .once("end", () => {
          const length = this.#length();
          if (length !== null && sent < length) {
            fail(BindenResponse.#mismatch(sent, length));
          } else {
            this.end();
          }
        })
        // Every error (also one emitted while the source is destroyed later)
        .on("error", fail)
        .once("close", () => {
          // Destroyed without an error before its end
          if (!closed && !data.readableEnded && data.errored === null) {
            fail(BindenResponse.#premature());
          }
        });
      done.then(resolve, (error: Error) => {
        data.destroy();
        reject(error);
      });
    });
  }

  /** The `Content-Length` of the response, `null` without a valid one */
  #length(): number | null {
    const length = Number(this.getHeader("Content-Length") ?? Number.NaN);
    return Number.isSafeInteger(length) && length >= 0 ? length : null;
  }

  /** The error of a close before the end */
  static #premature(): Error {
    return Object.assign(new Error("Premature close"), {
      code: "ERR_STREAM_PREMATURE_CLOSE",
    });
  }

  /** The error of a body that does not have its `Content-Length` */
  static #mismatch(size: number, length: number): Error {
    const message = `The body (${size} bytes) does not match its Content-Length (${length} bytes)`;
    return Object.assign(new Error(message), {
      code: "ERR_HTTP_CONTENT_LENGTH_MISMATCH",
    });
  }

  /** Destroys a source that will not be sent, whose errors are no longer of interest */
  static #discard(source: Readable): void {
    source
      .on("error", () => {
        // E.g. its file failed to close: nobody waits for it
      })
      .destroy();
  }

  /**
   * Resolves when the response has finished (flushed to the connection), rejects
   * when it is closed before (e.g. the client went away), unless it is
   * `complete()` for the client already
   */
  #finished(complete: () => boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.destroyed) {
        reject(BindenResponse.#premature());
        return;
      }
      const listeners: [string, (error?: Error) => void][] = [];
      const settle = (error: Error | null): void => {
        for (const [event, listener] of listeners) {
          this.off(event, listener);
        }
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      listeners.push(
        [
          "finish",
          (): void => {
            settle(null);
          },
        ],
        [
          "close",
          (): void => {
            settle(complete() ? null : BindenResponse.#premature());
          },
        ],
        [
          "error",
          (error?: Error): void => {
            settle(error ?? BindenResponse.#premature());
          },
        ],
      );
      for (const [event, listener] of listeners) {
        this.once(event, listener);
      }
    });
  }

  /**
   * Sends a file. Its metadata and its content are read from one file handle,
   * so that they belong to the same file (also when the path is replaced), and
   * no more than its size is sent.
   */
  public async sendFile(path: URL | string): Promise<void> {
    // Started at once (see `.started`), unless it fails before sending anything
    this.#started = true;
    try {
      await this.#sendFile(path);
    } catch (error: unknown) {
      this.#started = false;
      throw error;
    }
  }

  async #sendFile(path: URL | string): Promise<void> {
    const url = path instanceof URL ? new URL(path.href) : pathToFileURL(path);

    if (url.protocol !== "file:") {
      throw new TypeError(`Protocol ${url.protocol} is not supported`);
    }

    // Without waiting for a writer of a FIFO (`O_NONBLOCK` is not defined on
    // Windows, which has no FIFOs)
    const handle = await open(url, constants.O_RDONLY | constants.O_NONBLOCK);
    // Closed by the stream of its content, or else here
    let stream: Readable | null = null;
    try {
      const stats = await handle.stat();

      if (!stats.isFile()) {
        throw new Error("Provided path does not correspond to a regular file");
      }

      const { mtime, size } = stats;
      // In seconds, as an HTTP-date, and not in the future (RFC 9110, section 8.8.2.1)
      const lm = new Date(
        Math.floor(Math.min(mtime.getTime(), Date.now()) / 1000) * 1000,
      );

      this.set({ "Last-Modified": lm.toUTCString(), "Accept-Ranges": "bytes" });

      const { method = "GET", headers } = this.req;
      const ims =
        this.req instanceof BindenRequest
          ? this.req.if_modified_since
          : IfModifiedSince.fromString(headers["if-modified-since"]);

      const failed = BindenResponse.#preconditions(
        headers,
        this.getHeader("ETag"),
        lm,
        method === "GET" || method === "HEAD",
        ims,
      );
      if (failed !== null) {
        await this.status(failed).send();
        return;
      } else if (method === "HEAD") {
        // The headers of the whole file, without reading it
        await this.setHeader("Content-Length", size).send();
        return;
      }

      // Ranges apply to GET only (RFC 9110, section 14.2)
      const ranges =
        method !== "GET" || !this.#ifRange(lm)
          ? []
          : this.req instanceof BindenRequest
            ? this.req.range
            : Range.fromString(headers.range);
      const range = BindenResponse.#range(ranges, size);

      if (range === "unsatisfiable") {
        const cr = new ContentRange({ size }).toString();
        await this.setHeader("Content-Range", cr).status(416).send();
        return;
      }

      if (range === null && size === 0) {
        await this.setHeader("Content-Length", 0).send();
        return;
      }

      // No more than the size that is sent as its length
      const { start, end } = range ?? { start: 0, end: size - 1 };
      stream = handle.createReadStream({ start, end });
      if (range === null) {
        await this.setHeader("Content-Length", size).send(stream);
        return;
      }
      const cr = new ContentRange({ size, start, end }).toString();
      await this.set({ "Content-Length": end - start + 1, "Content-Range": cr })
        .status(206)
        .send(stream);
    } finally {
      if (stream === null) {
        await handle.close();
      }
    }
  }

  /**
   * The status of a request whose precondition fails, in the order of RFC 9110
   * (section 13.2.2), or `null` when they pass: `If-Match` (or else
   * `If-Unmodified-Since`), then `If-None-Match` (or else `If-Modified-Since`,
   * for `GET` and `HEAD`), with the `ETag` set on the response
   */
  static #preconditions(
    headers: IncomingHttpHeaders,
    etag: unknown,
    lm: Date,
    read: boolean,
    ims: IfModifiedSince | null,
  ): 304 | 412 | null {
    const tag = typeof etag === "string" ? etag : null;
    const ifMatch = headers["if-match"];
    const ius = parseHttpDate(headers["if-unmodified-since"]?.trim() ?? "");
    const ifNoneMatch = headers["if-none-match"];
    if (typeof ifMatch === "string") {
      if (!BindenResponse.#matches(ifMatch, tag, true)) {
        return 412;
      }
    } else if (ius !== null && lm > ius) {
      return 412;
    }
    if (typeof ifNoneMatch === "string") {
      if (BindenResponse.#matches(ifNoneMatch, tag, false)) {
        return read ? 304 : 412;
      }
    } else if (read && ims !== null && lm <= ims.date) {
      return 304;
    }
    return null;
  }

  /**
   * Whether a list of entity-tags (or `*`, as the file exists) matches the
   * `ETag` of the response, by the strong or the weak comparison (RFC 9110,
   * section 8.8.3.2)
   */
  static #matches(list: string, etag: string | null, strong: boolean): boolean {
    if (list.trim() === "*") {
      return true;
    } else if (etag === null || (strong && etag.startsWith("W/"))) {
      return false;
    }
    const opaque = etag.replace(/^W\//u, "");
    return split(list, ",").some((value) => {
      const tag = value.trim();
      return strong ? tag === etag : tag.replace(/^W\//u, "") === opaque;
    });
  }

  /** Whether `If-Range`, when sent, matches the file (RFC 9110, section 13.1.5) */
  #ifRange(lm: Date): boolean {
    const raw = this.req.headers["if-range"];
    // Sent more than once, it is invalid: it does not match
    const value = typeof raw === "string" ? raw.trim() : "";
    if (typeof raw === "undefined") {
      return true;
    } else if (value.startsWith(`"`) || value.startsWith("W/")) {
      // An entity-tag matches a strong `ETag` of the response only
      const etag = this.getHeader("ETag");
      return etag === value && !value.startsWith("W/");
    }
    // An HTTP-date matches the `Last-Modified` exactly, when it is a strong
    // validator: at least a second before now (RFC 9110, section 8.8.2.2)
    const now = Math.floor(Date.now() / 1000) * 1000;
    return (
      parseHttpDate(value)?.getTime() === lm.getTime() &&
      now - lm.getTime() >= 1000
    );
  }

  /**
   * The byte range of a file to send: `null` for the whole file (without a
   * range, or with several distinct ones: `multipart/byteranges` is not
   * supported), or `"unsatisfiable"` (RFC 9110, section 14.1.1)
   */
  static #range(
    ranges: readonly Range[],
    size: number,
  ): { start: number; end: number } | "unsatisfiable" | null {
    if (ranges.length === 0) {
      return null;
    }

    const satisfiable = ranges
      .flatMap(({ start, end }): [number, number][] => {
        if (start === null) {
          // A suffix: the last `end` bytes
          return end !== null && end > 0 && size > 0
            ? [[Math.max(0, size - end), size - 1]]
            : [];
        }
        return start < size ? [[start, Math.min(end ?? size, size - 1)]] : [];
      })
      .sort(([a], [b]) => a - b);
    const [first, ...rest] = satisfiable;

    if (typeof first === "undefined") {
      return "unsatisfiable";
    }

    // Overlapping or adjacent ranges are one range
    const [start] = first;
    let [, end] = first;
    for (const [nextStart, nextEnd] of rest) {
      if (nextStart > end + 1) {
        return null;
      }
      end = Math.max(end, nextEnd);
    }

    return start === 0 && end === size - 1 ? null : { start, end };
  }
}
