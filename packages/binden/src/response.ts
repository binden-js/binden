import Cookie, { type ICookie } from "./headers/cookie.js";
import {
  type IRedirectOptions,
  type IRedirectStatus,
  isRedirectStatus,
  redirectLocation,
} from "./redirect.js";
import {
  type IRepresentation,
  type IRepresentationNegotiator,
  type IResponseOperation,
  kCancel,
  kFramework,
  kNegotiator,
  kOperation,
  kRepresentation,
  kSeal,
  owners,
} from "./seal.js";
import {
  type ISendFileOptions,
  preconditionsOf,
  sendFileTo,
  tagOf,
} from "./send-file.js";
import {
  IncomingMessage,
  type OutgoingHttpHeader,
  type OutgoingHttpHeaders,
  ServerResponse,
} from "node:http";
import { BindenRequest } from "./request.js";
import ContentType from "./headers/content-type.js";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { isStatus } from "./status.js";
import { parseHttpDate } from "./headers/http-date.js";

/** The media type of `response.json()` */
export const ct_json = "application/json";
/** The media type of `response.text()` (sent with `charset=utf-8`) */
export const ct_text = "text/plain";
/** The media type of `response.html()` (sent with `charset=utf-8`) */
export const ct_html = "text/html";
/** The media type of `response.form()` */
export const ct_form = "application/x-www-form-urlencoded";

/** The value of a header: a number, a string, or the strings of its lines */
export type IHeadersValue = number | string | readonly string[];

/** Headers by name */
export type IHeaders = Record<string, IHeadersValue>;

/** The options of the responses of an application (`Binden` sets them) */
export interface IResponseOptions {
  /**
   * A strong `ETag` (the SHA-256 of the body) for the `200` responses to `GET`
   * and `HEAD` sent from a `Buffer` or a string, and `304 Not Modified` when
   * `If-None-Match` matches it
   */
  readonly etag: boolean;
}

/** The attributes of a cookie to remove (see `BindenResponse.clearCookie()`) */
export type IClearCookie = Pick<
  ICookie,
  "domain" | "partitioned" | "path" | "same_site" | "secure"
>;

/**
 * Validates the options of the responses (`etag` is `false` by default): a
 * `TypeError` for an invalid one
 */
export function validateResponseOptions({
  etag = false,
}: { readonly etag?: boolean | undefined } = {}): Readonly<IResponseOptions> {
  if (typeof etag !== "boolean") {
    throw new TypeError("`etag` is not a boolean");
  }
  return Object.freeze({ etag });
}

const defaults = validateResponseOptions();

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

/** A token (RFC 9110, section 5.6.2) */
const token = "[!#$%&'*+\\-.^_`|~\\dA-Za-z]+";

/** A quoted string (RFC 9110, section 5.6.4) */
const quoted =
  '"(?:[\\t \\x21\\x23-\\x5B\\x5D-\\x7E\\x80-\\xFF]|\\\\[\\t \\x21-\\x7E\\x80-\\xFF])*"';

/**
 * A media type whose parameters are each a token with a token or a quoted
 * string as value (RFC 9110, section 8.3.1), with optional whitespace
 */
const strictMediaType = new RegExp(
  `^[\\t ]*${token}/${token}(?:[\\t ]*;[\\t ]*(?:${token}=(?:${token}|${quoted}))?)*[\\t ]*$`,
  "u",
);

/** Without `[kSeal]()`, nothing may mutate a sealed response */
const never = (): boolean => false;

/** The representation of a body that is sent as it is (see `[kRepresentation]()`) */
const identity: IRepresentation = Object.freeze({ coding: null, status: null });

/** What the operations of a response need from it (see `Operation`) */
interface IRights {
  /** Whether the work of an owner may mutate the response */
  allows(owner: object | undefined): boolean;
  /** Runs a function with the rights of the framework */
  force<T>(fn: () => T): T;
  /** Whether the response has been ended */
  ended(): boolean;
}

/**
 * An operation on a response (a send of a stream, a file, a compressor): it
 * belongs to the owner of the work that has started it, whose rights its
 * asynchronous callbacks keep (see `IResponseOperation`)
 */
class Operation implements IResponseOperation {
  readonly #owner: object | undefined;
  readonly #rights: IRights;
  #transfer = false;

  public constructor(owner: object | undefined, rights: IRights) {
    this.#owner = owner;
    this.#rights = rights;
  }

  public get active(): boolean {
    return this.#transfer || this.#rights.allows(this.#owner);
  }

  public run<T>(fn: () => T): T {
    if (this.#transfer) {
      const rights = this.#rights;
      return owners.run(this.#owner as object, () => rights.force(fn));
    }
    return owners.run(this.#owner as object, fn);
  }

  public transfer(): void {
    if (this.active && this.#rights.ended()) {
      this.#transfer = true;
    }
  }
}

/**
 * The cookies of a response: once the response is sealed, the abandoned work
 * no longer changes them (also through a set obtained before)
 */
class Cookies extends Set<Cookie> {
  readonly #allows: () => boolean;

  public constructor(allows: () => boolean) {
    super();
    this.#allows = allows;
  }

  public override add(cookie: Cookie): this {
    return this.#allows() ? super.add(cookie) : this;
  }

  public override delete(cookie: Cookie): boolean {
    return this.#allows() && super.delete(cookie);
  }

  public override clear(): void {
    if (this.#allows()) {
      super.clear();
    }
  }
}

/**
 * A response (`ServerResponse`) with helpers to reply (`send()`, `json()`,
 * `sendFile()`, `redirect()`, …) and its cookies: the `ServerResponse`
 * class of the servers
 */
export class BindenResponse<
  Request extends IncomingMessage = IncomingMessage,
> extends ServerResponse<Request> {
  #cookies?: Cookies;
  /** Whether a stream has been piped into the response (by its owner) */
  #piped = false;
  /**
   * The sends in progress (of a stream or a file), by their key, with the
   * function that cancels them: the send rejects with the reason, and its
   * headers are removed (see `[kCancel]()`)
   */
  readonly #pending = new Map<object, (reason: unknown) => void>();
  /** The checks of the owners that may mutate the response (see `[kSeal]()`) */
  readonly #seals: ((owner: object | undefined) => boolean)[] = [];
  /** Set while the framework mutates the response (see `[kFramework]()`) */
  #forced = 0;
  #rights?: IRights;
  /** How a library chooses the representation of the body (see `[kNegotiator]()`) */
  #negotiator: IRepresentationNegotiator | null = null;
  #statusCode = 200;
  #statusMessage: string | undefined;

  static {
    // The status of a sealed response is not changed by the abandoned work
    // either (also by an assignment, which Node.js itself uses)
    Object.defineProperties(this.prototype, {
      statusCode: {
        configurable: true,
        enumerable: true,
        get(this: BindenResponse): number {
          return this.#statusCode;
        },
        set(this: BindenResponse, code: number): void {
          if (this.#allows()) {
            this.#statusCode = code;
          }
        },
      },
      statusMessage: {
        configurable: true,
        enumerable: true,
        get(this: BindenResponse): string | undefined {
          return this.#statusMessage;
        },
        set(this: BindenResponse, message: string | undefined): void {
          if (this.#allows()) {
            this.#statusMessage = message;
          }
        },
      },
    });
  }

  /** A response to the request (created by the server) */
  public constructor(...args: [request: Request, options?: unknown]) {
    // node:http passes its options as well
    super(...(args as [Request]));
    // `Readable.pipe()` emits `pipe` on its destination synchronously
    this.on("pipe", () => {
      if (this.#allows()) {
        this.#piped = true;
      }
    });
  }

  /**
   * The cookies to send: they are added to the `Set-Cookie` header (after the
   * values that it has) once, when the headers are sent
   */
  public get cookies(): Set<Cookie> {
    this.#cookies ??= new Cookies(() => this.#allows());
    return this.#cookies;
  }

  /**
   * Whether the response has been started: by `.send()` or `.sendFile()`
   * (until they fail before sending anything, or are cancelled), by a stream
   * piped into it, or by its headers being sent
   */
  public get started(): boolean {
    return (
      this.#piped ||
      this.#pending.size > 0 ||
      this.headersSent ||
      this.writableEnded
    );
  }

  /**
   * The options of the response (no dynamic `ETag` by default): `Binden`
   * overrides them in a subclass of its own
   */
  // eslint-disable-next-line class-methods-use-this -- overridden by subclasses
  protected get options(): Readonly<IResponseOptions> {
    return defaults;
  }

  /** Set the status code: an integer from 100 to 599 */
  public status(code: number): this {
    if (!this.#allows()) {
      return this;
    } else if (!isStatus(code)) {
      throw new TypeError(`Status code ${code} is invalid`);
    }
    this.statusCode = code;
    return this;
  }

  /** Set headers: the own properties of the object (not inherited ones) */
  public set(headers: IHeaders): this {
    if (!this.#allows()) {
      return this;
    }
    for (const [name, value] of Object.entries(headers)) {
      this.setHeader(name, value);
    }
    return this;
  }

  /**
   * Set the `Content-Type`: a media type whose parameters are each a token
   * with a token or a quoted string as value (a `TypeError` otherwise)
   */
  public type(media_type: string): this {
    if (!this.#allows()) {
      return this;
    }
    const parsed =
      typeof media_type === "string" && strictMediaType.test(media_type)
        ? ContentType.fromString(media_type)
        : null;
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
    if (!this.#allows()) {
      return this;
    }
    return this.setHeader("Content-Disposition", contentDisposition(filename));
  }

  /**
   * Add the names of request headers that select the response to `Vary`
   * (once each, case-insensitively); `*` replaces them all
   */
  public vary(...fields: string[]): this {
    if (!this.#allows()) {
      return this;
    }
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
    if (!this.#allows()) {
      return this;
    }
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
  /** Sends the headers without a reason phrase (as the first signature) */
  public override writeHead(
    statusCode: number,
    headers?: OutgoingHttpHeader[] | OutgoingHttpHeaders,
  ): this;
  public override writeHead(
    statusCode: number,
    reason?: OutgoingHttpHeader[] | OutgoingHttpHeaders | string,
    headers?: OutgoingHttpHeader[] | OutgoingHttpHeaders,
  ): this {
    if (!this.#allows()) {
      return this;
    }
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

  /**
   * Writes a chunk of the body (see `write()` of Node.js). Once the response
   * is sealed, the abandoned work writes nothing: its callback is called
   * (asynchronously, without an error) and it returns `true`.
   */
  public override write(
    chunk: unknown,
    callback?: (error: Error | null | undefined) => void,
  ): boolean;
  /** Writes a chunk of the body in an encoding (as the first signature) */
  public override write(
    chunk: unknown,
    encoding: BufferEncoding,
    callback?: (error: Error | null | undefined) => void,
  ): boolean;
  public override write(...args: unknown[]): boolean {
    if (!this.#allows()) {
      BindenResponse.#ignore(args);
      return true;
    }
    return super.write(...(args as [unknown]));
  }

  /**
   * Ends the response (see `end()` of Node.js). Once the response is sealed,
   * the abandoned work does not end it: its callback is called
   * (asynchronously, without an error).
   */
  public override end(callback?: () => void): this;
  /** Ends the response with a last chunk (as the first signature) */
  public override end(chunk: unknown, callback?: () => void): this;
  /** Ends the response with a last chunk in an encoding (as the first signature) */
  public override end(
    chunk: unknown,
    encoding: BufferEncoding,
    callback?: () => void,
  ): this;
  public override end(...args: unknown[]): this {
    if (!this.#allows()) {
      BindenResponse.#ignore(args);
      return this;
    }
    return super.end(...(args as []));
  }

  /** Sends the headers (see `flushHeaders()` of Node.js), unless the response is sealed */
  public override flushHeaders(): void {
    if (this.#allows()) {
      super.flushHeaders();
    }
  }

  /** Sets a header (see `setHeader()` of Node.js), unless the response is sealed */
  public override setHeader(
    name: string,
    value: number | string | readonly string[],
  ): this {
    return this.#allows() ? super.setHeader(name, value) : this;
  }

  /** Appends a header (see `appendHeader()` of Node.js), unless the response is sealed */
  public override appendHeader(
    name: string,
    value: string | readonly string[],
  ): this {
    return this.#allows() ? super.appendHeader(name, value) : this;
  }

  /** Sets headers (see `setHeaders()` of Node.js), unless the response is sealed */
  public override setHeaders(
    headers: Headers | Map<string, number | string | readonly string[]>,
  ): this {
    return this.#allows() ? super.setHeaders(headers) : this;
  }

  /** Removes a header (see `removeHeader()` of Node.js), unless the response is sealed */
  public override removeHeader(name: string): void {
    if (this.#allows()) {
      super.removeHeader(name);
    }
  }

  /** Adds trailers (see `addTrailers()` of Node.js), unless the response is sealed */
  public override addTrailers(
    headers: OutgoingHttpHeaders | readonly [string, string][],
  ): void {
    if (this.#allows()) {
      super.addTrailers(headers);
    }
  }

  /**
   * Destroys the response and its connection (see `destroy()` of Node.js),
   * unless the response is sealed: the abandoned work cannot cut the reply
   * of the framework
   */
  public override destroy(error?: Error): this {
    return this.#allows() ? super.destroy(error) : this;
  }

  /**
   * Sends `100 Continue`, unless the response is sealed (its callback is then
   * called asynchronously)
   */
  public override writeContinue(callback?: () => void): void {
    if (!this.#allows()) {
      BindenResponse.#ignore([callback]);
      return;
    }
    super.writeContinue(callback);
  }

  /**
   * Sends `102 Processing`, unless the response is sealed (its callback is
   * then called asynchronously)
   */
  public override writeProcessing(callback?: () => void): void {
    if (!this.#allows()) {
      BindenResponse.#ignore([callback]);
      return;
    }
    super.writeProcessing(callback);
  }

  /**
   * Sends `103 Early Hints`, unless the response is sealed (its callback is
   * then called asynchronously)
   */
  public override writeEarlyHints(
    hints: Record<string, string[] | string>,
    callback?: () => void,
  ): void {
    if (!this.#allows()) {
      BindenResponse.#ignore([callback]);
      return;
    }
    super.writeEarlyHints(hints, callback);
  }

  /**
   * Sends an informational response (see `writeInformation()` of Node.js,
   * from 24.18.0), unless the response is sealed (its callback is then called
   * asynchronously)
   */
  public override writeInformation(
    statusCode: number,
    headers?: OutgoingHttpHeaders | readonly string[],
    callback?: () => void,
  ): void;
  /** Sends an informational response without headers (as the first signature) */
  public override writeInformation(
    statusCode: number,
    callback: () => void,
  ): void;
  public override writeInformation(...args: unknown[]): void {
    if (!this.#allows()) {
      BindenResponse.#ignore(args);
      return;
    }
    super.writeInformation(...(args as [number]));
  }

  /** Calls the callback (if any) of an ignored call once, asynchronously and without an error */
  static #ignore(args: readonly unknown[]): void {
    const callback = args.find((arg) => typeof arg === "function") as
      (() => void) | undefined;
    if (callback) {
      process.nextTick(callback);
    }
  }

  /**
   * Seals the response: from now on, only the work of the owners that
   * `allows(owner)` accepts (none without it, or when it throws) mutates it.
   * The other calls are ignored: the sending methods resolve, `write()` and
   * `end()` call their callback, the setters do nothing.
   *
   * @internal
   */
  public [kSeal](allows: (owner: object | undefined) => boolean = never): void {
    this.#seals.push(allows);
  }

  /**
   * Cancels the sends in progress (of a stream, or of a file), unless the
   * headers have been committed: each rejects with the reason, its source is
   * released, and the headers that it has set are removed, so that another
   * reply can be sent at once
   *
   * @internal
   */
  public [kCancel](reason: unknown): void {
    if (!this.headersSent) {
      this[kFramework](() => {
        for (const cancel of [...this.#pending.values()]) {
          cancel(reason);
        }
      });
    }
  }

  /**
   * Runs a function of the framework with its rights, whoever owns the
   * response (e.g. to destroy it once sealed)
   *
   * @internal
   */
  public [kFramework]<T>(fn: () => T): T {
    this.#forced += 1;
    try {
      return fn();
    } finally {
      this.#forced -= 1;
    }
  }

  /**
   * Starts an operation of a library that writes to the response (e.g. a
   * compressor): `null` when the current work may not mutate the response
   *
   * @internal
   */
  public [kOperation](): IResponseOperation | null {
    const owner = owners.getStore();
    return this.#allows(owner) ? new Operation(owner, this.#control()) : null;
  }

  /** An operation of the current work (which may mutate the response) */
  #operation(): Operation {
    return new Operation(owners.getStore(), this.#control());
  }

  /** What the operations of the response need from it */
  #control(): IRights {
    this.#rights ??= {
      allows: (owner): boolean => this.#allows(owner),
      force: <T>(fn: () => T): T => this[kFramework](fn),
      ended: (): boolean => this.writableEnded,
    };
    return this.#rights;
  }

  /**
   * Whether the work of an owner (the current one by default) may mutate the
   * response: every check of `[kSeal]()` accepts it, or the framework itself
   * mutates it
   */
  #allows(owner: object | undefined = owners.getStore()): boolean {
    if (this.#forced > 0) {
      return true;
    }
    for (const allows of this.#seals) {
      try {
        if (!allows(owner)) {
          return false;
        }
      } catch {
        return false;
      }
    }
    return true;
  }

  /**
   * Lets a library (e.g. `@binden/compression`) choose the representation of
   * the body of the response (see `[kRepresentation]()`)
   *
   * @internal
   */
  public [kNegotiator](negotiator: IRepresentationNegotiator): void {
    this.#negotiator = negotiator;
  }

  /**
   * The representation of a body of `length` bytes (`null` when it is not
   * known), chosen before the preconditions of the request are evaluated
   * (RFC 9110, section 13.2.2): the body as it is, unless a library (see
   * `[kNegotiator]()`) codes it or replaces the response. The choice sends no
   * header: the commit of the headers applies it. The work that may no
   * longer mutate the response gets the body as it is (nothing of it is sent).
   *
   * @internal
   */
  public [kRepresentation](length: number | null): IRepresentation {
    return this.#negotiator === null || !this.#allows()
      ? identity
      : this.#negotiator.choose(length);
  }

  /**
   * The body that a representation has been chosen for is not sent (e.g. its
   * stream has failed before its first chunk): the reply that replaces it
   * gets a representation of its own. Not by the abandoned work, whose
   * failure must not change the reply of the new owner.
   */
  #forget(): void {
    if (this.#allows()) {
      this.#negotiator?.forget();
    }
  }

  /** Send a response */
  public send(
    data?: Buffer | Readable | bigint | number | string,
  ): Promise<void>;
  /** Send a string in an encoding (e.g. `latin1`) */
  public send(data: string, encoding: BufferEncoding): Promise<void>;
  public send(
    data?: Buffer | Readable | bigint | number | string,
    encoding?: BufferEncoding,
  ): Promise<void> {
    if (this.writableEnded || !this.#allows()) {
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
    } else if (BindenResponse.#informational(this.statusCode)) {
      // Not a final response: the client would wait for the final one
      if (data instanceof Readable) {
        BindenResponse.#discard(data);
      }
      return Promise.reject(
        new TypeError(
          `Status code ${this.statusCode} is informational (use writeEarlyHints())`,
        ),
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

    if (typeof data === "undefined" || this.destroyed) {
      // No body: as for `GET`, `Content-Length: 0`, but a valid length given
      // to `HEAD` (of the body that `GET` would send) is kept
      this.#frame(
        this.req.method === "HEAD" && this.#length() !== null ? null : 0,
      );
      this.end();
      return done;
    }

    // Encoded once: the bytes give the length and the `ETag`, and are sent
    const body =
      typeof data === "string"
        ? Buffer.from(data, encoding)
        : data instanceof Buffer
          ? data
          : Buffer.from(data.toString());

    // Only for a status with a body: also on a `304` that stands for the
    // `200` (see below)
    if (
      !this.headersSent &&
      typeof this.getHeader("Content-Type") === "undefined" &&
      !BindenResponse.#noContent(this.statusCode)
    ) {
      this.setHeader("Content-Type", ct_text);
    }

    const status = this.#conditional(body);
    if (status === 304) {
      this.#endNotModified(body.length);
      return done;
    } else if (status !== null) {
      // Empty, also for `HEAD` (which would keep the length of a body), and
      // without the coding of the body (e.g. a precompressed one)
      this.statusCode = status;
      this.#remove("Content-Encoding");
      this.#frame(0);
      this.end();
      return done;
    }

    this.#frame(body.length);

    if (this.#bodiless()) {
      // The headers of the body (as for `GET`), but not the body itself
      this.end();
      return done;
    }

    // The body is written rather than passed to `end()`: a write that fails
    // (e.g. the client went away) rejects, although Node.js 24 emits `finish`
    // once the response is ended. Its length keeps it from being chunked.
    return new Promise<void>((resolve, reject) => {
      this.write(body, (error?: Error | null) => {
        if (error) {
          reject(error);
        }
      });
      this.end();
      done.then(resolve, reject);
    });
  }

  /**
   * With the dynamic `ETag` (see `options`), for a body of a `200` response
   * to `GET` or `HEAD`: sets its strong `ETag` (unless it has one already),
   * chooses its representation (see `[kRepresentation]()`), then evaluates the
   * preconditions of the request against the `ETag` of that representation
   * and the `Last-Modified` of the response (RFC 9110, section 13.2.2). The
   * status of the empty reply instead of the body: `304`, `412`, or the
   * status that replaces the representation (e.g. `406 Not Acceptable`,
   * whatever the preconditions are); `null` to send the body.
   */
  #conditional(body: Buffer): number | null {
    const { method = "GET" } = this.req;
    if (
      this.headersSent ||
      !this.options.etag ||
      this.statusCode !== 200 ||
      (method !== "GET" && method !== "HEAD")
    ) {
      return null;
    }
    let etag = this.getHeader("ETag");
    if (typeof etag === "undefined") {
      etag = `"${createHash("sha256").update(body).digest("base64url")}"`;
      this.setHeader("ETag", etag);
    }
    const representation = this[kRepresentation](body.length);
    if (representation.status !== null) {
      return representation.status;
    }
    const modified = this.getHeader("Last-Modified");
    return preconditionsOf(
      this.req,
      tagOf(etag, representation),
      typeof modified === "string" ? parseHttpDate(modified.trim()) : null,
    );
  }

  /**
   * Ends the response (whose headers are not sent yet) as `304 Not Modified`
   * for a `200` whose body has `length` bytes: the validators and the other
   * headers of the `200`, with its `Content-Length` (RFC 9110, section 8.6),
   * but no body
   */
  #endNotModified(length: number): void {
    this.statusCode = 304;
    this.#remove("Transfer-Encoding");
    this.setHeader("Content-Length", length);
    this.end();
  }

  /**
   * Sends `304 Not Modified` for a `200` whose body has `length` bytes (see
   * `sendFile()`, whose headers are not sent yet), unless it is late
   */
  #sendNotModified(length: number): Promise<void> {
    if (!this.#allows()) {
      return Promise.resolve();
    }
    const done = this.#finished(() => false);
    this.#endNotModified(length);
    return done;
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
    if (!this.#allows()) {
      return;
    }
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

  /** Send text as `text/plain; charset=utf-8` */
  public async text(data: string): Promise<void> {
    if (!this.#allows()) {
      return;
    }
    await this.setHeader("Content-Type", `${ct_text}; charset=utf-8`).send(
      data,
    );
  }

  /** Send text as `text/html; charset=utf-8` */
  public async html(data: string): Promise<void> {
    if (!this.#allows()) {
      return;
    }
    await this.setHeader("Content-Type", `${ct_html}; charset=utf-8`).send(
      data,
    );
  }

  /** Send `URLSearchParams` as `application/x-www-form-urlencoded` */
  public async form(params: URLSearchParams): Promise<void> {
    if (!this.#allows()) {
      return;
    }
    await this.setHeader("Content-Type", ct_form).send(params.toString());
  }

  /**
   * Redirect (`302 Found` by default) to a path or a URL of the same origin as
   * the request, or with `allow_external` to another origin, with an empty
   * body. `Location` is the WHATWG URL serialization of the location (a
   * relative one stays relative). A location with userinfo, a control
   * character, whitespace, a backslash or a scheme other than `http` and
   * `https` rejects with a `TypeError`, as does an external one without
   * `allow_external`.
   */
  public async redirect(
    location: URL | string,
    status: IRedirectStatus = 302,
    { allow_external = false }: IRedirectOptions = {},
  ): Promise<void> {
    if (!this.#allows()) {
      return;
    } else if (!isRedirectStatus(status)) {
      throw new TypeError(`Status code ${String(status)} is not a redirect`);
    } else if (typeof allow_external !== "boolean") {
      throw new TypeError("`allow_external` is not a boolean");
    }
    const { base, origin } = this.#base();
    const value = redirectLocation(location, base, origin, allow_external);
    await this.status(status)
      .set({ Location: value, "Content-Length": 0 })
      .send();
  }

  /**
   * The URL that a location is resolved against, with the origin of the
   * request: the URL of a `BindenRequest`, otherwise the path of the request
   * on an origin that is not known (no absolute URL is of the same origin)
   */
  #base(): { base: URL; origin: string | null } {
    if (this.req instanceof BindenRequest) {
      const base = this.req.URL;
      return { base, origin: base.origin };
    }
    const base = new URL("http://binden.invalid");
    const target = String(this.req.url);
    if (target.startsWith("/")) {
      // Set as a path: `//host/x` is a path, not an authority
      const index = target.indexOf("?");
      const end = index === -1 ? target.length : index;
      base.pathname = target.slice(0, end);
      base.search = target.slice(end);
    }
    return { base, origin: null };
  }

  /**
   * Send the headers, then resolve once what has been written so far is
   * flushed to the connection; rejects when the response is closed before
   * (e.g. the client went away). `@binden/compression` replaces it to flush
   * the compressor as well.
   */
  public flush(): Promise<void> {
    if (!this.#allows() || this.writableFinished) {
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

  /** An informational status (1xx): not of a final response */
  static #informational(status: number): boolean {
    return status >= 100 && status < 200;
  }

  /** A status whose responses never have a body */
  static #noContent(status: number): boolean {
    return (
      BindenResponse.#informational(status) ||
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
      this.#remove("Transfer-Encoding");
      this.setHeader("Content-Length", 0);
    } else if (BindenResponse.#noContent(statusCode)) {
      // Never a body, nor the length of one
      this.#remove("Content-Length", "Transfer-Encoding");
    } else if (length !== null) {
      // Also for `HEAD`: the length of the body it would send
      this.#remove("Transfer-Encoding");
      this.setHeader("Content-Length", length);
    }
  }

  /**
   * Removes the headers that are set. Node.js also remembers the removal of
   * a header that is not set: once both `Transfer-Encoding` and
   * `Content-Length` have been removed (e.g. the length by a compression),
   * it frames the body by closing the connection, instead of chunking it.
   */
  #remove(...names: string[]): void {
    for (const name of names) {
      if (this.hasHeader(name)) {
        this.removeHeader(name);
      }
    }
  }

  /**
   * Writes a `Readable` into the response (with backpressure) and settles like
   * `#finished()`. The client has the whole response (and may close the
   * connection) once the `Content-Length` bytes are flushed to the connection,
   * maybe before the source ends.
   *
   * The `Content-Length` that the body declares is read once, before anything
   * is written (a compression removes the header): a source that fails,
   * closes before its end, or does not have exactly that length rejects.
   * Nothing sent yet, the error can still be replied (see `.started`);
   * otherwise the response is destroyed, so that a truncated body does not
   * look complete, and more bytes are not read by the client as the next
   * response of the connection. A source that has already ended is an empty
   * body; one that has been destroyed before rejects at once.
   *
   * Once another writer has ended the response (e.g. a compression that has
   * replaced it with `406` when its first chunk committed the headers), the
   * rest of the source is not read: it is released, and the response is left
   * as it is.
   *
   * The callbacks of the source run as the owner that has started the send,
   * whose rights they keep: once that owner may no longer mutate the
   * response, they do not either. Before the headers are committed, the
   * framework may cancel the send (see `[kCancel]()`): it then rejects with
   * the reason at once, and its source is released.
   */
  #pipe(data: Readable): Promise<void> {
    if (!data.readableEnded && data.destroyed) {
      // Nothing more of it can be read
      return Promise.reject(BindenResponse.#premature());
    }
    const operation = this.#operation();
    const declared = this.#length();
    const key = {};
    let flushed = 0;
    let sent = 0;
    // Once the response is closed, `#finished()` tells how it ended
    let closed = false;
    // Once the response has been ended by another writer
    let stopped = false;
    let settled = false;
    const done = this.#finished(() => {
      const length = this.#length();
      return length !== null && flushed >= length;
    });
    return new Promise<void>((resolve, reject) => {
      const settle = (error: Error | null): void => {
        if (!settled) {
          settled = true;
          this.#pending.delete(key);
          if (error === null) {
            resolve();
            return;
          } else if (!this.headersSent) {
            this.#forget();
          }
          reject(error);
        }
      };
      const fail = (error: Error): void => {
        if (settled || stopped) {
          // E.g. the source released below: the response is not changed
          return;
        } else if (sent > 0) {
          this.destroy();
        }
        settle(error);
      };
      const end = (): void => {
        if (settled) {
          return;
        } else if (declared !== null && sent < declared) {
          fail(BindenResponse.#mismatch(sent, declared));
        } else {
          this.end();
        }
      };
      this.#pending.set(key, (reason: unknown) => {
        BindenResponse.#discard(data);
        // The framing of the body that is not sent
        this.#remove("Content-Length", "Transfer-Encoding", "Content-Range");
        settle(reason as Error);
      });

      this.once("close", () => {
        closed = true;
        // Releases the source (e.g. the file of `sendFile()`)
        if (!data.readableEnded) {
          data.destroy();
        }
      });
      data
        .on("data", (chunk: Uint8Array | string) => {
          operation.run(() => {
            if (settled || !operation.active) {
              // Cancelled, or its owner may no longer write
              BindenResponse.#discard(data);
              return;
            } else if (this.writableEnded) {
              stopped = true;
              BindenResponse.#discard(data);
              return;
            }
            try {
              const size = Buffer.byteLength(chunk);
              if (declared !== null && sent + size > declared) {
                data.destroy(BindenResponse.#mismatch(sent + size, declared));
                return;
              }
              sent += size;
              const accepted = this.write(chunk, (error?: Error | null) => {
                if (error) {
                  // Not delivered: the client went away (Node.js 24 may still
                  // emit `finish` once the response is ended)
                  data.destroy();
                  settle(error);
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
          });
        })
        .once("end", () => {
          operation.run(end);
        })
        // Every error (also one emitted while the source is destroyed later)
        .on("error", (error: Error) => {
          operation.run(() => {
            fail(error);
          });
        })
        .once("close", () => {
          // Destroyed without an error before its end
          if (!closed && !data.readableEnded && data.errored === null) {
            operation.run(() => {
              fail(BindenResponse.#premature());
            });
          }
        });
      if (data.readableEnded) {
        // Its end has been read already: an empty body
        end();
      }
      done.then(
        () => {
          settle(null);
        },
        (error: unknown) => {
          data.destroy();
          settle(error as Error);
        },
      );
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
   * handle, and no more than its size is sent. Before the headers are
   * committed, the framework may cancel it (see `[kCancel]()`): it then
   * rejects with the reason at once, its headers and status are those from
   * before it, and a file opened later is closed.
   */
  public sendFile(
    path: URL | string,
    options?: ISendFileOptions,
  ): Promise<void> {
    if (!this.#allows()) {
      return Promise.resolve();
    }
    const status = this.statusCode;
    const headers = new Map(
      this.getHeaderNames().map((name) => [name, this.getHeader(name)]),
    );
    const key = {};
    let settled = false;
    return new Promise<void>((resolve, reject) => {
      const settle = (error: Error | null): void => {
        if (!settled) {
          settled = true;
          this.#pending.delete(key);
          if (error === null) {
            resolve();
          } else {
            reject(error);
          }
        }
      };
      // Started at once (see `.started`), until it fails before sending
      // anything
      this.#pending.set(key, (reason: unknown) => {
        // The headers and the status from before the file
        this.statusCode = status;
        for (const name of this.getHeaderNames()) {
          if (!headers.has(name)) {
            this.removeHeader(name);
          }
        }
        for (const [name, value] of headers) {
          if (this.getHeader(name) !== value) {
            this.setHeader(name, value as OutgoingHttpHeader);
          }
        }
        settle(reason as Error);
      });
      sendFileTo(
        this,
        path,
        options,
        (length) => this.#sendNotModified(length),
        () => settled,
      ).then(
        () => {
          settle(null);
        },
        (error: unknown) => {
          // Once cancelled, a late failure (e.g. of a file opened late) is
          // ignored
          settle(error as Error);
        },
      );
    });
  }
}
