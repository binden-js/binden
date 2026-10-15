import {
  type BindenRequest,
  type BindenResponse,
  ContentType,
  type Context,
  type IRepresentation,
  type IResponseOperation,
  bodyHeaders,
  kNegotiator,
  kOperation,
  kValidateHead,
} from "binden";
import {
  type ICompressEncodings,
  type ICompressor,
  type ICompressorOptions,
  createCompressor,
  flushKind,
} from "./codings.js";
import {
  type OutgoingHttpHeader,
  type OutgoingHttpHeaders,
  STATUS_CODES,
} from "node:http";
import { accepts, negotiate } from "./negotiate.js";
import type { ICompressionFilter } from "./filter.js";
import { isUint8Array } from "node:util/types";

/** The settings of a compression, validated */
export interface ISettings {
  /** The fixed content coding, or `auto` to negotiate it */
  readonly format: ICompressEncodings | "auto";
  /** The codings that `auto` offers, the preferred first */
  readonly encodings: readonly ICompressEncodings[];
  /** The `Content-Length` below which a response is not compressed */
  readonly threshold: number;
  /** Whether a response is compressed, by its `Content-Type` */
  readonly filter: ICompressionFilter;
  /** The options of the compressor of every coding */
  readonly compressors: ICompressorOptions;
}

/**
 * What a response becomes once its headers are committed: sent as it is,
 * compressed, or replaced with an empty one (`406`, or `500` for a `filter`
 * that has failed); `vary` when it depends on `Accept-Encoding`
 */
type IOutcome =
  | { readonly kind: "as_is"; readonly vary: boolean }
  | {
      readonly kind: "compress";
      readonly coding: ICompressEncodings;
      readonly vary: boolean;
    }
  | { readonly kind: "replace"; readonly status: 406 | 500 };

/**
 * Where the body goes: the decision is not taken yet (`pending`), to the
 * response as it is, to the compressor, or nowhere once the response has
 * been replaced
 */
type ISink = "as_is" | "compressor" | "discard" | "pending";

type IResponse = BindenResponse<BindenRequest>;

type ICallback = (error?: Error | null) => void;

/** The names of the headers of a message as they are set (in their order) */
interface IRawNames {
  getRawHeaderNames(): string[];
}

/** A response before an attempt to commit its headers (see `#commit()`) */
interface IState {
  /** Its status (its reason phrase is restored by `writeHead()` of binden) */
  readonly status: number;
  /** The headers, by their names as set, in their order */
  readonly headers: readonly (readonly [string, OutgoingHttpHeader])[];
  /** The values of the fields of `framing` */
  readonly framing: readonly (readonly [string, unknown])[];
}

/**
 * The fields of Node.js that frame a response and its connection, which a
 * head that Node.js refuses may have changed already (e.g. `_last`, once it
 * has chosen to close the connection), and which the removal of a header
 * changes (e.g. `_removedContLen`): restored with the headers, so that the
 * reply that follows frames itself as if the attempt never happened
 */
const framing = [
  "_contentLength",
  "_defaultKeepAlive",
  "_hasBody",
  "_keepAliveTimeout",
  "_last",
  "_removedConnection",
  "_removedContLen",
  "_removedTE",
  "chunkedEncoding",
  "sendDate",
  "shouldKeepAlive",
] as const;

/** A response without a body, whatever the request accepts */
const AS_IS: IOutcome = { kind: "as_is", vary: false };

/** The response as it is, which the request accepts */
const AS_IS_VARY: IOutcome = { kind: "as_is", vary: true };

/** No representation is acceptable */
const NOT_ACCEPTABLE: IOutcome = { kind: "replace", status: 406 };

/** The `filter` has failed */
const FAILED: IOutcome = { kind: "replace", status: 500 };

/**
 * The digests of the body as it is sent (RFC 9530, and `Digest` of RFC
 * 3230), which a coding changes
 */
const digests = ["Content-Digest", "Digest", "Repr-Digest"];

/**
 * The headers that an empty replacement does not have: those of the body that
 * it replaces, as for an error reply of binden (its framing, with `Trailer`,
 * its representation and its validators), and `Accept-Ranges`, as it has no
 * ranges either
 */
const replaced = [...bodyHeaders, "Accept-Ranges"];

/** The responses that a compression has been installed on */
const installed = new WeakSet<object>();

/** The responses that are not compressed (see `skipCompression()`) */
const skipped = new WeakSet<object>();

/** The values of a header as a list (of a comma-separated list) */
function listOf(value: number | string | string[] | undefined): string[] {
  const values = Array.isArray(value) ? value : [`${value ?? ""}`];
  return values
    .flatMap((item) => item.split(","))
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== "");
}

/** Whether `Content-Encoding` names `identity` only (no coding at all) */
function isIdentity(value: number | string | string[]): boolean {
  const list = listOf(value);
  return list.length > 0 && list.every((coding) => coding === "identity");
}

/** Whether `Cache-Control` has the `no-transform` directive */
function noTransform(value: number | string | string[] | undefined): boolean {
  return listOf(value).includes("no-transform");
}

/** The value of `Content-Length` (as binden reads it), or `null` without a valid one */
function lengthOf(
  value: number | string | string[] | undefined,
): number | null {
  const length = Number(value ?? Number.NaN);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}

/**
 * Whether `write()` and `end()` of Node.js accept a chunk: a string or a
 * `Uint8Array` (e.g. a `Buffer`), as they check it before anything else
 */
function isChunk(chunk: unknown): chunk is Uint8Array | string {
  return typeof chunk === "string" || isUint8Array(chunk);
}

/**
 * Sets the headers given to `writeHead()` as Node.js does once headers have
 * been set: an object sets them, a list (flat, or of pairs) replaces each of
 * its names with its values. They have been checked (see `kValidateHead`):
 * a list is of pairs.
 */
function setGiven(
  response: IResponse,
  given: OutgoingHttpHeader[] | OutgoingHttpHeaders | undefined,
): void {
  if (Array.isArray(given)) {
    const flat: unknown[] = Array.isArray(given[0]) ? given.flat() : given;
    const pairs: [string, OutgoingHttpHeader][] = [];
    for (let index = 0; index < flat.length; index += 2) {
      pairs.push(flat.slice(index, index + 2) as [string, OutgoingHttpHeader]);
    }
    for (const [name] of pairs) {
      response.removeHeader(name);
    }
    for (const [name, value] of pairs) {
      if (name) {
        response.appendHeader(name, value as string[] | string);
      }
    }
  } else if (given) {
    for (const [name, value] of Object.entries(given)) {
      if (name) {
        response.setHeader(name, value as OutgoingHttpHeader);
      }
    }
  }
}

/** The result of a function, or `ok: false` once it throws */
function attempt<T>(fn: () => T): { ok: true; value: T } | { ok: false } {
  try {
    return { ok: true, value: fn() };
  } catch {
    return { ok: false };
  }
}

/** Calls the callback (if any) of an ignored call once, asynchronously and without an error */
function ignore(args: readonly unknown[]): void {
  const callback = args.find((arg) => typeof arg === "function") as
    (() => void) | undefined;
  if (callback) {
    process.nextTick(callback);
  }
}

/** The error of a write after `end()` */
function writeAfterEnd(): Error {
  return Object.assign(new Error("write after end"), {
    code: "ERR_STREAM_WRITE_AFTER_END",
  });
}

/**
 * Leaves one response uncompressed: called before its reply starts
 * (afterwards, it may have no effect), and ignored for the work that may no
 * longer mutate the response (e.g. abandoned at its deadline)
 */
export function skip(response: BindenResponse): void {
  if (response[kOperation]() !== null) {
    skipped.add(response);
  }
}

/**
 * The compression of one response. Its methods are replaced on the response
 * itself, so that every writer (the following middlewares, `sendFile()`, the
 * error handler) goes through it, and the decision is taken once, when the
 * headers are committed: by `writeHead()`, `flushHeaders()` (and `flush()`),
 * or the first `write()` or `end()`. binden may ask for it before (see
 * `#choose()`): the commit then applies that decision.
 */
export class CompressedResponse {
  readonly #context: Context;
  readonly #settings: ISettings;
  readonly #response: IResponse;
  // The methods that the compression replaces, as they were
  readonly #writeHead: IResponse["writeHead"];
  readonly #write: IResponse["write"];
  readonly #end: IResponse["end"];
  readonly #flush: IResponse["flush"];
  #sink: ISink = "pending";
  /**
   * The decision that the representation chosen for the body (see
   * `#choose()`) has taken before the headers are committed, which applies
   * it: `null` without one
   */
  #chosen: IOutcome | null = null;
  #compressor: ICompressor | null = null;
  /** The listener of the response that destroys the compressor once closed */
  #destroy: (() => void) | null = null;
  /** The flush of the coding of the compressor (see `flushKind()`) */
  #kind = 0;
  /** Whether the application has ended a compressed response */
  #ended = false;
  /** Set while `flush()` writes its marker (see `#onWrite()`) */
  #flushing = false;
  /** The compressed bytes emitted, and those that the response has flushed */
  #produced = 0;
  #written = 0;
  /** The flushes that wait for the response to flush the compressed bytes */
  #waiters: { readonly target: number; readonly callback: ICallback }[] = [];
  /**
   * The operation of the work that has committed the headers (see
   * `IResponseOperation`): the compressor writes as its owner, and keeps
   * writing what it has accepted once the response is ended
   */
  #operation: IResponseOperation | null = null;

  private constructor(context: Context, settings: ISettings) {
    const { response } = context;
    this.#context = context;
    this.#settings = settings;
    this.#response = response;
    this.#writeHead = response.writeHead.bind(response);
    this.#write = response.write.bind(response);
    this.#end = response.end.bind(response);
    this.#flush = response.flush.bind(response);
  }

  /**
   * Installs the compression on the response of a context, unless its headers
   * have been sent (it is then left as it is), a compression is installed on
   * it already, or the current work may no longer mutate it (e.g. abandoned
   * at its deadline, whose compression would change the reply of another)
   */
  public static install(context: Context, settings: ISettings): void {
    const { response } = context;
    if (
      response.headersSent ||
      installed.has(response) ||
      response[kOperation]() === null
    ) {
      return;
    }
    installed.add(response);
    new CompressedResponse(context, settings).#hook();
  }

  /**
   * Replaces the methods of the response, and chooses the representation of
   * its body for binden (see `IRepresentationNegotiator`)
   */
  #hook(): void {
    const response = this.#response;
    response[kNegotiator]({
      choose: (length: number | null): IRepresentation => this.#choose(length),
      forget: (): void => {
        this.#chosen = null;
      },
    });
    response.writeHead = (...args: unknown[]): IResponse =>
      this.#onWriteHead(args);
    response.write = (...args: unknown[]): boolean => this.#onWrite(args);
    response.end = (...args: unknown[]): IResponse => this.#onEnd(args);
    response.flush = (): Promise<void> => {
      // `flush()` of binden writes an empty chunk, whose callback runs once
      // the chunks before it are flushed: for a compressed response, it is
      // the flush of the compressor (see `#onWrite()`)
      this.#flushing = true;
      try {
        return this.#flush();
      } finally {
        this.#flushing = false;
      }
    };
    // As for an uncompressed response, `writableEnded` is set by `end()`
    // (a compressed response is ended once the compressor is)
    Object.defineProperty(response, "writableEnded", {
      configurable: true,
      get: (): boolean =>
        this.#ended ||
        (Reflect.get(
          Object.getPrototypeOf(response) as object,
          "writableEnded",
          response,
        ) as boolean),
    });
  }

  /**
   * Whether the current work may mutate the response (see `kOperation`):
   * once the response is sealed, the calls of the work that is abandoned are
   * ignored. The operation of the work is kept for the compressor until the
   * decision is taken.
   */
  #allowed(): boolean {
    const operation = this.#response[kOperation]();
    if (this.#sink === "pending") {
      this.#operation = operation;
    }
    return operation !== null;
  }

  /**
   * `writeHead()`: its arguments are checked as Node.js does, the headers it
   * is given are set (as Node.js does), then the decision is taken, and the
   * headers are committed
   */
  #onWriteHead(args: unknown[]): IResponse {
    const response = this.#response;
    if (!this.#allowed()) {
      return response;
    }
    const [code, reason, headers] = args;
    // As Node.js reads it
    const status = Number(code) | 0;
    if (
      this.#sink !== "pending" ||
      response.headersSent ||
      status < 100 ||
      status > 999
    ) {
      // Decided already, or rejected by Node.js before it changes anything
      return Reflect.apply(this.#writeHead, response, args) as IResponse;
    }
    const given = (
      typeof reason === "string" ? headers : (headers ?? reason)
    ) as OutgoingHttpHeader[] | OutgoingHttpHeaders | undefined;
    this.#commit(() => {
      // What Node.js would refuse (e.g. a reason phrase), before anything is
      // changed: no compressor is created
      response[kValidateHead](...args);
      setGiven(response, given);
      response.statusCode = status;
      this.#apply(this.#outcome(null));
      if (this.#sink === "discard") {
        return;
      } else if (typeof reason === "string") {
        this.#writeHead(status, reason);
      } else {
        this.#writeHead(status);
      }
    });
    return response;
  }

  /**
   * `write()`: the decision is taken first, unless it has been. A chunk that
   * Node.js refuses (`null`, or neither a string nor bytes) is left to the
   * response, which throws the error of Node.js before it changes anything:
   * nothing is decided, and the response may still reply.
   */
  #onWrite(args: unknown[]): boolean {
    const [chunk, second, third] = args;
    if (!this.#allowed()) {
      ignore(args);
      return true;
    } else if (!isChunk(chunk)) {
      return Reflect.apply(this.#write, this.#response, args) as boolean;
    } else if (this.#sink === "pending") {
      const sent = this.#decideForBody(
        null,
        () => Reflect.apply(this.#write, this.#response, args) as boolean,
      );
      if (sent !== null) {
        return sent.value;
      }
    }
    const callback = (typeof second === "function" ? second : third) as
      ICallback | undefined;
    if (this.#sink === "compressor") {
      const compressor = this.#compressor as ICompressor;
      if (this.#flushing) {
        // The marker of `flush()`, which always has a callback (see `#hook()`)
        this.#flushing = false;
        this.#flushCompressor(compressor, callback as ICallback);
        return true;
      } else if (this.#ended) {
        // As Node.js, but the response is sent (not destroyed, nor crashing
        // the process with an `error` event)
        if (callback) {
          process.nextTick(callback, writeAfterEnd());
        }
        return false;
      }
      const encoding = typeof second === "string" ? second : "utf8";
      return compressor.write(
        chunk,
        encoding as BufferEncoding,
        callback as ICallback,
      );
    } else if (this.#sink === "discard") {
      // The response has been replaced: its writes are discarded
      if (callback) {
        process.nextTick(callback);
      }
      return true;
    }
    return Reflect.apply(this.#write, this.#response, args) as boolean;
  }

  /**
   * `end()`: the decision is taken first (with the size of its chunk), unless
   * it has been. As for Node.js, a chunk that is falsy (e.g. `0`) is none,
   * and a chunk that it refuses (neither a string nor bytes) is left to the
   * response, which throws its error before it changes anything.
   */
  #onEnd(args: unknown[]): IResponse {
    const response = this.#response;
    const [first, second, third] = args;
    const chunk = typeof first !== "function" && Boolean(first) ? first : null;
    if (!this.#allowed()) {
      ignore(args);
      return response;
    } else if (chunk !== null && !isChunk(chunk)) {
      return Reflect.apply(this.#end, response, args) as IResponse;
    }
    const encoding = typeof second === "string" ? second : "utf8";
    const callback = [first, second, third].find(
      (arg) => typeof arg === "function",
    ) as ICallback | undefined;
    if (this.#sink === "pending") {
      // Without writes before it, its chunk is the body
      const sent = this.#decideForBody(
        chunk === null
          ? 0
          : Buffer.byteLength(chunk, encoding as BufferEncoding),
        () => Reflect.apply(this.#end, response, args) as IResponse,
      );
      if (sent !== null) {
        return sent.value;
      }
    }
    if (this.#sink === "compressor") {
      if (!this.#ended) {
        // As Node.js, a chunk that the compressor refuses (e.g. in an
        // unknown encoding) throws, and the response is not ended
        (this.#compressor as ICompressor).end(
          chunk,
          encoding as BufferEncoding,
        );
        this.#ended = true;
        // What the compressor has accepted is sent, even if the work that
        // has ended the response is abandoned afterwards
        (this.#operation as IResponseOperation).transfer();
      }
      // As Node.js: the callback runs once the response has finished (or
      // with `ERR_STREAM_ALREADY_FINISHED` once it has), and a second `end()`
      // writes nothing
      if (callback) {
        if (response.writableFinished) {
          this.#end(callback);
        } else {
          response.once("finish", () => {
            callback();
          });
        }
      }
      return response;
    } else if (this.#sink === "discard") {
      // Ended already: only its callback runs
      return Reflect.apply(
        this.#end,
        response,
        callback ? [callback] : [],
      ) as IResponse;
    }
    return Reflect.apply(this.#end, response, args) as IResponse;
  }

  /**
   * Takes the decision for the body that is written (`size` is the size of
   * the whole body when `end()` writes it, `null` otherwise), and commits the
   * headers: at once for a compressed body, and by `send` (the `write()` or
   * the `end()` of the response, whose result is returned) for a body sent
   * as it is, so that a head that Node.js refuses then is rolled back as
   * well. `null` when the body does not go to the response as it is (or the
   * headers have been sent by another path: it is then left as it is).
   */
  #decideForBody<T>(
    size: number | null,
    send: () => T,
  ): { readonly value: T } | null {
    const response = this.#response;
    if (response.headersSent) {
      // Sent by another path: left as it is
      this.#sink = "as_is";
      return null;
    }
    let sent: { readonly value: T } | null = null;
    this.#commit(() => {
      // What Node.js would refuse (e.g. a reason phrase), before anything is
      // changed: no compressor is created
      response[kValidateHead](response.statusCode);
      this.#apply(this.#outcome(size));
      if (this.#sink === "compressor") {
        this.#writeHead(response.statusCode);
      } else if (this.#sink === "as_is") {
        sent = { value: send() };
      }
    });
    return sent;
  }

  /**
   * Takes the decision and commits the headers (`commit`). Node.js may still
   * refuse them once the decision is taken (e.g. a status code out of range,
   * or a `Trailer` of a body that is not chunked), after it has changed how
   * it frames the response: nothing of the attempt is then left (see
   * `#rollback()`), and the representation chosen for the body, which is not
   * sent, is forgotten. The error is replied with a decision of its own,
   * rather than followed by compressed bytes. Once the headers are sent
   * (e.g. a chunk in an unknown encoding, which Node.js refuses after them),
   * the decision stands.
   */
  #commit(commit: () => void): void {
    const response = this.#response;
    // Of every outgoing message (the types have it for a request only)
    const names = (response as unknown as IRawNames).getRawHeaderNames();
    const state: IState = {
      status: response.statusCode,
      headers: names.map((name) => [
        name,
        response.getHeader(name) as OutgoingHttpHeader,
      ]),
      framing: framing.map((name) => [name, Reflect.get(response, name)]),
    };
    try {
      commit();
    } catch (error: unknown) {
      if (!response.headersSent) {
        this.#rollback(state);
      }
      throw error;
    }
  }

  /**
   * Restores the response as it was before an attempt to commit its headers
   * (see `#commit()`): the compressor is destroyed (its listener on the
   * response removed), the decision is pending again, and the status, the
   * headers (their names, values and order) and the framing fields of
   * Node.js are those of `state`. Only these: the listeners of the
   * application and the I/O that the attempt has performed (none before its
   * head) are never restored.
   */
  #rollback(state: IState): void {
    const response = this.#response;
    const compressor = this.#compressor;
    if (compressor !== null) {
      response.removeListener("close", this.#destroy as () => void);
      compressor.destroy();
      this.#compressor = null;
    }
    this.#chosen = null;
    this.#sink = "pending";
    response.statusCode = state.status;
    for (const name of response.getHeaderNames()) {
      response.removeHeader(name);
    }
    for (const [name, value] of state.headers) {
      response.setHeader(name, value);
    }
    // Last: Node.js sets some of them as headers are removed
    for (const [name, value] of state.framing) {
      if (!Object.is(Reflect.get(response, name), value)) {
        Reflect.set(response, name, value);
      }
    }
  }

  /**
   * The representation of a body of `length` bytes (`null` when it is not
   * known), chosen for binden before the preconditions of the request are
   * evaluated (see `IRepresentationNegotiator`): nothing is sent nor changed,
   * and no compressor is created. The commit of the headers applies it.
   */
  #choose(length: number | null): IRepresentation {
    if (this.#response.headersSent) {
      // Committed already (by a decision, or around the compression), e.g.
      // for a reply that starts afterwards: nothing is decided again (nor
      // the `filter` called), the body is sent as the headers have set
      return { coding: null, status: null };
    }
    const outcome = this.#decide(length);
    this.#chosen = outcome;
    return {
      coding: outcome.kind === "compress" ? outcome.coding : null,
      status: outcome.kind === "replace" ? outcome.status : null,
    };
  }

  /**
   * The decision at the commit of the headers: the one of the representation
   * chosen for the body, otherwise the one of the response as it is (`size`
   * is the size of the whole body when `end()` writes it, `null` otherwise).
   * A response to `HEAD` gets the decision of `GET` by the same body: the one
   * that its `end()` writes (which Node.js does not send), or the length that
   * a writer that does not write it chooses (e.g. `send()` of a stream, which
   * is not read). A `304` gets the decision of the `200` that it stands for:
   * its `Content-Length`, when it has one, is the length of that `200`
   * (binden keeps it on the `304` of its dynamic `ETag` and of `sendFile()`).
   */
  #outcome(size: number | null): IOutcome {
    const chosen = this.#chosen;
    if (chosen !== null) {
      this.#chosen = null;
      return chosen;
    }
    const response = this.#response;
    // The body that `end()` writes is not the one of the `200` of a `304`
    return this.#decide(
      lengthOf(response.getHeader("Content-Length")) ??
        (response.statusCode === 304 ? null : size),
    );
  }

  /**
   * The decision for a body of `length` bytes (`null` when it is not known),
   * by the status and the headers of the response, the same for `GET` and
   * `HEAD`: it changes nothing (see `#apply()`). The request accepts the
   * content codings of `Accept-Encoding` (RFC 9110, section 12.5.3): a
   * response that may be compressed gets the acceptable coding that it
   * prefers, otherwise the response as it is when it is acceptable, otherwise
   * `406`. Except for a response without a body (and a failed `filter`), the
   * decision depends on `Accept-Encoding` (`Vary`).
   */
  #decide(length: number | null): IOutcome {
    const header = this.#context.request.headers["accept-encoding"];
    const response = this.#response;
    const status = response.statusCode;
    if (status < 200 || status === 204 || status === 205 || length === 0) {
      // No body: whatever the request accepts
      return AS_IS;
    }
    const encoding = response.getHeader("Content-Encoding");
    if (typeof encoding !== "undefined" && !isIdentity(encoding)) {
      // Encoded already (e.g. a precompressed file), and no other version:
      // any coding is acceptable without `Accept-Encoding`, none with an
      // empty one
      const codings = listOf(encoding).filter(
        (coding) => coding !== "identity",
      );
      return accepts(header, codings) ? AS_IS_VARY : NOT_ACCEPTABLE;
    }
    const offers = this.#offers(length);
    if (offers === null) {
      return FAILED;
    }
    // `identity` without `Accept-Encoding` (or with an empty one)
    const coding = negotiate(header, offers);
    if (coding === false) {
      return NOT_ACCEPTABLE;
    }
    return coding === "identity"
      ? AS_IS_VARY
      : { kind: "compress", coding, vary: true };
  }

  /**
   * The codings that a response of a body of `length` bytes may be
   * compressed with (`null` once the `filter` has failed): those of `auto`,
   * or the fixed `format`, but none for a range (RFC 9110, section 14.1.2:
   * ranges refer to the representation as it is), `no-transform`,
   * `skipCompression()`, a type that the `filter` refuses, or a body below
   * the `threshold`
   */
  #offers(length: number | null): readonly ICompressEncodings[] | null {
    const response = this.#response;
    if (
      response.statusCode === 206 ||
      response.hasHeader("Content-Range") ||
      noTransform(response.getHeader("Cache-Control")) ||
      skipped.has(response)
    ) {
      return [];
    }
    const filtered = this.#filter();
    if (filtered === null) {
      return null;
    } else if (
      !filtered ||
      (length !== null && length < this.#settings.threshold)
    ) {
      return [];
    }
    const { format, encodings } = this.#settings;
    return format === "auto" ? encodings : [format];
  }

  /**
   * The result of the `filter`: `null` when it fails, or does not return a
   * boolean (a configuration error, logged)
   */
  #filter(): boolean | null {
    const context = this.#context;
    const raw = this.#response.getHeader("Content-Type");
    const type = typeof raw === "string" ? ContentType.fromString(raw) : null;
    const outcome = attempt(() => this.#settings.filter(context, type));
    if (!outcome.ok) {
      context.log.error("The `filter` of the compression has failed");
      return null;
    }
    const result: unknown = outcome.value;
    if (typeof result === "boolean") {
      return result;
    }
    // E.g. a promise: its rejection is observed, never trusted
    Promise.resolve(result).catch(() => null);
    context.log.error(
      "The `filter` of the compression has not returned a boolean",
    );
    return null;
  }

  /** Applies a decision to the headers, and sets where the body goes */
  #apply(outcome: IOutcome): void {
    const response = this.#response;
    if (outcome.kind === "replace") {
      this.#replace(outcome.status);
      return;
    }
    const encoding = response.getHeader("Content-Encoding");
    if (typeof encoding !== "undefined" && isIdentity(encoding)) {
      // Not a content coding (RFC 9110, section 8.4.1)
      response.removeHeader("Content-Encoding");
    }
    if (outcome.vary) {
      response.vary("Accept-Encoding");
    }
    if (outcome.kind === "compress" && this.#code(outcome.coding)) {
      this.#kind = flushKind(outcome.coding);
      this.#compressor = this.#start(outcome.coding);
      this.#sink = "compressor";
      return;
    }
    this.#sink = "as_is";
  }

  /**
   * Sets the headers of the compressed representation: whether its body
   * goes to a compressor. A `304` stands for the compressed `200`, whose
   * length is not known, without its body nor its encoding (a cache would
   * update the stored response with it); an empty body (e.g. of the `412`
   * of a failed precondition of the compressed representation) is not
   * compressed either. A response to `HEAD` gets the headers of `GET`. The
   * digests of the uncompressed body are removed: they are not those of the
   * compressed one (nor of an empty body).
   */
  #code(coding: ICompressEncodings): boolean {
    const response = this.#response;
    const status = response.statusCode;
    const empty =
      status !== 304 && lengthOf(response.getHeader("Content-Length")) === 0;
    if (!empty) {
      this.#remove("Content-Length");
    }
    this.#remove("Accept-Ranges", ...digests);
    // A strong validator of the uncompressed body does not validate the
    // compressed one (RFC 9110, section 8.8.3.3): it becomes weak
    const etag = response.getHeader("ETag");
    if (typeof etag === "string" && !etag.startsWith("W/")) {
      response.setHeader("ETag", `W/${etag}`);
    }
    if (status === 304 || empty) {
      return false;
    }
    response.setHeader("Content-Encoding", coding);
    this.#frame();
    return this.#context.request.method !== "HEAD";
  }

  /**
   * Frames the compressed body, whose length is not known (RFC 9112, section
   * 6.3), also for `HEAD`: in chunks for HTTP/1.1, and by closing the
   * connection for HTTP/1.0, which knows no chunks. Explicitly: Node.js
   * would otherwise close the connection of HTTP/1.1 as well once both
   * `Content-Length` and `Transfer-Encoding` have been removed (e.g. a stale
   * `Transfer-Encoding` by binden), and the next requests of the connection
   * would be lost.
   */
  #frame(): void {
    const response = this.#response;
    if (this.#context.request.httpVersion === "1.0") {
      this.#remove("Transfer-Encoding");
      response.setHeader("Connection", "close");
    } else {
      response.setHeader("Transfer-Encoding", "chunked");
    }
  }

  /**
   * Removes the headers that are set: Node.js also remembers the removal of
   * a header that is not, which changes how it frames the body
   */
  #remove(...names: string[]): void {
    for (const name of names) {
      if (this.#response.hasHeader(name)) {
        this.#response.removeHeader(name);
      }
    }
  }

  /**
   * Replaces the response with an empty one of the status, and sends it: the
   * writes of the application are then discarded
   */
  #replace(status: 406 | 500): void {
    const response = this.#response;
    this.#remove(...replaced);
    if (status === 406) {
      // The request has refused every representation
      response.vary("Accept-Encoding");
    }
    response.setHeader("Content-Length", 0);
    this.#sink = "discard";
    this.#writeHead(status, STATUS_CODES[status] as string);
    this.#end();
  }

  /**
   * Creates the compressor, whose output is written to the response.
   * Backpressure goes both ways: the compressor pauses while the response is
   * full, and the `drain` of the compressor is the `drain` that writers of
   * the response wait for. An error of the compressor, or a response closed
   * early (the client has gone away), end both sides. It writes as the owner
   * of the work that has committed the headers: once that work is abandoned
   * (e.g. a timed out error handler), it writes nothing more, unless it had
   * ended the response, whose compressed bytes are then all sent.
   */
  #start(coding: ICompressEncodings): ICompressor {
    const response = this.#response;
    const operation = this.#operation as IResponseOperation;
    const compressor = createCompressor(coding, this.#settings.compressors);
    compressor
      .on("data", (chunk: Buffer) => {
        this.#produced += chunk.length;
        const accepted = operation.run(() =>
          this.#write(chunk, (error?: Error | null) => {
            if (!error) {
              this.#written += chunk.length;
              this.#release();
            }
          }),
        );
        if (!accepted) {
          compressor.pause();
          response.once("drain", () => {
            compressor.resume();
          });
        }
      })
      .on("drain", () => {
        response.emit("drain");
      })
      .on("error", () => {
        operation.run(() => response.destroy());
      })
      .once("end", () => {
        operation.run(() => this.#end());
      });
    this.#destroy = (): void => {
      // Its pending writes fail (and `flush()` rejects by itself)
      compressor.destroy();
    };
    response.once("close", this.#destroy);
    return compressor;
  }

  /**
   * Flushes the compressor: the callback runs once the response has flushed
   * the compressed bytes so far (the flushed ones may still wait in the
   * compressor, paused by backpressure)
   */
  #flushCompressor(compressor: ICompressor, callback: ICallback): void {
    compressor.flush(this.#kind, () => {
      this.#waiters.push({
        target: this.#produced + compressor.readableLength,
        callback,
      });
      this.#release();
    });
  }

  /**
   * Runs the flushes whose compressed bytes the response has flushed
   */
  #release(): void {
    const ready = this.#waiters.filter(({ target }) => target <= this.#written);
    this.#waiters = this.#waiters.filter(
      ({ target }) => target > this.#written,
    );
    for (const { callback } of ready) {
      callback();
    }
  }
}
