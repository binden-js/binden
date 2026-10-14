import {
  IncomingMessage,
  type OutgoingHttpHeader,
  type OutgoingHttpHeaders,
  ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import ContentType from "./headers/content-type.js";
import Cookie, { type ICookie } from "./headers/cookie.js";
import { type ISendFileOptions, sendFileTo } from "./send-file.js";
import { isStatus } from "./status.js";

export const ct_json = "application/json";
export const ct_text = "text/plain";
export const ct_html = "text/html";
export const ct_form = "application/x-www-form-urlencoded";

export type IHeadersValue = number | string | readonly string[];

export type IHeaders = Record<string, IHeadersValue>;

/** The attributes of a cookie to remove (see `BindenResponse.clearCookie()`) */
export type IClearCookie = Pick<
  ICookie,
  "domain" | "partitioned" | "path" | "same_site" | "secure"
>;

/** The characters of `attr-char` (RFC 8187, section 3.2.1) */
const attrChar = /^[\w!#$&+.^`|~-]$/u;

/**
 * The `Content-Disposition` of an attachment (RFC 6266): an ASCII `filename`
 * (other characters replaced with `_`) and the UTF-8 `filename*` (RFC 8187)
 */
function contentDisposition(filename?: string): string {
  if (typeof filename === "undefined") {
    return "attachment";
  } else if (
    typeof filename !== "string" ||
    filename === "" ||
    !filename.isWellFormed()
  ) {
    throw new TypeError("The filename is not a non-empty well-formed string");
  }
  const ascii = filename.replaceAll(/[^\x20-\x7E]|["\\]/gu, "_");
  const encoded = [...new TextEncoder().encode(filename)]
    .map((byte) => {
      const char = String.fromCharCode(byte);
      return attrChar.test(char)
        ? char
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** A header field name (a token, RFC 9110, section 5.6.2) */
const fieldName = /^[!#$%&'*+\-.^_`|~\dA-Za-z]+$/u;

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

  /**
   * The cookies to send: they are added to the `Set-Cookie` header (after the
   * values that it has) once, when the headers are sent
   */
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

  /** Set the `Content-Type`: a media type with its parameters (a `TypeError` otherwise) */
  public type(media_type: string): this {
    const parsed = ContentType.fromString(media_type);
    if (parsed === null) {
      throw new TypeError(`Invalid media type: ${media_type}`);
    }
    return this.setHeader("Content-Type", parsed.toString());
  }

  /**
   * Send the response as an attachment (`Content-Disposition`), with the name
   * to save it as: in ASCII (`filename`) and in UTF-8 (`filename*`, RFC 8187)
   */
  public attachment(filename?: string): this {
    return this.setHeader("Content-Disposition", contentDisposition(filename));
  }

  /**
   * Add the names of request headers that select the response to `Vary`
   * (once each, case-insensitively); `*` replaces them all
   */
  public vary(...fields: string[]): this {
    for (const field of fields) {
      if (!fieldName.test(field)) {
        throw new TypeError(`Invalid field name: ${field}`);
      }
    }
    const raw = this.getHeader("Vary");
    const values = (Array.isArray(raw) ? raw : [`${raw ?? ""}`])
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter((value) => value !== "");
    const names = new Set(values.map((value) => value.toLowerCase()));
    if (names.has("*")) {
      return this;
    } else if (fields.includes("*")) {
      return this.setHeader("Vary", "*");
    }
    for (const field of fields) {
      if (!names.has(field.toLowerCase())) {
        names.add(field.toLowerCase());
        values.push(field);
      }
    }
    return values.length === 0
      ? this
      : this.setHeader("Vary", values.join(", "));
  }

  /**
   * Remove a cookie from the client: an empty value that expires at once,
   * with the attributes (`domain`, `path`, …) of the cookie to remove. It
   * replaces a cookie of the same name, domain and path set on the response.
   */
  public clearCookie(name: string, attributes: IClearCookie = {}): this {
    const cookie = new Cookie({
      ...attributes,
      key: name,
      value: "",
      max_age: 0,
    });
    for (const other of this.cookies) {
      if (
        other.key === cookie.key &&
        other.domain === cookie.domain &&
        other.path === cookie.path
      ) {
        this.cookies.delete(other);
      }
    }
    this.cookies.add(cookie);
    return this;
  }

  /**
   * Sends the headers (with the cookies of `.cookies`, added once to the
   * `Set-Cookie` header: after the values given here or else set before) by
   * every path: explicitly, or by the first `write()`, `end()`,
   * `flushHeaders()` or piped chunk
   */
  public override writeHead(
    statusCode: number,
    statusMessage?: string,
    headers?: OutgoingHttpHeader[] | OutgoingHttpHeaders,
  ): this;
  public override writeHead(
    statusCode: number,
    headers?: OutgoingHttpHeader[] | OutgoingHttpHeaders,
  ): this;
  public override writeHead(
    statusCode: number,
    reason?: OutgoingHttpHeader[] | OutgoingHttpHeaders | string,
    headers?: OutgoingHttpHeader[] | OutgoingHttpHeaders,
  ): this {
    // As `writeHead()` of Node.js: the headers follow a reason phrase, or are
    // the second argument
    const given = typeof reason === "string" ? headers : (headers ?? reason);
    const write = (
      fields: OutgoingHttpHeader[] | OutgoingHttpHeaders | undefined,
    ): this => {
      if (typeof reason === "string") {
        return super.writeHead(statusCode, reason, fields);
      }
      return super.writeHead(statusCode, fields);
    };
    if (this.headersSent || this.cookies.size === 0) {
      return write(given);
    }

    const previous = this.getHeader("Set-Cookie");
    const [explicit, rest] = BindenResponse.#takeSetCookie(given);
    const values = [...this.cookies].map((cookie) => cookie.toString());
    this.setHeader("Set-Cookie", [
      ...(explicit ?? BindenResponse.#values(previous)),
      ...values,
    ]);
    try {
      return write(rest);
    } catch (error: unknown) {
      // Not sent (e.g. an invalid status code): the next attempt adds them
      if (typeof previous === "undefined") {
        this.removeHeader("Set-Cookie");
      } else {
        this.setHeader("Set-Cookie", previous);
      }
      throw error;
    }
  }

  /**
   * The `Set-Cookie` values of the headers given to `writeHead()` (`null`
   * without one), and the other headers. Nested pairs (`[[name, value]]`) are
   * flattened, as the headers set before are merged with them.
   */
  static #takeSetCookie(
    headers: OutgoingHttpHeader[] | OutgoingHttpHeaders | undefined,
  ): [string[] | null, OutgoingHttpHeader[] | OutgoingHttpHeaders | undefined] {
    let explicit: string[] | null = null;
    const take = (
      name: OutgoingHttpHeader,
      value: OutgoingHttpHeader | undefined,
    ): boolean => {
      if (typeof name === "string" && name.toLowerCase() === "set-cookie") {
        explicit = [...(explicit ?? []), ...BindenResponse.#values(value)];
        return true;
      }
      return false;
    };
    if (Array.isArray(headers)) {
      const flat = Array.isArray(headers[0]) ? headers.flat() : headers;
      const rest: OutgoingHttpHeader[] = [];
      for (let index = 0; index < flat.length; index += 2) {
        const [name, value] = flat.slice(index, index + 2) as [
          OutgoingHttpHeader,
          OutgoingHttpHeader,
        ];
        if (!take(name, value)) {
          rest.push(name, value);
        }
      }
      return [explicit, rest];
    } else if (headers) {
      const rest: OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(headers)) {
        if (!take(name, value)) {
          rest[name] = value;
        }
      }
      return [explicit, rest];
    }
    return [null, headers];
  }

  /** The values of a header as strings */
  static #values(value: OutgoingHttpHeader | undefined): string[] {
    return Array.isArray(value)
      ? value.map(String)
      : typeof value === "undefined"
        ? []
        : [String(value)];
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
    } else if (
      typeof encoding !== "undefined" &&
      !Buffer.isEncoding(encoding)
    ) {
      return Promise.reject(
        new TypeError(`Unknown encoding: ${String(encoding)}`),
      );
    }

    this.#started = true;

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

  /**
   * Send a JSON value as `application/json`. A value that has no JSON text
   * (`undefined`, a function or a symbol), a `bigint` or a cyclic value
   * rejects with a `TypeError` before the response is started, as does a
   * custom `stringify` that does not return a string.
   */
  public async json<T = unknown>(
    data: T,
    stringify?: (data: T) => string,
  ): Promise<void> {
    const type = typeof data;
    if (
      type === "undefined" ||
      type === "function" ||
      type === "symbol" ||
      type === "bigint"
    ) {
      throw new TypeError(`A ${type} is not a JSON value`);
    }
    const body: unknown =
      typeof stringify === "undefined" ? JSON.stringify(data) : stringify(data);
    if (typeof body !== "string") {
      throw new TypeError("The JSON text is not a string");
    }
    await this.setHeader("Content-Type", ct_json).send(body);
  }

  /** Send response as `text/plain; charset=utf-8` */
  public text(data: string): Promise<void> {
    return this.setHeader("Content-Type", `${ct_text}; charset=utf-8`).send(
      data,
    );
  }

  /** Send response as `text/html; charset=utf-8` */
  public html(data: string): Promise<void> {
    return this.setHeader("Content-Type", `${ct_html}; charset=utf-8`).send(
      data,
    );
  }

  /** Send response as `application/x-www-form-urlencoded` */
  public form(params: URLSearchParams): Promise<void> {
    return this.setHeader("Content-Type", ct_form).send(params.toString());
  }

  /**
   * Send the headers, then resolve once what has been written so far is
   * flushed to the connection; rejects when the response is closed before
   * (e.g. the client went away). `@binden/compression` replaces it to flush
   * the compressor as well.
   */
  public flush(): Promise<void> {
    if (this.writableFinished) {
      return Promise.resolve();
    } else if (this.writableEnded || this.destroyed) {
      return this.#finished(() => false);
    }
    return new Promise<void>((resolve, reject) => {
      const fail = (error?: Error): void => {
        this.off("close", fail).off("error", fail);
        reject(error ?? BindenResponse.#premature());
      };
      this.once("close", fail).once("error", fail);
      this.flushHeaders();
      // Its callback runs once the writes before it are flushed
      this.write("", (error?: Error | null) => {
        this.off("close", fail).off("error", fail);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

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
   * Send a file: a filesystem path (or a `file:` URL), trusted without `root`;
   * with `root`, a relative path that must stay inside it (see
   * `ISendFileOptions`). Its metadata and its content are read from one file
   * handle, and no more than its size is sent.
   */
  public async sendFile(
    path: URL | string,
    options?: ISendFileOptions,
  ): Promise<void> {
    // Started at once (see `.started`), unless it fails before sending anything
    this.#started = true;
    try {
      await sendFileTo(this, path, options);
    } catch (error: unknown) {
      this.#started = false;
      throw error;
    }
  }
}
