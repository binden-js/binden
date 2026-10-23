import {
  type BindenRequest,
  type BindenResponse,
  ContentType,
  type Context,
  type IFramingState,
  type IRepresentation,
  type IResponseOperation,
  bodyHeaders,
  described,
  formatStack,
  framingLength,
  kDiscardWrite,
  kListen,
  kNegotiator,
  kOperation,
  kRestoreFraming,
  kSaveFraming,
  kUnlisten,
  kValidateHead,
  logTo,
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
  OutgoingMessage,
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

/**
 * The `Content-Length` of a response as the compression decides by it, as
 * binden frames by it (see `framingLength()`), `null` without a valid one: a
 * number, a string, or an array of them. A value of another type (or an
 * element, also a hole of an array, e.g. `true`, or an object whose
 * `toString()` gives a length), which Node.js would send converted, throws
 * the `TypeError` of binden (`ERR_HTTP_INVALID_HEADER_VALUE`) before anything
 * is decided: never converted, never read as no length
 */
function lengthOf(response: IResponse): number | null {
  return framingLength(response.getHeader("Content-Length"));
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

/**
 * Whether `write()` and `end()` of Node.js accept a chunk: a string or a
 * `Uint8Array` (e.g. a `Buffer`), as they check it before anything else
 */
function isChunk(chunk: unknown): chunk is Uint8Array | string {
  return typeof chunk === "string" || isUint8Array(chunk);
}

/**
 * Throws the error that `write()` and `end()` of Node.js throw for a chunk
 * that they refuse (see `isChunk()`), as a response that has not ended
 * throws it: by `write()` of a message of its own, which checks the chunk
 * before anything else, so that nothing of the response is changed
 */
function refuse(chunk: unknown): never {
  return new OutgoingMessage().write(chunk) as never;
}

/**
 * The encoding of a chunk as binden checks it (see `write()` of
 * `BindenResponse`): `utf8` without one (a callback in its place, or a falsy
 * value, as Node.js reads it), and `null` for one that it refuses (an unknown
 * encoding, or `buffer` for a string)
 */
function encodingOf(
  chunk: Uint8Array | string,
  encoding: unknown,
): BufferEncoding | null {
  const given = typeof encoding !== "function" && Boolean(encoding);
  if (!given) {
    return "utf8";
  }
  return typeof encoding === "string" &&
    (Buffer.isEncoding(encoding) ||
      (typeof chunk !== "string" && encoding === "buffer"))
    ? (encoding as BufferEncoding)
    : null;
}

/**
 * The arguments of the check of binden of a head (see `kValidateHead`) by
 * which it examines the status code alone: a valid reason phrase, and a valid
 * `Content-Length` in place of the ones set (which the commit checks)
 */
const statusAlone = ["", ["Content-Length", 0]] as const;

/**
 * The status code of a response whose head is not committed, as binden
 * commits it (see `#converted()` of `BindenResponse`): the integer that
 * Node.js commits, stored as the status of the response from then on, as
 * Node.js stores it (before it checks anything else, e.g. the encoding of a
 * chunk, or the reason phrase), and before the framing is saved (see
 * `#commit()`): never compared as it is, which would convert it again, and a
 * rollback restores that number. A number is truncated as Node.js truncates
 * it (`| 0`, e.g. `204.5` is a `204`), which leaves an integer as it is. Any
 * other value (e.g. an object or a string), and a number out of range once
 * truncated (e.g. `1000`), is converted once by the conversion of binden as
 * Node.js converts it (see `kValidateHead`), which refuses it as Node.js
 * refuses it (`ERR_HTTP_INVALID_STATUS_CODE`, by the value given).
 */
function statusOf(response: IResponse): number {
  const status: unknown = response.statusCode;
  let code = typeof status === "number" ? status | 0 : 0;
  if (typeof status !== "number" || code < 100 || code > 999) {
    [code] = response[kValidateHead](status, ...statusAlone);
  }
  response.statusCode = code;
  return code;
}

/**
 * Whether Node.js writes the body of a response, as binden reads it (see
 * `write()` of `BindenResponse`): not to `HEAD`, nor with a 1xx, 204 or 304
 * status (converted once, see `statusOf()`), whose chunks Node.js ignores
 * (and binden does not check)
 */
function hasBody(response: IResponse): boolean {
  if (Reflect.get(response, "_hasBody") !== true) {
    return false;
  } else if (response.headersSent) {
    return true;
  }
  const status = statusOf(response);
  return !((status >= 100 && status < 200) || status === 204 || status === 304);
}

/**
 * The error of an encoding that binden refuses (see `encodingOf()`), as binden
 * throws it: it describes the encoding without converting it (see
 * `described()`)
 */
function unknownEncoding(encoding: unknown): Error {
  return Object.assign(
    formatStack(new TypeError(`Unknown encoding: ${described(encoding)}`)),
    { code: "ERR_UNKNOWN_ENCODING" },
  );
}

/**
 * The encodings whose byte length Node.js only estimates from the length of
 * a string (see `normalized()`)
 */
const estimated: ReadonlySet<string> = new Set(["base64", "base64url", "hex"]);

/**
 * A chunk as it is written: a string (but an empty one, which `end()` takes
 * for none) in an encoding whose byte length Node.js only estimates (`hex`,
 * `base64` and `base64url`, the name in any case) becomes the bytes that
 * `Buffer.from()` decodes. Node.js would otherwise decide by, and frame, a
 * length that is not the one that it writes for an invalid string (e.g.
 * `end("zz", "hex")` declares one byte, and writes none), and Node.js 24
 * aborts on a `hex` string of an odd length.
 */
function normalized(
  chunk: Uint8Array | string,
  encoding: unknown,
): Uint8Array | string {
  return typeof chunk === "string" &&
    chunk !== "" &&
    typeof encoding === "string" &&
    estimated.has(encoding.toLowerCase())
    ? Buffer.from(chunk, encoding as BufferEncoding)
    : chunk;
}

/**
 * The arguments of a `write()` or an `end()` with their chunk as it is
 * written (see `normalized()`): a chunk that becomes bytes has no encoding
 * any more, and keeps its callback
 */
function normalize(args: readonly unknown[]): readonly unknown[] {
  const [chunk, encoding, callback] = args;
  if (isChunk(chunk)) {
    const data = normalized(chunk, encoding);
    if (data !== chunk) {
      return typeof callback === "function" ? [data, callback] : [data];
    }
  }
  return args;
}

/**
 * Sets the headers given to `writeHead()` as Node.js does once headers have
 * been set: an object sets them, a list (flat, or of pairs) replaces each of
 * its names with its values. They are the copies that binden has read once
 * and checked (see `kValidateHead`): a list is of pairs.
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
    // The first values of a name set it, as `appendHeader()` of Node.js
    // does for a header that is not set, but checked (and converted) once
    const names = new Set<string>();
    for (const [name, value] of pairs) {
      if (name && names.has(name.toLowerCase())) {
        response.appendHeader(name, value as string[] | string);
      } else if (name) {
        names.add(name.toLowerCase());
        response.setHeader(name, value);
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
  return Object.assign(formatStack(new Error("write after end")), {
    code: "ERR_STREAM_WRITE_AFTER_END",
  });
}

/**
 * The error of a `write()` or an `end()` whose response is destroyed before
 * it has been written, or has ended
 */
function destroyed(method: "end" | "write"): Error {
  return Object.assign(
    formatStack(
      new Error(`Cannot call ${method} after a stream was destroyed`),
    ),
    { code: "ERR_STREAM_DESTROYED" },
  );
}

/**
 * A callback of a `write()` or an `end()` that runs as the work that has
 * called it (the `operation` of its call, see `kOperation`), as binden runs
 * it, with the receiver and the arguments that it is called with: the
 * compressor would otherwise call it as the work that has created the
 * compressor
 */
function owned(callback: ICallback, operation: IResponseOperation): ICallback {
  return function ownedCallback(this: unknown, ...args: unknown[]): void {
    operation.run(() => {
      Reflect.apply(callback, this, args);
    });
  };
}

/**
 * A callback that runs at most once: it is kept in `pending` until it is
 * called, and every later call is ignored (e.g. by the compressor once it has
 * been called with an error, see `#abandon()`)
 */
function pendingOnce(callback: ICallback, pending: Set<ICallback>): ICallback {
  function once(this: unknown, ...args: unknown[]): void {
    if (pending.delete(once)) {
      Reflect.apply(callback, this, args);
    }
  }
  pending.add(once);
  return once;
}

/** A callback that gives `fn` the receiver and the arguments that it is called with */
function relay(fn: (receiver: unknown, args: unknown[]) => void): ICallback {
  return function relayed(this: unknown, ...args: unknown[]): void {
    fn(this, args);
  };
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
  /** The context, which the `filter` gets (see `#filter()`) */
  readonly #context: Context;
  readonly #settings: ISettings;
  readonly #response: IResponse;
  /**
   * What the decision reads of the request, read once as the compression is
   * installed: its `Accept-Encoding`, whether it is to `HEAD`, and whether it
   * is HTTP/1.0. Never read later from the context (whose getters may fail
   * by then)
   */
  readonly #accepted: string | undefined;
  readonly #head: boolean;
  readonly #old: boolean;
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
  /**
   * The callbacks of the `end()` calls of the application that wait for the
   * end of the response (see `owned()`): of a compressed response, which
   * the end of the response by the compressor gets (see `#start()`), and of
   * the first `end()` of a replaced one, called as the end of the
   * replacement is (see `#onReplaced()`). `null` once they have been given,
   * but to a destroyed response, which keeps them until it has closed (see
   * `#start()`).
   */
  #ending: ICallback[] | null = [];
  /**
   * The callbacks of the compressed writes that the compressor has not
   * called back yet (see `pendingOnce()`), which get an error once it is
   * destroyed (see `#abandon()`)
   */
  readonly #writing = new Set<ICallback>();
  /**
   * How Node.js has called back the end of a replacement: its receiver and
   * its arguments (see `#replace()`), `null` until it has
   */
  #replacement: {
    readonly receiver: unknown;
    readonly args: unknown[];
  } | null = null;
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

  private constructor(
    context: Context,
    response: IResponse,
    settings: ISettings,
  ) {
    const { request } = context;
    const { headers, method, httpVersion } = request;
    this.#context = context;
    this.#settings = settings;
    this.#response = response;
    this.#accepted = headers["accept-encoding"];
    this.#head = method === "HEAD";
    this.#old = httpVersion === "1.0";
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
    new CompressedResponse(context, response, settings).#hook();
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
    // What they throw is formatted (see `formatStack()`), as by the methods
    // of binden that they replace (e.g. the error of Node.js for a chunk that
    // it refuses): inline, they are hot paths
    response.writeHead = (...args: unknown[]): IResponse => {
      try {
        return this.#onWriteHead(args);
      } catch (error: unknown) {
        throw formatStack(error as Error);
      }
    };
    response.write = (...args: unknown[]): boolean => {
      try {
        return this.#onWrite(args);
      } catch (error: unknown) {
        throw formatStack(error as Error);
      }
    };
    response.end = (...args: unknown[]): IResponse => {
      try {
        return this.#onEnd(args);
      } catch (error: unknown) {
        throw formatStack(error as Error);
      }
    };
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
    // (a compressed response is ended once the compressor is), read on the
    // response that it is read of (e.g. by binden as it destroys it), never
    // through what the context has given (whose traps may fail by then)
    const compressed = (): boolean => this.#ended;
    Object.defineProperty(response, "writableEnded", {
      configurable: true,
      get(this: object): boolean {
        return (
          compressed() ||
          (Reflect.get(
            Object.getPrototypeOf(this) as object,
            "writableEnded",
            this,
          ) as boolean)
        );
      },
    });
  }

  /**
   * The operation of the current work (see `kOperation`), whose callbacks
   * run as that work (see `owned()`): `null` when it may not mutate the
   * response (once the response is sealed, the calls of the work that is
   * abandoned are ignored). The operation of the work is kept for the
   * compressor until the decision is taken.
   */
  #allowed(): IResponseOperation | null {
    const operation = this.#response[kOperation]();
    if (this.#sink === "pending") {
      this.#operation = operation;
    }
    return operation;
  }

  /**
   * `writeHead()`: its arguments are checked as Node.js does, the headers it
   * is given are set (as Node.js does), then the decision is taken, and the
   * headers are committed
   */
  #onWriteHead(args: unknown[]): IResponse {
    const response = this.#response;
    if (this.#allowed() === null) {
      return response;
    }
    if (this.#sink !== "pending" || response.headersSent || this.#gone()) {
      // Decided already, or destroyed (no compressor, see `#gone()`): as
      // without the compression, which reads nothing of the arguments
      return Reflect.apply(this.#writeHead, response, args) as IResponse;
    }
    // The status of the response itself (e.g. of `flushHeaders()`, whose
    // head Node.js commits by it): converted once and stored (see
    // `statusOf()`), before the framing is saved and anything else is
    // checked, as Node.js stores it before it refuses a reason phrase. A
    // status given is converted by the check alone
    const [first, ...rest] = args;
    const own = first === response.statusCode ? statusOf(response) : first;
    this.#commit(() => {
      // What Node.js would refuse (e.g. a status code or a reason phrase),
      // before anything is changed: no compressor is created. Read once, as
      // Node.js gets them (see `kValidateHead`)
      const [status, reason, given] = response[kValidateHead](own, ...rest);
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
   * Whether the response is destroyed (e.g. the client has gone away while
   * the work waited for something else) before the decision: nothing of it
   * is sent any more, and no compressor is created for it (once the response
   * has closed, nothing would destroy it). It is left as it is: its body goes
   * to binden, whose `write()` calls back `ERR_STREAM_DESTROYED`, as without
   * a compression. A closed response is destroyed: Node.js, and binden for
   * one that it closes itself, set `destroyed` before they emit `close` (see
   * also `#start()`).
   */
  #gone(): boolean {
    return this.#response.destroyed;
  }

  /**
   * Where the body goes: a response whose headers have been sent by another
   * path (e.g. around the compression) before any decision is left as it is
   */
  #current(): ISink {
    if (this.#sink === "pending" && this.#response.headersSent) {
      this.#sink = "as_is";
    }
    return this.#sink;
  }

  /**
   * The encoding of a chunk that the compression decides by, compresses or
   * discards, checked as binden checks it (see `encodingOf()`), before
   * anything is decided: one that binden refuses throws its error, unless
   * Node.js ignores the chunk, as without a compression (see `#writes()` of
   * `BindenResponse`): the response is destroyed (also once it has ended
   * as it is), or the application has ended it (compressed, or replaced),
   * whose status is then neither converted nor stored, or it has no body
   * (e.g. to `HEAD`). A replaced response that the application has not ended
   * checks it as one that has not ended (see `#onEnd()`).
   */
  #encoding(chunk: Uint8Array | string, encoding: unknown): BufferEncoding {
    const response = this.#response;
    const checked = encodingOf(chunk, encoding);
    if (
      checked === null &&
      !response.destroyed &&
      !this.#ended &&
      hasBody(response)
    ) {
      throw unknownEncoding(encoding);
    }
    // As Node.js reads one that it ignores
    return checked ?? "utf8";
  }

  /**
   * `write()`, in the order of binden: the rights of the work, its arguments
   * (a chunk that Node.js refuses, `null` or neither a string nor bytes,
   * throws the error of Node.js, and an encoding that binden refuses throws
   * its error), the chunk as it is written (see `normalized()`), then the
   * decision, unless it has been taken. Nothing is decided by a write that
   * throws, and the response may still reply. A response sent as it is gets
   * its arguments, as without a compression. The callback runs once, as the
   * work that has called `write()` (see `owned()`).
   */
  #onWrite(args: unknown[]): boolean {
    const response = this.#response;
    const [chunk, second, third] = args;
    const operation = this.#allowed();
    if (operation === null) {
      ignore(args);
      return true;
    } else if (this.#current() === "as_is") {
      return Reflect.apply(this.#write, response, normalize(args)) as boolean;
    } else if (!isChunk(chunk)) {
      return refuse(chunk);
    }
    const encoding = this.#encoding(chunk, second);
    if (this.#sink === "pending") {
      const sent = this.#decideForBody(
        null,
        () => Reflect.apply(this.#write, response, normalize(args)) as boolean,
      );
      if (sent !== null) {
        return sent.value;
      }
    }
    const callback = (typeof second === "function" ? second : third) as
      ICallback | undefined;
    if (this.#sink === "discard") {
      // The response has been replaced: its writes are discarded, which
      // binden is told (a send is not cut for the bytes of a discarded
      // write, see `kDiscardWrite`), and their callback runs as for a chunk
      // that has been written
      response[kDiscardWrite]();
      if (callback) {
        process.nextTick(callback, null);
      }
      return true;
    }
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
    // Decoded by the compressor as `Buffer.from()` decodes it (see
    // `normalized()`), and called back by it once, or with an error once it
    // is destroyed first (see `#abandon()`)
    return callback
      ? compressor.write(
          chunk,
          encoding,
          pendingOnce(owned(callback, operation), this.#writing),
        )
      : compressor.write(chunk, encoding);
  }

  /**
   * `end()`, in the order of `write()` (see `#onWrite()`), the decision with
   * the size of its chunk as it is written. As for Node.js, a chunk that is
   * falsy (e.g. `0`) is none, and a chunk that it refuses throws its error
   * before anything is changed, the cork of the socket by `end()` of Node.js
   * as well (see `refuse()`): unless the application has ended the response
   * as it is, which Node.js answers as without a compression. Its callback
   * runs once, as `end()` of Node.js calls it (by the version of Node.js),
   * as the work that has called `end()`.
   */
  #onEnd(args: unknown[]): IResponse {
    const response = this.#response;
    const [first, second, third] = args;
    const chunk = typeof first !== "function" && Boolean(first) ? first : null;
    const operation = this.#allowed();
    if (operation === null) {
      ignore(args);
      return response;
    }
    const sink = this.#current();
    if (
      sink === "as_is" &&
      (chunk === null || isChunk(chunk) || response.writableEnded)
    ) {
      return Reflect.apply(this.#end, response, normalize(args)) as IResponse;
    } else if (chunk !== null && !isChunk(chunk)) {
      // Before `end()` of Node.js, which corks the socket first (and leaves
      // it corked when it throws: the next reply would stall). Also once the
      // compression has replaced (and ended) the response, or the
      // application has ended it through the compressor, whenever its end
      // comes: as for a response that has not ended, rather than the `error`
      // event that Node.js emits once it has (which crashes the process
      // without a listener)
      return refuse(chunk);
    }
    const encoding = chunk === null ? "utf8" : this.#encoding(chunk, second);
    const data = chunk === null ? null : normalized(chunk, encoding);
    const callback = [first, second, third].find(
      (arg) => typeof arg === "function",
    ) as ICallback | undefined;
    if (sink === "pending") {
      // Without writes before it, its chunk is the body
      const sent = this.#decideForBody(
        data === null ? 0 : Buffer.byteLength(data, encoding),
        () => Reflect.apply(this.#end, response, normalize(args)) as IResponse,
      );
      if (sent !== null) {
        return sent.value;
      }
    }
    if (this.#sink === "discard") {
      // Ended already: its chunk is discarded, which binden is told (see
      // `#onWrite()`), and only its callback runs, as for the end of the
      // replacement (the first `end()` of the application), or as Node.js
      // calls the one of an `end()` that follows it
      response[kDiscardWrite]();
      if (callback && this.#ended) {
        this.#end(callback);
      } else if (callback) {
        this.#join(owned(callback, operation));
      }
      this.#ended = true;
      return response;
    } else if (!this.#ended) {
      // Its chunk and its encoding have been checked: the compressor
      // accepts them
      (this.#compressor as ICompressor).end(data, encoding);
      this.#ended = true;
      // What the compressor has accepted is sent, even if the work that
      // has ended the response is abandoned afterwards
      (this.#operation as IResponseOperation).transfer();
    }
    // As Node.js: the callback runs once the response has finished (or
    // with `ERR_STREAM_ALREADY_FINISHED` once it has), and a second `end()`
    // writes nothing. It is given to the end of the response, once the
    // compressor has ended (see `#start()`), unless the response is
    // destroyed (Node.js does not call it back).
    if (!callback) {
      return response;
    } else if (this.#ending === null || response.destroyed) {
      this.#end(callback);
    } else {
      this.#ending.push(owned(callback, operation));
    }
    return response;
  }

  /**
   * Gives the callback of the first `end()` of a replaced response the
   * receiver and the arguments of the end of the replacement (see
   * `#onReplaced()`): once it has been called back (asynchronously, as
   * `end()` of Node.js calls it), or when it is
   */
  #join(callback: ICallback): void {
    const replacement = this.#replacement;
    if (replacement === null) {
      (this.#ending as ICallback[]).push(callback);
    } else {
      process.nextTick(() => {
        Reflect.apply(callback, replacement.receiver, replacement.args);
      });
    }
  }

  /**
   * Takes the decision for the body that is written (`size` is the size of
   * the whole body as it is written when `end()` writes it, `null`
   * otherwise), and commits the headers: at once for a compressed body, and
   * by `send` (the `write()` or the `end()` of the response, whose result is
   * returned) for a body sent as it is, so that a head that Node.js refuses
   * then is rolled back as well. A destroyed response is sent as it is,
   * without a decision (see `#gone()`). `null` when the body does not go to
   * the response as it is.
   */
  #decideForBody<T>(
    size: number | null,
    send: () => T,
  ): { readonly value: T } | null {
    const response = this.#response;
    if (this.#gone()) {
      return { value: send() };
    }
    // Converted once and stored (see `statusOf()`), before the framing is
    // saved and the reason phrase is checked, as Node.js stores it: a
    // rollback restores that number, which a retry does not convert again
    statusOf(response);
    let sent: { readonly value: T } | null = null;
    this.#commit(() => {
      // What Node.js would refuse (e.g. a reason phrase), before anything is
      // changed: no compressor is created. The status is checked as Node.js
      // checks it, by the value given (see `kValidateHead`), and decided by
      const [status] = response[kValidateHead](response.statusCode);
      response.statusCode = status;
      this.#apply(this.#outcome(size));
      if (this.#sink === "compressor") {
        this.#writeHead(status);
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
   * (e.g. a `Content-Length` that `strictContentLength` refuses once the
   * head is committed), the decision stands: the arguments of a write are
   * checked before anything is decided (see `#onWrite()`).
   */
  #commit(commit: () => void): void {
    const response = this.#response;
    const state = response[kSaveFraming]();
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
   * (see `#commit()`): the compressor, which has taken no write, is destroyed
   * (see `#abandon()`, its listener on the response removed), the decision
   * is pending again, and the framing state of the response (its status, its
   * headers and the framing fields of Node.js, see `kSaveFraming`) is the
   * one saved before. Only these: the listeners of the application and the
   * I/O that the attempt has performed (none before its head) are never
   * restored.
   */
  #rollback(state: IFramingState): void {
    const response = this.#response;
    const compressor = this.#compressor;
    if (compressor !== null) {
      response[kUnlisten]("close", this.#destroy as () => void);
      this.#abandon(compressor);
      this.#compressor = null;
    }
    this.#chosen = null;
    this.#sink = "pending";
    response[kRestoreFraming](state);
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
      lengthOf(response) ?? (response.statusCode === 304 ? null : size),
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
    const header = this.#accepted;
    const response = this.#response;
    // As Node.js commits it (see `statusOf()`)
    const status = statusOf(response);
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
    const offers = this.#offers(length, status);
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
   * the `threshold` (`status` is the status of the response, as Node.js
   * commits it, see `statusOf()`)
   */
  #offers(
    length: number | null,
    status: number,
  ): readonly ICompressEncodings[] | null {
    const response = this.#response;
    if (
      status === 206 ||
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
   * boolean (a configuration error, logged through the guarded path of
   * binden, see `logTo()`: a method, a `child()` or a `log` getter that the
   * application has replaced, or that throws, never runs nor fails the
   * decision, and the response is replaced all the same)
   */
  #filter(): boolean | null {
    const context = this.#context;
    const raw = this.#response.getHeader("Content-Type");
    const type = typeof raw === "string" ? ContentType.fromString(raw) : null;
    const outcome = attempt(() => this.#settings.filter(context, type));
    if (!outcome.ok) {
      logTo(context, "error", "The `filter` of the compression has failed");
      return null;
    }
    const result: unknown = outcome.value;
    if (typeof result === "boolean") {
      return result;
    }
    // E.g. a promise: its rejection is observed, never trusted
    Promise.resolve(result).catch(() => null);
    logTo(
      context,
      "error",
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
    const empty = status !== 304 && lengthOf(response) === 0;
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
    return !this.#head;
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
    if (this.#old) {
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
   * writes of the application are then discarded. The callback of its end
   * gets the receiver and the arguments of Node.js, which the callbacks of
   * the end of the application get (see `#onReplaced()`).
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
    this.#end(
      relay((receiver, args) => {
        this.#onReplaced(receiver, args);
      }),
    );
  }

  /**
   * The end of a replacement has been called back (see `#replace()`), with
   * a receiver and arguments: so are the callbacks of the end of the
   * application, the waiting ones now (see `#onEnd()`)
   */
  #onReplaced(receiver: unknown, args: unknown[]): void {
    const ending = this.#ending as ICallback[];
    this.#replacement = { receiver, args };
    this.#ending = null;
    for (const callback of ending) {
      Reflect.apply(callback, receiver, args);
    }
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
    const ended = (): void => {
      // Not cleared yet: the close of the response, which clears them, also
      // removes this listener (see `#destroy`)
      const ending = this.#ending as ICallback[];
      // The callbacks of `end()` are those of the end of the response (the
      // first one), and of the `end()` calls that follow it: Node.js calls
      // them as it calls those of an uncompressed response, once each
      const handed = new Set<ICallback>();
      const given = ending.map((callback) => pendingOnce(callback, handed));
      this.#ending = null;
      const [first, ...after] = given;
      operation.run(() => {
        this.#end(...(typeof first === "undefined" ? [] : [first]));
        for (const callback of after) {
          this.#end(callback);
        }
      });
      if (response.destroyed) {
        // Destroyed before its end (or by it), but not closed yet: Node.js
        // does not call back the end of a destroyed response, they get the
        // error once it has closed (see `#destroy`), unless it has called
        // them first
        this.#ending = given;
      }
    };
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
          // Of the transfer, not of a work: never called early (see `kListen`)
          response[kListen]("drain", () => {
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
      .once("end", ended);
    this.#destroy = (): void => {
      // Closed: an end of the compressor that comes afterwards (scheduled
      // before it has been destroyed) has nothing more to end, and its
      // callbacks are called back here
      compressor.off("end", ended);
      // Its pending writes fail (and `flush()` rejects by itself)
      this.#abandon(compressor);
      // Not ended by the compressor: the callbacks of `end()` get the error,
      // as Node.js calls those of a response destroyed before it has finished
      const ending = this.#ending ?? [];
      this.#ending = null;
      for (const callback of ending) {
        process.nextTick(callback, response.errored ?? destroyed("end"));
      }
    };
    if (response.closed) {
      // Closed already (e.g. its connection has closed while the `filter`
      // ran, after `#gone()`): its `close` would never come, the compressor
      // is destroyed at once, and the writes that it gets fail
      this.#destroy();
    } else {
      // The real close only: an abandoned work that sees its response closed
      // early (see `kListen`) does not cut what the compressor has accepted
      // (removed by `kUnlisten`, see `#rollback()`)
      response[kListen]("close", this.#destroy);
    }
    return compressor;
  }

  /**
   * Destroys the compressor (once the response has closed, see `#destroy`,
   * or by a rollback, before any write): the callbacks of the writes that it
   * has not called back get the error of the response (or
   * `ERR_STREAM_DESTROYED`) on the next tick, once each, as the work that has
   * called `write()` and without a receiver, as Node.js calls those of a
   * stream destroyed before it has written them. A destroyed compressor never
   * calls the one of the write that it is compressing (nor of those after
   * it) once the response is full, and may call it later without an error
   * otherwise: such a call is ignored (see `pendingOnce()`). They are
   * scheduled before the compressor is destroyed, which would call those
   * that it has buffered with an error of its own.
   */
  #abandon(compressor: ICompressor): void {
    const { errored } = this.#response;
    for (const callback of this.#writing) {
      process.nextTick(callback, errored ?? destroyed("write"));
    }
    compressor.destroy();
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
