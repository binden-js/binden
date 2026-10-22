import Cookie, { type ICookie } from "./headers/cookie.js";
import { type Duplex, Readable } from "node:stream";
import { EventEmitter, errorMonitor } from "node:events";
import { Exchange, carrierOf, formatStack, readsSafely } from "./exchange.js";
import {
  type IFramingState,
  framingCounters,
  framingFields,
  framingLength,
  kRestoreFraming,
  kSaveFraming,
  lengthRefusal,
  lengthValues,
} from "./framing.js";
import {
  type IListener,
  adderNames,
  as,
  bind,
  bindingOf,
  force,
  forced,
  isPatch,
  openWindow,
} from "./listeners.js";
import {
  type IOwnership,
  type IPipeFailure,
  type IRepresentation,
  type IRepresentationNegotiator,
  type IResponseOperation,
  kCancel,
  kCancelling,
  kDiscardWrite,
  kFramework,
  kListen,
  kNegotiator,
  kOperation,
  kOwnership,
  kPipeFailure,
  kRepresentation,
  kRevoke,
  kSeal,
  kUnlisten,
  kValidateHead,
  owners,
} from "./seal.js";
import {
  type IRedirectOptions,
  type IRedirectStatus,
  isRedirectStatus,
  redirectLocation,
} from "./redirect.js";
import {
  type ISendFileOptions,
  preconditionsOf,
  sendFileTo,
  tagOf,
} from "./send-file.js";
import {
  type ISourceReport,
  type IStreamLike,
  type IStreamLikeLogs,
  type IStreamLikeMethods,
  decide,
  decided,
  decidedFor,
  emitterMethods,
  forwarder,
  guard,
  hasClosed,
  hear,
  readStreamLike,
  releaseStreamLike,
  reportLate,
  resolved,
  streamLikeOf,
  uncarried,
} from "./stream-like.js";
import {
  IncomingMessage,
  type OutgoingHttpHeader,
  type OutgoingHttpHeaders,
  OutgoingMessage,
  ServerResponse,
  validateHeaderName,
  validateHeaderValue,
} from "node:http";
import { contentDigests, representationDigests } from "./digests.js";
import { described, formatting, objectOf } from "./formatting.js";
import {
  isArrayBuffer,
  isDataView,
  isProxy,
  isUint8Array,
} from "node:util/types";
import { split, trimOws } from "./headers/list.js";
import { BindenRequest } from "./request.js";
import ContentType from "./headers/content-type.js";
import { brandResponses } from "./brands.js";
import { createHash } from "node:crypto";
import { format } from "node:util";
import { isStatus } from "./status.js";
import { parseHttpDate } from "./headers/http-date.js";
import { property } from "./property.js";

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

/**
 * The arguments of `writeHead()` as Node.js gets them from binden, each read
 * once (see `kValidateHead`): the status code, converted as Node.js converts
 * it, the reason phrase (`null` when none is given), and copies of the
 * headers given (`undefined` when none are). For the packages of binden only.
 *
 * @internal
 */
export type IHead = readonly [
  statusCode: number,
  reason: string | null,
  headers: OutgoingHttpHeader[] | OutgoingHttpHeaders | undefined,
];

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
 * `TypeError` for an invalid one, and for anything but an object. What reading
 * them throws (e.g. a revoked proxy) is formatted (see `formatting()`).
 */
export function validateResponseOptions(
  options: { readonly etag?: boolean | undefined } = {},
): Readonly<IResponseOptions> {
  const { etag = false } = formatting(() => {
    const given: unknown = options;
    if (typeof given !== "object" || given === null) {
      throw formatStack(
        new TypeError(`\`options\` is not an object: ${described(given)}`),
      );
    }
    // Read once
    const { etag: value } = options;
    return { etag: value };
  });
  if (typeof etag !== "boolean") {
    throw formatStack(new TypeError("`etag` is not a boolean"));
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
    throw formatStack(
      new TypeError("The filename is not a non-empty well-formed string"),
    );
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

/** `type/subtype` (RFC 9110, section 8.3.1), without whitespace */
const strictType = new RegExp(`^${token}/${token}$`, "u");

/**
 * A parameter of a media type: a token with a token or a quoted string as
 * value (RFC 9110, section 5.6.6), without whitespace. Its alternatives start
 * with distinct characters, so it is matched in linear time.
 */
const strictParameter = new RegExp(`^${token}=(?:${token}|${quoted})$`, "u");

/**
 * Whether a media type has parameters that are each a token with a token or
 * a quoted string as value (RFC 9110, section 8.3.1), with optional
 * whitespace around its parts (an empty parameter is allowed). Split on the
 * `;` outside of the quoted strings and matched part by part, in linear time:
 * a single regular expression with optional whitespace on both sides of the
 * separators backtracks exponentially on a long run of ` ;`.
 */
function isStrictMediaType(media_type: string): boolean {
  const [type = "", ...parameters] = split(media_type, ";");
  return (
    strictType.test(trimOws(type)) &&
    parameters.every((parameter) => {
      const trimmed = trimOws(parameter);
      return trimmed === "" || strictParameter.test(trimmed);
    })
  );
}

/** A character that a reason phrase cannot have (as Node.js checks it) */
const invalidReason = /[^\t\x20-\x7E\x80-\xFF]/u;

/** The methods of `EventEmitter` that a response replaces (see its static block) */
const parent = ServerResponse.prototype;

/** The methods of `EventEmitter` of every emitter (e.g. of a piped source) */
const intrinsic = EventEmitter.prototype;

/**
 * The methods that binden or the pipe of Node.js call on a piped source
 * (e.g. `resume()`, which `on("data")` calls before the pipe is adopted): a
 * source that has its own one (other than the patches of an open window, see
 * `openWindow()`) is not adopted (see `BindenResponse.#adopt()`)
 */
const inspected = [
  ...adderNames,
  "emit",
  "pipe",
  "unpipe",
  "pause",
  "resume",
  "read",
  "rawListeners",
  "listeners",
  "listenerCount",
  "removeListener",
  "off",
  "removeAllListeners",
];

/**
 * The listener methods that an instrumentation sets on a source to bind its
 * listeners (e.g. `context.bind()` of OpenTelemetry): a pipe of the stack
 * whose source has its own ones, and no other method of its own, may be left
 * to Node.js (see `BindenResponse.#leave()`)
 */
const wrappers: ReadonlySet<string> = new Set([
  ...adderNames,
  "removeListener",
  "off",
  "removeAllListeners",
]);

/**
 * Why a pipe cannot be adopted (see `BindenResponse.#refusal()`), and
 * whether it may be left to Node.js instead (see `BindenResponse.#leave()`)
 */
interface IRefusal {
  readonly reason: string;
  readonly native: boolean;
}

/** A pipe that cannot be adopted, nor left to Node.js */
function refused(reason: string): IRefusal {
  return { reason, native: false };
}

/**
 * The properties of a piped source that Node.js reads as it pipes it (its
 * state, its listener table and the inspected methods), and binden as it
 * adopts the pipe: an accessor of the source itself (e.g. a getter of
 * `_readableState` that adds a listener after the one of the pipe) would
 * run code of another work during the pipe (see `#refusal()`)
 */
const read: readonly string[] = [
  "_readableState",
  "_writableState",
  "_events",
  "_eventsCount",
  "_maxListeners",
  "readableEnded",
  "destroyed",
  ...inspected,
];

/**
 * The first property that Node.js or binden read on a piped source (see
 * `read`) that the source has as an accessor of its own (none on a source
 * that is not a proxy runs its code)
 */
function accessorOf(source: object): string | undefined {
  return read.find((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(source, name);
    return typeof descriptor !== "undefined" && !("value" in descriptor);
  });
}

/** How a response handles the works that own it without the framework (see `kOwnership`) */
const unowned: IOwnership = {
  fail: (): boolean => false,
  guards: (): boolean => false,
  replier: (): null => null,
  native: (): boolean => false,
  debug: (): void => {
    // Nobody to tell
  },
  warn: (): void => {
    // Nobody to tell
  },
  note: (): void => {
    // Nobody to tell
  },
};

/**
 * The codes of the errors that a `write()` or an `end()` of Node.js throws
 * once the head is committed which leave every byte that it has queued valid
 * (see `BindenResponse.#stopping()`): a body that the response may not have
 * (to `HEAD`, or with a 204 or a 304 status, under the
 * `rejectNonStandardBodyWrites` option of the server), whose output is only
 * its head, and the checks of a chunk before Node.js takes it
 */
const keeping: ReadonlySet<unknown> = new Set([
  "ERR_HTTP_BODY_NOT_ALLOWED",
  "ERR_INVALID_ARG_TYPE",
  "ERR_STREAM_NULL_VALUES",
  "ERR_UNKNOWN_ENCODING",
]);

/**
 * `Readable.prototype.destroy()`, which releases a `Readable` that is not
 * sent (see `BindenResponse.#discard()`): never its own
 */
const destroyReadable = Reflect.get(Readable.prototype, "destroy") as (
  this: Readable,
  error?: unknown,
) => unknown;

/**
 * The getter of `destroyed` of `Readable.prototype`: whether a `Readable` is
 * destroyed, as Node.js tells it (never by a getter of its own)
 */
const readableDestroyed = Reflect.get(
  Object(Reflect.getOwnPropertyDescriptor(Readable.prototype, "destroyed")),
  "get",
) as (this: Readable) => boolean;

/** The getter of a property of an object of the engine (e.g. of a prototype) */
function getterOf(target: object, key: string): () => unknown {
  return Reflect.get(
    Object(Reflect.getOwnPropertyDescriptor(target, key)),
    "get",
  ) as () => unknown;
}

/**
 * The getters of the engine that tell where the bytes of a view are: of its
 * `buffer`, its `byteOffset` and its `byteLength`
 */
type IViewGetters = readonly [
  buffer: () => unknown,
  byteOffset: () => unknown,
  byteLength: () => unknown,
];

/** The getters of a view of the engine (of a prototype, see `IViewGetters`) */
function viewGetters(prototype: object): IViewGetters {
  return [
    getterOf(prototype, "buffer"),
    getterOf(prototype, "byteOffset"),
    getterOf(prototype, "byteLength"),
  ];
}

/** The getters of the typed arrays (of `%TypedArray%.prototype`, e.g. of a `Uint8Array`) */
const typedArrayGetters = viewGetters(
  Reflect.getPrototypeOf(Uint8Array.prototype) as object,
);

/** The getters of a `DataView` */
const dataViewGetters = viewGetters(DataView.prototype);

/** The getter of `detached` of an `ArrayBuffer` */
const arrayBufferDetached = getterOf(ArrayBuffer.prototype, "detached");

/** `Buffer.prototype`, read once (see `bytesOf()`) */
const bufferPrototype = Reflect.get(Buffer, "prototype") as object;

/** The refusal of a view of an `ArrayBuffer` that has been detached (see `bytesOf()`) */
function detachedView(): TypeError {
  return formatStack(
    new TypeError("The data is a view of a detached ArrayBuffer"),
  );
}

/**
 * Where the bytes of a view are in its `ArrayBuffer` (see `bytesOf()`): its
 * `byteOffset` and its `byteLength`, by the getters of the engine. A
 * `DataView` out of the bounds of a resizable `ArrayBuffer` that has shrunk,
 * whose bounds the engine does not tell, throws a `TypeError` of binden,
 * formatted (see `formatStack()`)
 */
function boundsOf(
  view: ArrayBufferView,
  [, byteOffset, byteLength]: IViewGetters,
): [number, number] {
  try {
    return [
      Reflect.apply(byteOffset, view, []) as number,
      Reflect.apply(byteLength, view, []) as number,
    ];
  } catch {
    throw formatStack(
      new TypeError("The data is a view out of the bounds of its ArrayBuffer"),
    );
  }
}

/**
 * The bytes of a view of an `ArrayBuffer` (a typed array or a `DataView`),
 * as a `Buffer` of binden over them, which is what is sized and written:
 * Node.js reads nothing of the view then. Its `buffer`, `byteOffset` and
 * `byteLength` are read once, by the getters of the engine, never by a getter
 * of the view's own (which may lie, or detach its buffer as it is read), and
 * the `Buffer` is made by `Uint8Array` of the engine (as `Buffer.from()`
 * makes one, but without reading a `byteLength` of the `ArrayBuffer`, which
 * may be a getter of its own). The bytes of an `ArrayBuffer` that has been
 * detached (e.g. by its `transfer()`) are gone, and Node.js would throw once
 * it writes them (e.g. as it uncorks the connection on the next tick, out of
 * any call: the process crashes): such a view throws a `TypeError` of binden,
 * formatted (see `formatStack()`), and so does a `DataView` out of the bounds
 * of a resizable `ArrayBuffer` that has shrunk (see `boundsOf()`; a typed
 * array out of its bounds has no bytes, as the engine tells). A
 * `SharedArrayBuffer` is never detached.
 */
function bytesOf(view: ArrayBufferView): Buffer {
  const getters = isDataView(view) ? dataViewGetters : typedArrayGetters;
  const [bufferOf] = getters;
  const buffer = Reflect.apply(bufferOf, view, []);
  if (
    isArrayBuffer(buffer) &&
    Reflect.apply(arrayBufferDetached, buffer, []) === true
  ) {
    throw detachedView();
  }
  // As `Buffer.from()` makes it (a `Uint8Array` of `Buffer.prototype`)
  return Object.setPrototypeOf(
    new Uint8Array(buffer as ArrayBufferLike, ...boundsOf(view, getters)),
    bufferPrototype,
  ) as Buffer;
}

/**
 * Whether bytes that binden has counted (`size`, see `bytesOf()`) are gone
 * once their `write()` has returned, as the getters of the engine tell them:
 * the `ArrayBuffer` of the `Buffer` of binden, which shares the memory of the
 * view of the application, has been detached, or the `Buffer` has fewer bytes
 * (e.g. out of the bounds of a resizable `ArrayBuffer` that has shrunk).
 * Application code runs inside that `write()` before the bytes are queued
 * (e.g. the `toString()` of a cookie as the head is committed, or the
 * `filter` of `@binden/compression`), and may detach them: the head would then
 * declare bytes that are never written (see `BindenResponse.#cutLost()`).
 */
function bytesLost(bytes: Buffer, size: number): boolean {
  const [bufferOf, , byteLength] = typedArrayGetters;
  const buffer = Reflect.apply(bufferOf, bytes, []);
  return (
    size > 0 &&
    ((isArrayBuffer(buffer) &&
      Reflect.apply(arrayBufferDetached, buffer, []) === true) ||
      (Reflect.apply(byteLength, bytes, []) as number) < size)
  );
}

/**
 * The JSON text of a value (`JSON.stringify()`). What it throws (e.g. the
 * `TypeError` of a nested `bigint` or of a cycle, which V8 creates while the
 * frames of the response are on the stack) is formatted (see
 * `formatStack()`), so that an application that keeps it keeps none of them.
 */
function jsonText(data: unknown): string | undefined {
  try {
    return JSON.stringify(data);
  } catch (error: unknown) {
    throw formatStack(error as Error);
  }
}

/**
 * A copy of a value read once: an array, by its indexes (a hole is an
 * element), its elements that are arrays copied as well down to `depth`
 * levels; anything else as it is
 */
function copied(value: unknown, depth: number): unknown {
  if (depth === 0 || !Array.isArray(value)) {
    return value;
  }
  const copy: unknown[] = [];
  const { length } = value;
  for (let index = 0; index < length; index += 1) {
    copy.push(copied(value[index], depth - 1));
  }
  return copy;
}

/**
 * The headers given to `writeHead()`, read once, as Node.js reads them: an
 * array by its indexes, as are its pairs and the values of a header (see
 * `copied()`), and an object (or a function) by its own enumerable
 * properties, each array of values copied. Node.js then gets the copies,
 * which hold exactly the values that binden has read and checked (a getter
 * of the application, or a proxy, never runs again). Anything else (e.g.
 * `undefined`, or a string, which Node.js reads as an object of its
 * characters) is kept as it is.
 */
function headersOf(given: unknown): unknown {
  if (Array.isArray(given)) {
    return copied(given, 3);
  } else if (
    (typeof given === "object" && given !== null) ||
    typeof given === "function"
  ) {
    return Object.fromEntries(
      Object.entries(given).map(([name, value]) => [name, copied(value, 1)]),
    );
  }
  return given;
}

/**
 * The hints of `writeEarlyHints()`, read once, as Node.js reads them: an
 * object (but an array, or a function, which Node.js refuses as it is) by its
 * `link`, then, unless it has none (Node.js then sends nothing), by its own
 * enumerable properties, each array of values copied (see `copied()`).
 * Node.js then gets the copy.
 */
function hintsOf(hints: unknown): unknown {
  if (typeof hints !== "object" || hints === null || Array.isArray(hints)) {
    return hints;
  }
  const link: unknown = Reflect.get(hints, "link");
  if (link === null || typeof link === "undefined") {
    return { link };
  }
  return Object.fromEntries([
    ["link", copied(link, 1)],
    ...Object.keys(hints)
      .filter((name) => name !== "link")
      .map((name) => [name, copied(Reflect.get(hints, name), 1)]),
  ]);
}

/**
 * The trailers of `addTrailers()`, read once, as Node.js reads them: by their
 * own enumerable keys, an array of pairs (each pair by its name and its
 * value, at the same keys) or an object, each array of values copied (see
 * `copied()`). Node.js then gets the copy. Anything else (e.g. `null`, which
 * Node.js refuses) is kept as it is.
 */
function trailersOf(trailers: unknown): unknown {
  if (typeof trailers !== "object" || trailers === null) {
    return trailers;
  } else if (!Array.isArray(trailers)) {
    return Object.fromEntries(
      Object.keys(trailers).map((name) => [
        name,
        copied(Reflect.get(trailers, name), 1),
      ]),
    );
  }
  const copy: unknown[] = [];
  for (const key of Object.keys(trailers)) {
    const pair: unknown = Reflect.get(trailers, key);
    Reflect.set(
      copy,
      key,
      typeof pair === "object" && pair !== null
        ? [Reflect.get(pair, 0), copied(Reflect.get(pair, 1), 1)]
        : pair,
    );
  }
  return copy;
}

/**
 * Whether a value of a header (see `headersOf()`) is checked without running
 * code of the application: anything but an object or a function, or an
 * array of such values. A value of another type is checked by Node.js
 * itself, which converts it as it does without binden.
 */
function inert(value: unknown): boolean {
  const primitive = (element: unknown): boolean =>
    (typeof element !== "object" || element === null) &&
    typeof element !== "function";
  return Array.isArray(value) ? value.every(primitive) : primitive(value);
}

/** The serialization of `URLSearchParams` of Node.js (see `formText()`) */
const searchParamsText = Reflect.get(URLSearchParams.prototype, "toString");

/**
 * The text of `URLSearchParams` (`application/x-www-form-urlencoded`), by the
 * serialization of Node.js. Anything else (e.g. `null`, a string, or an object
 * that only looks like them) is refused with a `TypeError` of binden: the
 * error of Node.js (or of V8), created while the frames of the response are
 * on the stack, is not kept (see `formatStack()`).
 */
function formText(params: unknown): string {
  try {
    return Reflect.apply(searchParamsText, params, []);
  } catch {
    throw formatStack(new TypeError("The parameters are not URLSearchParams"));
  }
}

/** The report of a late error of a source of a response that is not owned */
function unreported(): void {
  // Nobody to tell
}

/** The listeners of an event of an emitter, as added (e.g. a wrapper of `once()`) */
function rawListenersOf(emitter: EventEmitter, event: string): IListener[] {
  return intrinsic.rawListeners.call(emitter, event) as IListener[];
}

/** The state of a readable stream that binden reads (see `pipesInto()`) */
interface IReadableState {
  readonly pipes?: unknown;
  readonly pipesCount?: unknown;
  readonly endEmitted?: unknown;
}

/** The state of a readable stream, if it has one */
function stateOf(source: EventEmitter): IReadableState | undefined {
  const { _readableState: state } = source as {
    _readableState?: IReadableState;
  };
  return state;
}

/**
 * Whether a source is piped into a destination by `Readable.prototype.pipe()`
 * (its state lists it): in the list of its pipes, or as its only one, which
 * the state of Node.js 10 (also of `readable-stream` 2 and 3) holds as is
 */
function pipesInto(source: EventEmitter, destination: object): boolean {
  const state = stateOf(source);
  if (typeof state === "undefined") {
    return false;
  }
  const { pipes, pipesCount } = state;
  return Array.isArray(pipes)
    ? pipes.includes(destination)
    : pipes === destination && pipesCount === 1;
}

/**
 * Whether a source has emitted its `end`: `readableEnded`, or the state of
 * a stream that has no such property (e.g. of `readable-stream` 2 and 3)
 */
function hasEnded(source: EventEmitter): boolean {
  return (
    (source as Partial<Readable>).readableEnded === true ||
    stateOf(source)?.endEmitted === true
  );
}

/**
 * Unpipes a source from a destination by the method of its class (never by
 * one of the source itself), if it is still piped into it: `false` when it
 * is not (e.g. a legacy pipe of `Stream.prototype.pipe()`, which no state
 * lists), or its class has no such method
 */
function unpipe(source: EventEmitter, destination: object): boolean {
  const method: unknown = Reflect.get(
    Object.getPrototypeOf(source) as object,
    "unpipe",
  );
  if (typeof method === "function" && pipesInto(source, destination)) {
    Reflect.apply(method, source, [destination]);
    return true;
  }
  return false;
}

/**
 * Replaces the last listener of an event of a source in its place, by the
 * methods of every emitter: no listener of the source runs (it has none of
 * `newListener` or `removeListener`, see `BindenResponse.#refusal()`)
 */
function replaceListener(
  source: EventEmitter,
  event: string,
  listener: IListener,
  bound: IListener,
): void {
  intrinsic.removeListener.call(source, event, listener);
  intrinsic.on.call(source, event, bound);
}

/**
 * The arguments of a method of Node.js whose callback runs as the work that
 * has called it (see `bind()`): Node.js calls it once the socket has written,
 * as whoever has flushed it then
 */
function callbacksOf(args: readonly unknown[]): unknown[] {
  const owner = owners.getStore();
  const bound: unknown[] = [];
  for (const arg of args) {
    bound.push(
      typeof arg === "function"
        ? bind(arg as IListener, owner, "callback", null)
        : arg,
    );
  }
  return bound;
}

/** An observer of an event of a response (see `[kListen]()`) */
interface IObserver {
  readonly listener: IListener;
  /** The work that has added it */
  readonly owner: object | undefined;
  readonly once: boolean;
  /** Whether it has run, once it runs once */
  fired: boolean;
}

/**
 * Adds the listeners of a send to its source, by the methods of the source,
 * and records them (see `BindenResponse.#pipe()`)
 */
interface IListening {
  on(event: string, listener: (...args: never[]) => void): IListening;
}

/**
 * The method that removes a listener that a send has added to a Node.js
 * `Readable` by its own `on()` (see `BindenResponse.#pipe()`): its own
 * `removeListener()`, or else its own `off()`, which pairs with that `on()`
 * (e.g. finds the listener that a wrapping `on()` has added in its place),
 * or else the one of `EventEmitter`
 */
function removerOf(source: Readable): (...args: unknown[]) => unknown {
  for (const name of ["removeListener", "off"]) {
    const method: unknown = Reflect.get(source, name);
    if (typeof method === "function") {
      return method as (...args: unknown[]) => unknown;
    }
  }
  return emitterMethods.remove;
}

/** The pipe whose adopted `data` listener runs now (see `destroy()`) */
interface IMarker {
  readonly owner: object | undefined;
  readonly source: EventEmitter;
}

/**
 * The properties of Node.js that frame a response (its connection and its
 * body), which it reads as it commits the headers and writes the body
 */
interface IConnection {
  chunkedEncoding: boolean;
  maxRequestsOnConnectionReached: boolean;
  sendDate: boolean;
  shouldKeepAlive: boolean;
  strictContentLength: boolean;
  useChunkedEncodingByDefault: boolean;
}

/** Their values as the constructor of `OutgoingMessage` sets them */
const initial: Readonly<IConnection> = Object.freeze({
  chunkedEncoding: false,
  maxRequestsOnConnectionReached: false,
  sendDate: false,
  shouldKeepAlive: true,
  strictContentLength: false,
  useChunkedEncodingByDefault: true,
});

/**
 * The framing properties of the responses (see `IConnection`): the
 * constructors of Node.js set them before the private fields of a response
 * exist
 */
const connections = new WeakMap<object, IConnection>();

/** Whether a value is truthy, as Node.js tests a chunk or an encoding (e.g. `""` is none) */
const truthy = (value: unknown): boolean => Boolean(value);

/**
 * The encodings of the strings whose length Node.js only estimates (e.g. of
 * an invalid one): a string in one of them is written as its bytes (see
 * `BindenResponse.#normalized()`)
 */
const estimated: ReadonlySet<string> = new Set(["base64", "base64url", "hex"]);

/** The headers that frame a body (see `BindenResponse.#framing`) */
const framing: ReadonlySet<string> = new Set([
  "content-length",
  "content-range",
  "transfer-encoding",
]);

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
 * asynchronous callbacks keep (see `IResponseOperation`). What its methods
 * throw is formatted (see `formatStack()`), e.g. for a callback that is not
 * a function, or what the callback throws.
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
    // Inline: a hot path (e.g. each chunk of a compressed response)
    try {
      if (this.#transfer) {
        const rights = this.#rights;
        return owners.run(this.#owner as object, () => rights.force(fn));
      }
      return owners.run(this.#owner as object, fn);
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  public transfer(): void {
    try {
      if (this.active && this.#rights.ended()) {
        this.#transfer = true;
      }
    } catch (error: unknown) {
      throw formatStack(error as Error);
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

  /**
   * Adds a cookie (a `Cookie`, or an object whose `toString()` gives the value
   * of its `Set-Cookie`, read as the head is committed), unless the response
   * is sealed: anything but an object (e.g. `null`, or a string) is refused
   * with a `TypeError` that describes it (see `objectOf()`)
   */
  public override add(cookie: Cookie): this {
    if (!this.#allows()) {
      return this;
    }
    objectOf(cookie, "cookie");
    return super.add(cookie);
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
 * `ServerResponse`, whose constructor formats what it throws (see
 * `formatStack()`), e.g. the `TypeError` of a request that is not an object,
 * which Node.js reads: the constructor of `BindenResponse`, which has private
 * fields, can only call it at its root, outside of a `try`
 */
const FormattedResponse = class extends ServerResponse {
  public constructor(...args: [request: IncomingMessage, options?: unknown]) {
    try {
      super(...(args as [IncomingMessage]));
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }
} as unknown as typeof ServerResponse;

/**
 * A response (`ServerResponse`) with helpers to reply (`send()`, `json()`,
 * `sendFile()`, `redirect()`, …) and its cookies: the `ServerResponse`
 * class of the servers
 */
export class BindenResponse<
  Request extends IncomingMessage = IncomingMessage,
> extends FormattedResponse<Request> {
  #cookies?: Cookies;
  /** Whether a stream has been piped into the response (by its owner) */
  #piped = false;
  /**
   * The sends in progress (of a stream or a file), by their key, with the
   * function that cancels them: the send rejects with the reason, and its
   * source is released (see `[kCancel]()`, which restores the response
   * first, see `#rollbacks`)
   */
  readonly #pending = new Map<
    object,
    (reason: unknown, release: (() => void)[]) => void
  >();
  /**
   * What restores the response as it was before each send in progress (see
   * `#pending`), by its key, in the order of their start: run by
   * `[kCancel]()` in the reverse order, before the reply that replaces them.
   * A send that settles once its cancellation has been recorded keeps it
   * until then (see `#settled()`), so that this reply never inherits what it
   * has set. `null` for a send of a stream, which has nothing of its own to
   * restore: `[kCancel]()` removes the framing of the bodies that are not
   * sent, and the representation chosen for them, once for every send. A
   * rollback holds nothing of its send (e.g. its source), which may have
   * settled long before.
   */
  readonly #rollbacks = new Map<object, (() => void) | null>();
  /**
   * The cancellations recorded for sends in progress (see
   * `[kCancelling]()`), by their key: such a send rejects with the reason,
   * however it settles, and is still restored by `[kCancel]()`
   */
  readonly #cancellations = new WeakMap<object, { readonly reason: Error }>();
  /** The checks of the owners that may mutate the response (see `[kSeal]()`) */
  readonly #seals: ((owner: object | undefined) => boolean)[] = [];
  /** How the framework handles the works that own the response (see `[kOwnership]()`) */
  #ownership: IOwnership = unowned;
  /**
   * The works that may no longer mutate the response (see `[kRevoke]()`):
   * whether they have been told so
   */
  readonly #revoked = new Map<object, boolean>();
  /** The sources that each work has piped into the response (see `#adopt()`) */
  readonly #sources = new Map<object | undefined, Set<EventEmitter>>();
  /** The listeners that guard a piped source (see `#guard()`) */
  readonly #guards = new Map<EventEmitter, [string, IListener][]>();
  /**
   * The sources that each work has piped, left to Node.js (see `#leave()`),
   * with the reason
   */
  readonly #natives = new Map<object, Map<EventEmitter, string>>();
  /** The works whose re-emitted `error` is absorbed now (see `#deliver()`) */
  readonly #absorbing = new Set<object>();
  /** The pipe whose adopted `data` listener runs now (see `destroy()`) */
  #marker: IMarker | null = null;
  /** The observers of the framework, by event (see `[kListen]()`) */
  readonly #observers = new Map<string | symbol, IObserver[]>();
  #rights?: IRights;
  /** How a library chooses the representation of the body (see `[kNegotiator]()`) */
  #negotiator: IRepresentationNegotiator | null = null;
  #statusCode = 200;
  #statusMessage: string | undefined;
  /**
   * The generation of the framing headers of the response, advanced by every
   * change of them that Node.js has accepted: a send that fails removes its
   * framing only while it is the latest (see `#pipe()`)
   */
  #framing = 0;
  /**
   * Whether the framework has destroyed the response before it has ended:
   * its socket, once Node.js assigns one, is destroyed (see `#cutQueued()`)
   */
  #cut = false;
  /**
   * The writes that a library that has replaced the response has discarded
   * (see `[kDiscardWrite]()`, and `#dropped()`)
   */
  #discardedWrites = 0;

  static {
    // A response made by the constructor (see `isResponse()`)
    brandResponses((value) => #observers in value);
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
    // What the methods of the listeners throw (e.g. the error of Node.js
    // for a listener that is not a function, of a listener itself, or of an
    // event name that it cannot convert) is formatted (see `formatStack()`),
    // inline: they are hot paths
    function rawListeners(
      this: BindenResponse,
      event: string | symbol,
    ): IListener[] {
      try {
        return rawListenersOf(this, event as string).map((raw) => {
          const binding = bindingOf(raw);
          return binding && !binding.once ? binding.listener : raw;
        });
      } catch (error: unknown) {
        throw formatStack(error as Error);
      }
    }
    function emit(
      this: BindenResponse,
      event: string | symbol,
      ...args: unknown[]
    ): boolean {
      try {
        if (event === "pipe") {
          this.#piping(args[0]);
        } else if (event === "unpipe") {
          this.#unpiped(args[0]);
        } else if (event === "socket") {
          // Before its listeners, and before Node.js flushes the response
          this.#assigned(args[0] as Duplex);
        } else if (
          event === "error" &&
          this.#absorbing.has(owners.getStore() as object)
        ) {
          // Re-emitted by a listener of an abandoned work (e.g. the pipe of
          // Node.js once it has unpiped): the framework handles the error
          return false;
        }
        return this.#emit(event, args);
      } catch (error: unknown) {
        throw formatStack(error as Error);
      }
    }
    // The listeners added by the application run as the work that has added
    // them (see `bind()`), never as whoever emits their event. Replaced at
    // run time only: the types are those of Node.js.
    const add = (
      name: "addListener" | "on" | "prependListener",
      once: boolean,
    ): ((
      this: BindenResponse,
      event: string | symbol,
      listener: IListener,
    ) => BindenResponse) =>
      function listen(this: BindenResponse, event, listener) {
        try {
          const owner = owners.getStore();
          const bound = bind(
            listener,
            owner,
            "user",
            once ? { emitter: this, event } : null,
          );
          const result = parent[name].call(
            this,
            event,
            bound,
          ) as BindenResponse;
          if (event === "close") {
            this.#late(owner, bound);
          }
          return result;
        } catch (error: unknown) {
          throw formatStack(error as Error);
        }
      };
    // Writable, as the methods of Node.js: an instrumentation may wrap them
    // on a response (its wrapper calls them)
    const method = (value: unknown): PropertyDescriptor => ({
      configurable: true,
      writable: true,
      value,
    });
    Object.defineProperties(this.prototype, {
      addListener: method(add("addListener", false)),
      on: method(add("on", false)),
      once: method(add("on", true)),
      prependListener: method(add("prependListener", false)),
      prependOnceListener: method(add("prependListener", true)),
      // As Node.js: the listener itself, but the wrapper of a `once()`
      rawListeners: method(rawListeners),
      // A source piped into the response is adopted before any listener of
      // `pipe` runs (see `#adopt()`)
      emit: method(emit),
    });
    // Nor how it is framed: whether it sends a `Date`, keeps its connection
    // open (or says that it closes it), chunks its body (also by default) or
    // checks its length. Node.js sets them in the calls of the work that may
    // mutate the response (e.g. as it commits the headers), the framework
    // with its rights (e.g. at a shutdown). The other fields of Node.js are
    // its own state (e.g. `finished`, `outputData`, and those whose name
    // starts with `_`, such as `_hasBody`), which only its code writes: an
    // application never assigns them.
    for (const name of Object.keys(initial) as (keyof IConnection)[]) {
      Object.defineProperty(this.prototype, name, {
        configurable: true,
        enumerable: true,
        get(this: BindenResponse): boolean {
          return (connections.get(this) as IConnection)[name];
        },
        set(this: BindenResponse, value: boolean): void {
          // Set by the constructors of Node.js before the fields exist
          if (#seals in this && !this.#allows()) {
            return;
          }
          const connection = connections.get(this);
          if (connection) {
            connection[name] = value;
          } else {
            connections.set(this, { ...initial, [name]: value });
          }
        },
      });
    }
  }

  /** A response to the request (created by the server) */
  public constructor(...args: [request: Request, options?: unknown]) {
    // node:http passes its options as well
    super(...(args as [Request]));
  }

  /**
   * A source is piped into the response (`pipe` of `Readable.pipe()`, emitted
   * synchronously in the work that pipes): it starts the response of a work
   * that may mutate it, and is adopted (see `#adopt()`)
   */
  #piping(source: unknown): void {
    const owner = owners.getStore();
    if (isProxy(source)) {
      // Before any inspection (even `instanceof`), which would run its traps
      this.#refuse(source as EventEmitter, owner, "the source is a proxy");
    } else if (source instanceof EventEmitter) {
      this.#adopt(source as EventEmitter, owner);
    }
  }

  /**
   * Adopts a source that `Readable.prototype.pipe()` has just piped into the
   * response, before any listener of `pipe` runs: its writes (the last `data`
   * listener, which the pipe has just added) and its end (the last `end`
   * listener, unless it has ended already: its end is then scheduled in the
   * work that pipes) run as the work that has piped it, whose rights they
   * keep, whatever work pushes its chunks. Until the end of the turn, the
   * listeners added to the source are bound to the work that adds them (see
   * `openWindow()`), and a source piped by an error handler that fails before
   * its end fails it (see `#guard()`).
   *
   * The pipe is adopted only when nothing but the class of the source (which
   * is trusted, as the stream that the work has chosen) can have added a
   * listener during the pipe (see `#refusal()`): otherwise it is refused
   * (see `#refuse()`), and the work that has piped it fails, unless it is a
   * pipe of the stack that is left to Node.js (see `#leave()`).
   */
  #adopt(source: EventEmitter, owner: object | undefined): void {
    const refusal = this.#refusal(source);
    if (refusal !== null) {
      if (
        refusal.native &&
        typeof owner !== "undefined" &&
        this.#ownership.native(owner) &&
        this.#allows(owner)
      ) {
        this.#leave(source, owner, refusal.reason);
      } else {
        this.#refuse(source, owner, refusal.reason);
      }
      return;
    } else if (!openWindow(source)) {
      this.#refuse(source, owner, "its listeners cannot be bound");
      return;
    }
    this.#start(owner);
    this.#sourcesOf(owner).add(source);
    // A write of the pipe that throws (e.g. a head that Node.js refuses) is
    // caught by the pipe, which destroys the response with it (see
    // `destroy()`); by a pipe that does not catch it (e.g. of
    // `readable-stream`, whose source would get it), it fails the pipe here
    const data = rawListenersOf(source, "data").at(-1) as IListener;
    replaceListener(
      source,
      "data",
      data,
      bind(bindingOf(data)?.listener ?? data, owner, "source", null, (call) => {
        const marker = this.#marker;
        this.#marker = { owner, source };
        try {
          return call();
        } catch (error: unknown) {
          if (this.#pipeFailed(owner, error, source)) {
            return null;
          }
          throw error;
        } finally {
          this.#marker = marker;
        }
      }),
    );
    if (!hasEnded(source)) {
      // Its end (e.g. `dest.end()` into a head that Node.js refuses) throws
      // out of the events of the source: the pipe fails instead
      const end = rawListenersOf(source, "end").at(-1) as IListener & {
        listener: IListener;
      };
      replaceListener(
        source,
        "end",
        end,
        bind(
          end.listener,
          owner,
          "source",
          { emitter: source, event: "end" },
          (call) => {
            try {
              return call();
            } catch (error: unknown) {
              if (this.#pipeFailed(owner, error, source)) {
                return null;
              }
              throw error;
            }
          },
        ),
      );
    }
    this.#guard(source, owner);
  }

  /**
   * A pipe that may write starts the response of a work that may mutate it
   * (see `started`): never one that is refused, which writes nothing
   */
  #start(owner: object | undefined): void {
    if (this.#allows(owner)) {
      this.#piped = true;
    }
  }

  /** The sources piped by a work (see `#adopt()`) */
  #sourcesOf(owner: object | undefined): Set<EventEmitter> {
    let sources = this.#sources.get(owner);
    if (typeof sources === "undefined") {
      sources = new Set();
      this.#sources.set(owner, sources);
    }
    return sources;
  }

  /**
   * Why a pipe cannot be adopted (`null` when it can): code other than the
   * class of the source may have added a listener during the pipe (a
   * listener of `newListener` or `removeListener` of the source or of the
   * response, or a method or an accessor of the source itself that the pipe
   * calls or reads, see `read`), or it is not a pipe of
   * `Readable.prototype.pipe()` (e.g. the legacy
   * `Stream.prototype.pipe()`), whose last `data` listener and `end` wrapper
   * it has just added. The source is inspected by the methods of every
   * emitter, never by its own ones. A source whose only methods of its own
   * are listener methods (see `wrappers`, e.g. bound by an instrumentation),
   * and that passes every other check, may be left to Node.js (`native`).
   */
  #refusal(source: EventEmitter): IRefusal | null {
    const listens = (emitter: EventEmitter): boolean =>
      intrinsic.listenerCount.call(emitter, "newListener") +
        intrinsic.listenerCount.call(emitter, "removeListener") >
      0;
    if (listens(source)) {
      return refused("the source has listeners of its listeners");
    } else if (listens(this)) {
      return refused("the response has listeners of its listeners");
    }
    const accessor = accessorOf(source);
    if (typeof accessor !== "undefined") {
      return refused(`the source has an accessor of its own (${accessor})`);
    }
    const own = inspected.filter(
      (name) => Object.hasOwn(source, name) && !isPatch(source, name),
    );
    const other = own.find((name) => !wrappers.has(name));
    if (typeof other !== "undefined") {
      return refused(`the source has its own ${other}()`);
    } else if (!pipesInto(source, this)) {
      return refused("it is not a pipe of Readable.prototype.pipe()");
    }
    const data = rawListenersOf(source, "data").at(-1);
    const plain =
      bindingOf(data)?.once === false ||
      (typeof data === "function" && !("listener" in data));
    if (!plain) {
      return refused("its data listener is not the one of the pipe");
    }
    const end = rawListenersOf(source, "end").at(-1);
    const once =
      typeof end === "function" &&
      typeof (end as { listener?: unknown }).listener === "function";
    if (!once && !hasEnded(source)) {
      return refused("its end listener is not the one of the pipe");
    }
    const [wrapper] = own;
    return typeof wrapper === "undefined"
      ? null
      : { reason: `the source has its own ${wrapper}()`, native: true };
  }

  /**
   * Leaves a pipe of the stack to Node.js (see `IOwnership.native()`), while
   * the stack may mutate the response: its source has listener methods of
   * its own (e.g. bound by the context of an instrumentation, such as
   * `context.bind()` of OpenTelemetry), which may have added any listener
   * during the pipe, so that nothing of it can be attributed. It is not
   * adopted (nothing of it gets the rights of the stack), and runs as without
   * binden: before the exchange is sealed, every work may mutate the
   * response. It is kept, to be dismantled once the stack is revoked (see
   * `#dismantle()`); a pipe of a stack that has been revoked is refused.
   */
  #leave(source: EventEmitter, owner: object, reason: string): void {
    this.#start(owner);
    let sources = this.#natives.get(owner);
    if (typeof sources === "undefined") {
      sources = new Map();
      this.#natives.set(owner, sources);
    }
    sources.set(source, reason);
    this.#ownership.note("A pipe has been left to Node.js", reason);
  }

  /**
   * Dismantles the pipes of a revoked work that it has left to Node.js (see
   * `#leave()`), before anything replaces the reply of the work: each source
   * is unpiped by the method of its class, as that work. Nothing proves that
   * no callback of such a pipe is left, whatever its source reports (e.g.
   * that it has ended): its methods of its own may have kept a listener of
   * the pipe, or wrapped one (e.g. its end, which would end the reply that
   * replaces it). Unless the response has ended (its reply is complete:
   * nothing replaces it), the response and its connection are closed, with
   * the rights of the framework, so that nothing replaces the reply.
   */
  #dismantle(owner: object, sources: ReadonlyMap<EventEmitter, string>): void {
    for (const source of sources.keys()) {
      try {
        as(owner, () => {
          unpipe(source, this);
        });
      } catch (cleanup: unknown) {
        const message = "The cleanup of a pipe left to Node.js has failed";
        this.#ownership.debug(message, cleanup);
      }
    }
    if (!this.writableEnded) {
      const message =
        "A pipe left to Node.js by an abandoned work may still write. Destroying the socket";
      // Why the first one has been left to Node.js (see `#leave()`)
      const [reason] = sources.values();
      this.#ownership.note(message, reason);
      this[kFramework](() => {
        this.destroy();
      });
    }
  }

  /**
   * Refuses a pipe (see `#refusal()`): the work that has piped it fails at
   * once with a `TypeError` (see `#pipeFailed()`), which revokes it before
   * anything runs code of the application, and closes the response for it
   * (see `[kRevoke]()`). Then it is unpiped (by the method of the class of
   * the source) in that work, which may no longer mutate the response (e.g.
   * from a listener of `removeListener` of the source): a failure of that
   * cleanup is only logged. A legacy pipe, which has no `unpipe()`, is
   * dismantled by its `close` listener, which runs as that work once it is
   * told. The pipe of a work that the framework does not know (e.g. of no
   * request, or of another request), which it does not fail, is unpiped as
   * well, and the response left to its owner; a legacy one cannot be (nor
   * closed for such a work): it is left to Node.js, with a warning of its
   * own.
   */
  #refuse(
    source: EventEmitter,
    owner: object | undefined,
    reason: string,
  ): void {
    // Formatted (see `formatStack()`): its work fails with it
    const error = formatStack(
      new TypeError(`The pipe into the response is refused: ${reason}`),
    );
    const failed = this.#pipeFailed(owner, error, null);
    let unpiped = false;
    try {
      unpiped = unpipe(source, this);
    } catch (cleanup: unknown) {
      const message = "The cleanup of a refused pipe has failed";
      this.#ownership.debug(message, cleanup);
    }
    if (failed) {
      return;
    }
    const message = unpiped
      ? "A pipe of a work of no request (or of another) has been refused"
      : "A pipe of a work of no request (or of another) cannot be unpiped (e.g. a legacy pipe): it has been left to Node.js";
    this.#ownership.warn(message, reason);
  }

  /**
   * A source piped by a work that the framework guards (see
   * `IOwnership.guards()`, e.g. an error handler): when it errors or closes
   * before its end, the work fails (Node.js would leave the response open,
   * the work waiting). Guarded until it is unpiped.
   */
  #guard(source: EventEmitter, owner: object | undefined): void {
    if (typeof owner === "undefined" || !this.#ownership.guards(owner)) {
      return;
    }
    const failed = (error: unknown): void => {
      if (!hasEnded(source)) {
        this.#pipeFailed(owner, error, source);
      }
    };
    const guards: [string, IListener][] = [
      ["error", failed],
      [
        "close",
        (): void => {
          failed(BindenResponse.#premature());
        },
      ],
    ];
    this.#unguard(source);
    for (const [event, listener] of guards) {
      intrinsic.prependListener.call(source, event, listener);
    }
    this.#guards.set(source, guards);
  }

  /**
   * A source is unpiped: it is no longer guarded (see `#guard()`), nor kept
   * to be unpiped (see `#deliver()`)
   */
  #unpiped(source: unknown): void {
    for (const sources of this.#sources.values()) {
      sources.delete(source as EventEmitter);
    }
    this.#unguard(source);
  }

  /** A source is no longer guarded (see `#guard()`) */
  #unguard(source: unknown): void {
    const guards = this.#guards.get(source as EventEmitter);
    if (typeof guards !== "undefined") {
      this.#guards.delete(source as EventEmitter);
      for (const [event, listener] of guards) {
        intrinsic.removeListener.call(source, event, listener);
      }
    }
  }

  /**
   * A pipe of a work into the response has failed: the framework handles it
   * (see `IOwnership.fail()`), unless it does not know the work (e.g. of no
   * request). `true` once handled. Its source, if any, is unpiped once the
   * work has been told (see `[kRevoke]()`).
   */
  #pipeFailed(
    owner: object | undefined,
    error: unknown,
    source: EventEmitter | null,
  ): boolean {
    if (source !== null) {
      this.#sourcesOf(owner).add(source);
    }
    return typeof owner !== "undefined" && this.#ownership.fail(owner, error);
  }

  /**
   * A `close` listener of a work that has been told already that it may no
   * longer mutate the response (see `[kRevoke]()`): it runs on the next tick,
   * once, unless removed before
   */
  #late(owner: object | undefined, bound: IListener): void {
    if (typeof owner !== "undefined" && this.#revoked.get(owner) === true) {
      process.nextTick(() => {
        if (rawListenersOf(this, "close").includes(bound)) {
          intrinsic.removeListener.call(this, "close", bound);
          this.#safely(bound, []);
        }
      });
    }
  }

  /**
   * Tells a work that it may no longer mutate the response: its `error`
   * listeners get the error of its failure (if any), then its `close`
   * listeners run once (and are removed), as their own work, as if the
   * response had been closed; the sources that it has piped and that are
   * still piped are then unpiped (a failure of that cleanup, e.g. of a
   * hostile source, is only logged). Never the listeners of another work, nor
   * those of the framework, which get the real `close`.
   */
  #deliver(owner: object, failure: [unknown] | null): void {
    const own = (event: string): IListener[] =>
      rawListenersOf(this, event).filter((raw) => {
        const binding = bindingOf(raw);
        return binding?.kind === "user" && binding.owner === owner;
      });
    this.#absorbing.add(owner);
    try {
      if (failure !== null) {
        for (const listener of own("error")) {
          this.#safely(listener, failure);
        }
      }
      for (const listener of own("close")) {
        intrinsic.removeListener.call(this, "close", listener);
        this.#safely(listener, []);
      }
    } finally {
      this.#absorbing.delete(owner);
    }
    for (const source of this.#sources.get(owner) ?? []) {
      // Code of the application (e.g. a getter of the source, or its
      // `unpipe()`), on a tick of its own: a failure is only logged, and the
      // other sources are unpiped all the same
      try {
        unpipe(source, this);
      } catch (error: unknown) {
        const message =
          "The unpipe of a source of an abandoned work has failed";
        this.#ownership.debug(message, error);
      }
    }
    this.#sources.delete(owner);
    const natives = this.#natives.get(owner);
    if (typeof natives !== "undefined") {
      this.#natives.delete(owner);
      this.#dismantle(owner, natives);
    }
  }

  /** Runs a listener of an abandoned work: its failure is only logged */
  #safely(listener: IListener, args: unknown[]): void {
    try {
      Reflect.apply(listener, this, args);
    } catch (error: unknown) {
      const message = "A listener of an abandoned work has failed";
      this.#ownership.debug(message, error);
    }
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
   * piped into it (until a deadline cancels it before it has written
   * anything; never by a refused pipe), or by its headers being sent
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

  /**
   * Set the status code: an integer from 100 to 599 (anything else throws a
   * `TypeError`, see `described()`)
   */
  public status(code: number): this {
    if (!this.#allows()) {
      return this;
    } else if (!isStatus(code)) {
      throw formatStack(
        new TypeError(`Status code ${described(code)} is invalid`),
      );
    }
    this.statusCode = code;
    return this;
  }

  /**
   * Set headers: the own properties of the object (not inherited ones).
   * Anything but an object (e.g. `null` or a string, whose characters would
   * be headers) throws a `TypeError`, and so does what reading the object
   * throws (e.g. of a revoked proxy), formatted (see `formatStack()`).
   */
  public set(headers: IHeaders): this {
    if (!this.#allows()) {
      return this;
    }
    // Checked as given (e.g. `null` by JavaScript)
    const given: unknown = headers;
    if (typeof given !== "object" || given === null) {
      throw formatStack(new TypeError("`headers` is not an object"));
    }
    for (const [name, value] of formatting(() => Object.entries(headers))) {
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
      typeof media_type === "string" && isStrictMediaType(media_type)
        ? ContentType.fromString(media_type)
        : null;
    if (parsed === null) {
      throw formatStack(
        new TypeError(`Invalid media type: ${described(media_type)}`),
      );
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
   * (once each, case-insensitively); `*` replaces them all. A name that is
   * not a token (also anything but a string) throws a `TypeError` before
   * anything is changed.
   */
  public vary(...fields: string[]): this {
    if (!this.#allows()) {
      return this;
    }
    for (const field of fields) {
      // A string before the regular expression, which would convert it
      const given: unknown = field;
      if (typeof given !== "string" || !fieldName.test(given)) {
        throw formatStack(
          new TypeError(`Invalid field name: ${described(given)}`),
        );
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
   * An invalid name or attribute throws a `TypeError` (see `Cookie`), and so
   * does what reading the attributes throws (e.g. of a revoked proxy),
   * formatted (see `formatting()`).
   */
  public clearCookie(name: string, attributes: IClearCookie = {}): this {
    if (!this.#allows()) {
      return this;
    }
    const given = formatting(() => ({ ...attributes }));
    const cookie = new Cookie({
      ...given,
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
    // What it throws is formatted (see `formatStack()`), e.g. the errors of
    // Node.js for a status code or a header that it refuses, or what the
    // `toString()` of a cookie throws
    try {
      return this.#writeHead(statusCode, reason, headers);
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /** `writeHead()`, which may throw an error that is not formatted */
  #writeHead(
    statusCode: number,
    reason?: OutgoingHttpHeader[] | OutgoingHttpHeaders | string,
    headers?: OutgoingHttpHeader[] | OutgoingHttpHeaders,
  ): this {
    if (!this.#allows()) {
      return this;
    } else if (this.headersSent) {
      // Node.js throws `ERR_HTTP_HEADERS_SENT` before it reads anything
      return super.writeHead(statusCode, reason as string, headers);
    }
    // The status of the response itself (e.g. of `flushHeaders()`, whose
    // head Node.js commits by it): converted once, and that number is stored
    // before anything else is checked (see `#status()`), as Node.js stores
    // it before it refuses a reason phrase, so that another attempt does not
    // convert it again. A status given (or a number, which converts without
    // side effects) is converted by the check alone: a refused call changes
    // nothing
    const own =
      typeof statusCode !== "number" &&
      (statusCode as unknown) === (this.#statusCode as unknown)
        ? this.#status()
        : statusCode;
    // Node.js would throw only once it has changed the response (its status
    // and reason phrase, and some of the headers). Read once, and checked:
    // Node.js gets exactly these (see `IHead`)
    const [code, message, given] = this[kValidateHead](own, reason, headers);
    const write = (
      fields: OutgoingHttpHeader[] | OutgoingHttpHeaders | undefined,
    ): this => {
      if (typeof message === "string") {
        return super.writeHead(code, message, fields);
      }
      return super.writeHead(code, fields);
    };
    return this.#restoring(() => {
      if (this.cookies.size === 0) {
        return write(given);
      }
      // Not sent when Node.js refuses the head (e.g. an invalid status code):
      // the next attempt adds them
      const [explicit, rest] = BindenResponse.#takeSetCookie(given);
      const values = [...this.cookies].map((cookie) => cookie.toString());
      this.setHeader("Set-Cookie", [
        ...(explicit ?? BindenResponse.#values(this.getHeader("Set-Cookie"))),
        ...values,
      ]);
      return write(rest);
    });
  }

  /**
   * Runs a call that may commit the head of the response (`writeHead()`, a
   * `write()`, which counts the bytes of its chunk first for
   * `strictContentLength`, or an `end()`, which also sets the length of its
   * chunk): when Node.js refuses the head (e.g. a `Trailer` of a body that is
   * not chunked, once it has decided to close the connection), the framing
   * state of the response is the one from before the call (see
   * `IFramingState`), so that the reply that follows (e.g. of an error) is
   * framed as if the refused head had never been attempted
   */
  #restoring<T>(fn: () => T): T {
    if (this.headersSent) {
      return fn();
    }
    const state = this[kSaveFraming]();
    try {
      return fn();
    } catch (error: unknown) {
      // Not when it has committed the head (e.g. a failure of a later write)
      if (!this.#committed()) {
        this[kRestoreFraming](state);
      }
      throw error;
    }
  }

  /** Whether the head of the response has been committed (see `headersSent`) */
  #committed(): boolean {
    return this.headersSent;
  }

  /**
   * Saves the framing state of the response (see `IFramingState`)
   *
   * @internal
   */
  public [kSaveFraming](): IFramingState {
    return {
      status: this.#statusCode,
      reason: this.#statusMessage,
      fields: [...framingFields, ...framingCounters].map((key) => [
        key,
        Reflect.get(this, key),
      ]),
      headers: (this as unknown as { getRawHeaderNames(): string[] })
        .getRawHeaderNames()
        .map((name) => [
          name,
          this.getHeader(name) as number | string | string[],
        ]),
      generation: this.#framing,
    };
  }

  /**
   * Restores a framing state saved by `[kSaveFraming]()`, with the rights of
   * the framework: the headers, then the fields (removing a header sets some
   * of them), the status and the reason phrase
   *
   * @internal
   */
  public [kRestoreFraming](state: IFramingState): void {
    // What reading the state throws is formatted (see `formatStack()`)
    try {
      this[kFramework](() => {
        // Set again only when they have changed: `setHeader()` of Node.js
        // converts a value of another type as it checks it (e.g. a
        // `Content-Length` that binden has refused, see `kValidateHead`)
        if (!this.#hasHeaders(state.headers)) {
          for (const name of this.getHeaderNames()) {
            super.removeHeader(name);
          }
          for (const [name, value] of state.headers) {
            super.setHeader(name, BindenResponse.#copy(value));
          }
        }
        for (const [name, value] of state.fields) {
          Reflect.set(this, name, value);
        }
      });
      this.#statusCode = state.status;
      this.#statusMessage = state.reason;
      this.#framing = state.generation;
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /**
   * Whether the response has these headers (see `IFramingState`): the same
   * names, in the same order and case, and the same values (each element of
   * an array)
   */
  #hasHeaders(headers: IFramingState["headers"]): boolean {
    const names = (
      this as unknown as { getRawHeaderNames(): string[] }
    ).getRawHeaderNames();
    return (
      names.length === headers.length &&
      headers.every(([name, value], index) => {
        const current: unknown = super.getHeader(name);
        return (
          names[index] === name &&
          (Array.isArray(value)
            ? Array.isArray(current) &&
              current.length === value.length &&
              value.every((element, at) => current[at] === element)
            : current === value)
        );
      })
    );
  }

  /**
   * Checks the arguments of `writeHead()` as Node.js does, without changing
   * the response (see `kValidateHead`), and returns them as Node.js gets them
   * (see `IHead`): each is read once, and converted no more than Node.js
   * converts it. The status code is converted once, as Node.js converts it,
   * and refused as Node.js refuses it (`ERR_HTTP_INVALID_STATUS_CODE`, the
   * value given in its message, as Node.js formats it). Then the reason
   * phrase that it would send (the one given, or else the one of the
   * response), and the names and the values of the headers given (a list must
   * be of pairs), as copies (see `headersOf()`): a name that is not a string,
   * and a value of another type (see `inert()`), which Node.js converts as it
   * checks them, are left to Node.js. The `Content-Length` values that the head would have (the ones given, or
   * else the ones set) must each be a number or a string, checked before
   * anything converts them (also a hole of an array, see `lengthValues()`),
   * and be neither a list nor disagree (see `lengthRefusal()`): every path
   * that commits the head runs `writeHead()` (also a first `write()`, an
   * `end()` and `flushHeaders()`), which then throws
   * `ERR_HTTP_INVALID_HEADER_VALUE` before anything is committed.
   *
   * @internal
   */
  public [kValidateHead](...args: unknown[]): IHead {
    // What it throws is formatted (see `formatStack()`), e.g. the errors of
    // Node.js for a header that it refuses
    try {
      return this.#validateHead(args);
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /**
   * A status code converted once, as `writeHead()` of Node.js converts it
   * (`| 0`), and refused out of range as Node.js refuses it
   * (`ERR_HTTP_INVALID_STATUS_CODE`, with the value given in its message, as
   * Node.js formats it)
   */
  static #statusOf(statusCode: unknown): number {
    const code = (statusCode as number) | 0;
    if (code < 100 || code > 999) {
      throw Object.assign(
        formatStack(
          new RangeError(format("Invalid status code: %s", statusCode)),
        ),
        { code: "ERR_HTTP_INVALID_STATUS_CODE" },
      );
    }
    return code;
  }

  /**
   * The status code that binden decides by before the head is committed by
   * a first `write()`, an `end()` with a chunk, or a send (see `#hasBody()`,
   * `#bodiless()`): the integer that Node.js commits (it converts the status
   * by `| 0`, then sets that number). One that is not a number (e.g. an
   * object or a string assigned to `statusCode`) is converted once (see
   * `#statusOf()`), and that number is the status of the response from then
   * on: converted as often as by plain Node.js. One that its conversion
   * refuses (or that throws as it is converted) is left as it is, and the
   * call throws, before anything is changed. A number is truncated as
   * Node.js truncates it, which leaves an integer as it is (e.g. `204.5` is a
   * `204`, without a body nor its length): one in range is the status from
   * then on, and one out of range is left as it is, which Node.js refuses as
   * it commits the head, by the value given.
   */
  #status(): number {
    const status = this.#statusCode;
    if (this.headersSent) {
      return status;
    } else if (typeof status === "number") {
      const code = status | 0;
      if (code >= 100 && code <= 999) {
        this.#statusCode = code;
      }
      return code;
    }
    const code = BindenResponse.#statusOf(status);
    this.#statusCode = code;
    return code;
  }

  /** `[kValidateHead]()`, which may throw an error that is not formatted */
  #validateHead(args: readonly unknown[]): IHead {
    if (this.headersSent) {
      // As `writeHead()` of Node.js, before it reads anything
      throw BindenResponse.#headersSent();
    }
    const [statusCode, reason, headers] = args;
    // Converted once, as Node.js converts it (which gets the number)
    const code = BindenResponse.#statusOf(statusCode);
    const message = typeof reason === "string" ? reason : this.statusMessage;
    if (typeof message === "string" && invalidReason.test(message)) {
      throw Object.assign(
        formatStack(new TypeError("Invalid character in statusMessage")),
        {
          code: "ERR_INVALID_CHAR",
        },
      );
    }
    // As `writeHead()` of Node.js: the headers follow a reason phrase, or are
    // the second argument. Read once: Node.js gets the copies
    const given = headersOf(
      typeof reason === "string" ? headers : (headers ?? reason),
    );
    const pairs: unknown[] = Array.isArray(given)
      ? Array.isArray(given[0])
        ? given.flat()
        : given
      : Object.entries(given ?? {}).flat();
    if (pairs.length % 2 !== 0) {
      throw Object.assign(
        formatStack(new TypeError("The argument 'headers' is invalid")),
        {
          code: "ERR_INVALID_ARG_VALUE",
        },
      );
    }
    /** The `Content-Length` values given, which replace the ones set */
    let lengths: (number | string)[] | null = null;
    for (let index = 0; index < pairs.length; index += 2) {
      const name = pairs[index];
      const value = pairs[index + 1];
      // Node.js skips an empty name (of the headers that it sets), and
      // refuses one that is not a string itself (converting it as it
      // describes it)
      if (typeof name === "string" && name !== "") {
        validateHeaderName(name);
        if (name.toLowerCase() === "content-length") {
          // Each a number or a string, before anything converts it (see
          // `lengthValues()`): also a value that is not an array (e.g.
          // `undefined`), and a hole of an array
          (lengths ??= []).push(
            ...lengthValues(Array.isArray(value) ? value : [value]),
          );
        }
        // Also an array (of the values of the header) or a number, but
        // never converted (see `inert()`)
        if (inert(value)) {
          validateHeaderValue(name, value as string);
        }
      }
    }
    // Each a number or a string (see `lengthValues()`), never converted
    const refusal = lengthRefusal(
      lengths ?? lengthValues(this.getHeader("Content-Length")),
    );
    if (refusal !== null) {
      throw Object.assign(formatStack(new TypeError(refusal)), {
        code: "ERR_HTTP_INVALID_HEADER_VALUE",
      });
    }
    return [
      code,
      typeof reason === "string" ? reason : null,
      given as IHead[2],
    ];
  }

  /**
   * `writeHead()` by its deprecated alias (DEP0063), which Node.js 24 still
   * has: on every version, it is `writeHead()` of the response, with its
   * cookies and its guard once the response is sealed (the alias of Node.js
   * would send the headers past both)
   */
  public writeHeader(
    statusCode: number,
    statusMessage?: string,
    headers?: OutgoingHttpHeader[] | OutgoingHttpHeaders,
  ): this;
  /** `writeHead()` without a reason phrase, by its deprecated alias */
  public writeHeader(
    statusCode: number,
    headers?: OutgoingHttpHeader[] | OutgoingHttpHeaders,
  ): this;
  public writeHeader(...args: unknown[]): this {
    // The method of the response itself (e.g. of a compression, or of a
    // subclass): what it throws is formatted (see `formatStack()`)
    try {
      return this.writeHead(...(args as [number, string]));
    } catch (error: unknown) {
      throw formatStack(error as Error);
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
    // What it throws is formatted (see `formatStack()`), e.g. the errors of
    // Node.js for a chunk that it refuses, or what the `toString()` of a
    // cookie throws as the head is committed: inline, a hot path
    try {
      if (!this.#allows()) {
        BindenResponse.#ignore(args);
        return true;
      }
      const [chunk] = args;
      if (typeof chunk !== "string" && !isUint8Array(chunk)) {
        // Refused by Node.js before anything else (e.g. `null`), whatever the
        // state of the response
        return super.write(...(args as [unknown]));
      }
      const written = this.#normalized(args, false);
      this.#beyond(written);
      // Node.js counts the bytes of its chunk before it commits the head (see
      // `#restoring()`)
      return this.#stopping(() =>
        this.#restoring(() => {
          this.#ordered(written, false);
          return super.write(...(callbacksOf(written) as [unknown]));
        }),
      );
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /**
   * Refuses the chunk of a `write()` past the `Content-Length` of a body
   * under `strictContentLength` while the head is not generated, with the
   * error of Node.js (`ERR_HTTP_CONTENT_LENGTH_MISMATCH`), before Node.js
   * gets it: Node.js reads the length from the head that it generates, so
   * that it checks only the chunks that follow it, and would write all of
   * the first one, whose excess the client would read as the next response
   * of the connection. Nothing is committed: the response stays usable (e.g.
   * for the reply of the error). The chunk is checked as Node.js checks the
   * others (by a message of its own, whose head cannot be generated): in its
   * bytes, for a valid `Content-Length` of a body (not to `HEAD`, nor with a
   * 204 or a 304 status) that is not chunked.
   */
  #beyond(args: readonly unknown[]): void {
    const [chunk] = args;
    if (
      this.strictContentLength &&
      !this.#committed() &&
      this.#writes(chunk, false) &&
      !this.hasHeader("Transfer-Encoding")
    ) {
      const message = new OutgoingMessage();
      Reflect.set(message, "strictContentLength", true);
      // Not checked without a valid length (`null`)
      Reflect.set(message, "_contentLength", this.#length());
      const encoding = BindenResponse.#encodingOf(args);
      try {
        message.write(chunk, (encoding ?? "utf8") as BufferEncoding);
      } catch (error: unknown) {
        // Within the length, the message cannot generate its head
        if (property(error, "code") === "ERR_HTTP_CONTENT_LENGTH_MISMATCH") {
          throw error;
        }
      }
    }
  }

  /**
   * Runs a `write()` or an `end()` of Node.js, whose chunk and encoding have
   * been checked (a chunk that is not one, or an unknown encoding, throws
   * before anything is changed, see `#normalized()`): when it throws once the
   * head is committed (before the call, or by it), nothing more of the
   * response is sent. Node.js may have written the head and the chunk into
   * the socket that it has corked before it throws (e.g. a body longer or
   * shorter than the `Content-Length` that `strictContentLength` checks):
   * flushing them would send a head that the body contradicts, whose excess
   * the client would read as the next response of the connection. The
   * response is destroyed at once, with the rights of the framework, before
   * the error is thrown, so that neither the cork of `end()` nor the one that
   * Node.js releases on the next tick flushes them, and a response that waits
   * for the one before it is cut once its socket comes (see `destroy()`). The
   * bytes of an earlier write that has been flushed are not recalled. An error
   * that leaves what is queued valid (see `keeping`, e.g.
   * `ERR_HTTP_BODY_NOT_ALLOWED`, which Node.js throws for a body written to
   * `HEAD` once it has generated the head, and queued nothing more) leaves the
   * response usable, as Node.js does: an `end()` that follows sends a
   * complete reply.
   */
  #stopping<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error: unknown) {
      if (this.#committed() && !keeping.has(property(error, "code"))) {
        this[kFramework](() => this.destroy());
      }
      throw error;
    }
  }

  /**
   * Whether Node.js writes the chunk of a write (or of an `end()`) of the
   * body. It ignores a falsy chunk of `end()`, the chunks of a response that
   * has ended or is destroyed (their callback gets the error), and of one
   * without a body (e.g. to `HEAD`); it refuses a chunk that is neither a
   * string nor bytes (e.g. `null`) before it changes anything.
   */
  #writes(chunk: unknown, end: boolean): boolean {
    return !(
      (end && !truthy(chunk)) ||
      Reflect.get(this, "finished") === true ||
      this.destroyed ||
      (typeof chunk !== "string" && !isUint8Array(chunk)) ||
      !this.#hasBody()
    );
  }

  /**
   * The encoding of a write (or of an `end()`), as Node.js reads it: a falsy
   * one (e.g. `undefined`) or a callback in its place is none (`null`)
   */
  static #encodingOf(args: readonly unknown[]): unknown {
    const [, second] = args;
    return typeof second === "function" || !truthy(second) ? null : second;
  }

  /**
   * The arguments of a write (or of an `end()`) of the body, once checked:
   * the chunk that Node.js writes is checked as Node.js checks it, but before
   * anything is sent, so that an unknown encoding throws
   * `ERR_UNKNOWN_ENCODING`, which Node.js throws only once the head is
   * committed (or, for a response that waits for the one before it, as it
   * flushes it later, out of any call: the process crashes).
   *
   * A string in an encoding whose length Node.js only estimates (`hex`,
   * `base64` and `base64url`, in any case) is then the bytes that
   * `Buffer.from()` decodes, as on Node.js 26 (e.g. without the last digit of
   * an odd number of hex digits): Node.js would frame the body by the
   * estimate (e.g. one byte for the invalid `"zz"` in `hex`) but write fewer
   * bytes, so that the client would read the next response of the connection
   * as the rest of the body, and Node.js 24 aborts the process when it writes
   * an odd number of hex digits to the socket. An explicit `Content-Length`
   * is never changed: `strictContentLength` checks it against these bytes.
   */
  #normalized(args: readonly unknown[], end: boolean): unknown[] {
    const [chunk, ...rest] = args;
    const encoding = BindenResponse.#encodingOf(args);
    if (
      this.#writes(chunk, end) &&
      encoding !== null &&
      !(
        typeof encoding === "string" &&
        (Buffer.isEncoding(encoding) ||
          (typeof chunk !== "string" && encoding === "buffer"))
      )
    ) {
      throw Object.assign(
        formatStack(new TypeError(`Unknown encoding: ${described(encoding)}`)),
        { code: "ERR_UNKNOWN_ENCODING" },
      );
    } else if (
      typeof chunk === "string" &&
      chunk !== "" &&
      typeof encoding === "string" &&
      estimated.has(encoding.toLowerCase())
    ) {
      return [Buffer.from(chunk, encoding as BufferEncoding), ...rest];
    }
    return [...args];
  }

  /**
   * Keeps the order of a chunk (checked, see `#normalized()`) that would
   * commit the head while output is queued before it (e.g. a `103 Early
   * Hints` of a pipelined request, which waits for the response before it):
   * Node.js puts the head before what is queued when the chunk is bytes, or a
   * string in an encoding other than exactly `utf8`, `latin1` or none (e.g.
   * `utf-8`, `ucs2`), so that the client would read the informational
   * response as the body. The head is then committed by an empty `latin1`
   * write (which Node.js queues in order), framed as Node.js frames that
   * chunk (the only chunk of `end()` gives the `Content-Length` of a body
   * without one), and the chunk is written as it is.
   */
  #ordered(args: readonly unknown[], end: boolean): void {
    const [chunk] = args;
    const encoding = BindenResponse.#encodingOf(args);
    if (
      !this.#writes(chunk, end) ||
      // The state of the send queue of Node.js: the head has been queued, or
      // no output has
      Reflect.get(this, "_headerSent") === true ||
      Reflect.get(this, "outputSize") === 0 ||
      // Queued after the head by Node.js itself
      (typeof chunk === "string" &&
        (encoding === null || encoding === "utf8" || encoding === "latin1"))
    ) {
      return;
    }
    if (end && typeof Reflect.get(this, "_header") !== "string") {
      // As `end()` of Node.js: a body of one chunk has its length
      Reflect.set(
        this,
        "_contentLength",
        typeof chunk === "string"
          ? Buffer.byteLength(chunk, encoding as BufferEncoding)
          : (chunk as Uint8Array).byteLength,
      );
    }
    super.write("", "latin1");
  }

  /**
   * Whether Node.js writes the body of the response: not to `HEAD`, and not
   * with a 1xx, 204 or 304 status (which `writeHead()` applies)
   */
  #hasBody(): boolean {
    return (
      Reflect.get(this, "_hasBody") === true &&
      (Boolean(Reflect.get(this, "_header")) ||
        // Converted once (see `#status()`)
        BindenResponse.#withBody(this.#status()))
    );
  }

  /** Whether Node.js writes the body of a response of a status: not 1xx, 204 nor 304 */
  static #withBody(status: number): boolean {
    return !(
      BindenResponse.#informational(status) ||
      status === 204 ||
      status === 304
    );
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
    // What it throws is formatted (see `formatStack()`), as for `write()`:
    // inline, a hot path
    try {
      if (!this.#allows()) {
        BindenResponse.#ignore(args);
        return this;
      }
      this.#chunkOfEnd(args[0]);
      const ended = this.#normalized(args, true);
      // Node.js frames the body of its chunk before it commits the head (see
      // `#restoring()`)
      return this.#stopping(() =>
        this.#restoring(() => {
          this.#ordered(ended, true);
          return this.#uncorking(() =>
            super.end(...(callbacksOf(ended) as [])),
          );
        }),
      );
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /**
   * Refuses the chunk of an `end()` that Node.js refuses (truthy, but neither
   * a string nor bytes) with the error of Node.js, before its `end()` corks
   * the socket: its `write()` checks the chunk before anything else. Not once
   * the response has ended, where Node.js emits `ERR_STREAM_WRITE_AFTER_END`.
   */
  #chunkOfEnd(chunk: unknown): void {
    if (
      truthy(chunk) &&
      typeof chunk !== "function" &&
      typeof chunk !== "string" &&
      !isUint8Array(chunk) &&
      Reflect.get(this, "finished") !== true
    ) {
      super.write(chunk);
    }
  }

  /**
   * Runs `end()` of Node.js, which corks the socket before it frames the body
   * (and uncorks it once it has ended the response): when it throws for a
   * head that Node.js refuses (which stays uncommitted), the socket is
   * uncorked back to what it was, so that the reply that follows is not held
   * (e.g. a `flush()` would never resolve, and a body larger than the socket
   * buffers would wait for a `drain` that never comes). Never once the head
   * is committed: what the socket holds is not sent (see `#stopping()`).
   */
  #uncorking<T>(fn: () => T): T {
    const { socket } = this;
    const corked = socket?.writableCorked ?? 0;
    try {
      return fn();
    } catch (error: unknown) {
      if (socket !== null && !this.#committed()) {
        while (socket.writableCorked > corked) {
          socket.uncork();
        }
      }
      throw error;
    }
  }

  /**
   * Sends the headers (see `flushHeaders()` of Node.js), unless the response
   * is sealed: what it throws is formatted (see `formatStack()`), e.g. the
   * error of Node.js for a head that it refuses
   */
  public override flushHeaders(): void {
    try {
      if (this.#allows()) {
        super.flushHeaders();
      }
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /**
   * Sets a header (see `setHeader()` of Node.js), unless the response is
   * sealed. An array of values is copied: Node.js would keep the array itself,
   * which the work that set it could change later, also once it may no longer
   * change the response (as `appendHeader()` and `setHeaders()`, which set
   * their values through it).
   */
  public override setHeader(
    name: string,
    value: number | string | readonly string[],
  ): this {
    // What it throws is formatted (see `formatStack()`), e.g. the error of
    // Node.js for a name or a value that it refuses: inline, a hot path
    try {
      if (this.#allows()) {
        super.setHeader(name, BindenResponse.#copy(value));
        this.#reframed(name);
      }
      return this;
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /**
   * Advances the generation of the framing (see `#framing`) when a header
   * that frames the body has changed: once Node.js has accepted the change (a
   * name or a value that it refuses changes nothing), also to the same value
   */
  #reframed(name: string): void {
    if (framing.has(String(name).toLowerCase())) {
      this.#framing += 1;
    }
  }

  /**
   * A header (see `getHeader()` of Node.js): an array of values is a copy, so
   * that changing it does not change the response
   */
  public override getHeader(
    name: string,
  ): number | string | string[] | undefined {
    // What it throws is formatted (see `formatStack()`): inline, a hot path
    try {
      return BindenResponse.#copy(super.getHeader(name));
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /**
   * The headers (see `getHeaders()` of Node.js): the arrays of values are
   * copies, so that changing them does not change the response
   */
  public override getHeaders(): OutgoingHttpHeaders {
    const headers = super.getHeaders();
    for (const [name, value] of Object.entries(headers)) {
      headers[name] = BindenResponse.#copy(value);
    }
    return headers;
  }

  /** A copy of an array (of the values of a header), or the value itself */
  static #copy<T>(value: T): T {
    return Array.isArray(value) ? ([...(value as unknown[])] as T) : value;
  }

  /**
   * Appends a header (see `appendHeader()` of Node.js), unless the response
   * is sealed (what it throws is formatted, see `formatStack()`)
   */
  public override appendHeader(
    name: string,
    value: string | readonly string[],
  ): this {
    try {
      if (this.#allows()) {
        super.appendHeader(name, value);
        this.#reframed(name);
      }
      return this;
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /**
   * Sets headers (see `setHeaders()` of Node.js), unless the response is
   * sealed (what it throws is formatted, see `formatStack()`)
   */
  public override setHeaders(
    headers: Headers | Map<string, number | string | readonly string[]>,
  ): this {
    try {
      return this.#allows() ? super.setHeaders(headers) : this;
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /**
   * Sets the timeout of the socket (see `setTimeout()` of Node.js), unless the
   * response is sealed: the abandoned work cannot cut the reply of the
   * framework by the timeout of its connection (what it throws is formatted,
   * see `formatStack()`)
   */
  public override setTimeout(msecs: number, callback?: () => void): this {
    try {
      return this.#allows() ? super.setTimeout(msecs, callback) : this;
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /**
   * Removes a header (see `removeHeader()` of Node.js), unless the response
   * is sealed (what it throws is formatted, see `formatStack()`)
   */
  public override removeHeader(name: string): void {
    try {
      if (this.#allows()) {
        super.removeHeader(name);
        this.#reframed(name);
      }
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /**
   * Adds trailers (see `addTrailers()` of Node.js), unless the response is
   * sealed (what it throws is formatted, see `formatStack()`)
   */
  public override addTrailers(
    headers: OutgoingHttpHeaders | readonly [string, string][],
  ): void {
    try {
      if (this.#allows()) {
        super.addTrailers(
          trailersOf(headers) as OutgoingHttpHeaders | [string, string][],
        );
      }
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /**
   * Destroys the response and its connection (see `destroy()` of Node.js),
   * unless the response is sealed: the abandoned work cannot cut the reply
   * of the framework. With an error while an adopted pipe writes (see
   * `#adopt()`), it is the `data` listener of the pipe that catches a write
   * that throws (e.g. for a head that Node.js refuses): the pipe fails
   * instead (see `#pipeFailed()`), so that its work gets the error. So does
   * a destroy by an error handler that its pipe guards (see `#guarded()`),
   * with its error (or `ERR_STREAM_PREMATURE_CLOSE`), and a destroy of no
   * work while it replies (see `#replier()`). A response that the framework
   * destroys before it has a socket is cut once it gets one (see
   * `#cutQueued()`).
   */
  public override destroy(error?: Error): this {
    // What it throws is formatted (see `formatStack()`), e.g. what Node.js
    // throws as it reads an error that is a revoked proxy
    try {
      return this.#destroy(error);
    } catch (thrown: unknown) {
      throw formatStack(thrown as Error);
    }
  }

  /** `destroy()`, which may throw an error that is not formatted */
  #destroy(error?: Error): this {
    const marker = this.#marker;
    const owner = owners.getStore() ?? this.#replier();
    if (
      marker !== null &&
      typeof error !== "undefined" &&
      this.#pipeFailed(marker.owner, error, marker.source)
    ) {
      return this;
    } else if (
      this.#guarded(owner) &&
      this.#pipeFailed(owner, error ?? BindenResponse.#premature(), null)
    ) {
      return this;
    } else if (!this.#allows()) {
      return this;
    }
    this.#cutQueued();
    return super.destroy(error);
  }

  /**
   * The framework destroys a response that has not ended: when it waits for
   * the one before it on its connection (no socket yet, e.g. started at its
   * deadline), its socket is destroyed once Node.js assigns it, before
   * Node.js flushes what the response has queued (see `emit()`). Node.js
   * 24.14.1 does so itself, but later versions would send its head and the
   * part of its body that it has written, then keep the connection open for
   * a response that never ends. The responses before it have finished by
   * then: Node.js assigns the socket once the one before has finished. A
   * complete reply is not cut (Node.js sends it), nor one that the
   * application destroys (as without binden).
   */
  #cutQueued(): void {
    if (forced(this) && !this.writableEnded) {
      this.#cut = true;
    }
  }

  /**
   * Node.js assigns its socket to the response (once the response before it
   * has finished): the socket of a response that is cut is destroyed (see
   * `#cutQueued()`)
   */
  #assigned(socket: Duplex): void {
    if (this.#cut) {
      socket.destroy();
    }
  }

  /**
   * Whether a `destroy()` of the current work is a failure of its pipe: the
   * work of an error handler (see `IOwnership.guards()`) that may mutate
   * the response, with a pipe of its own that is adopted now, before the
   * headers are committed (e.g. `pipeline(head, transform, response)`, whose
   * callbacks run as the handler, destroys the response for a failure of its
   * head). Never a destroy of the framework, nor of a response that the
   * transport has closed (e.g. the client has gone away).
   */
  #guarded(owner: object | null | undefined): owner is object {
    return (
      typeof owner === "object" &&
      owner !== null &&
      !this.headersSent &&
      !this.destroyed &&
      !forced(this) &&
      this.#ownership.guards(owner) &&
      this.#allows(owner) &&
      (this.#sources.get(owner)?.size ?? 0) > 0
    );
  }

  /**
   * The work that a destroy of no work stands for (see `destroy()`): the
   * work that replies now (see `IOwnership.replier()`), while the connection
   * of the response is alive (`null` otherwise, e.g. the client has gone
   * away). E.g. `pipeline(head, transform, response)` of an error handler
   * destroys the response as the work that has emitted the failure of its
   * head (a timer of no request): it is a failure of the pipe of the error
   * handler (see `#guarded()`).
   */
  #replier(): object | null {
    const { socket } = this.req as { socket: { destroyed?: unknown } | null };
    return socket?.destroyed === true ? null : this.#ownership.replier();
  }

  /**
   * Sends `100 Continue`, unless the response is sealed or the request is
   * HTTP/1.0 (its callback is then called asynchronously). Once the head is
   * committed, it throws `ERR_HTTP_HEADERS_SENT` (see `#informs()`).
   */
  public override writeContinue(callback?: () => void): void {
    // Node.js takes anything as its callback: only the refusal of a
    // committed head is formatted (see `#informs()`)
    if (!this.#informs()) {
      BindenResponse.#ignore([callback]);
      return;
    }
    super.writeContinue(...(callbacksOf([callback]) as []));
  }

  /**
   * Sends `102 Processing`, unless the response is sealed or the request is
   * HTTP/1.0 (its callback is then called asynchronously). Once the head is
   * committed, it throws `ERR_HTTP_HEADERS_SENT` (see `#informs()`).
   */
  public override writeProcessing(callback?: () => void): void {
    // Node.js takes anything as its callback: only the refusal of a
    // committed head is formatted (see `#informs()`)
    if (!this.#informs()) {
      BindenResponse.#ignore([callback]);
      return;
    }
    super.writeProcessing(...(callbacksOf([callback]) as []));
  }

  /**
   * Sends `103 Early Hints`, unless the response is sealed or the request is
   * HTTP/1.0 (its callback is then called asynchronously). Once the head is
   * committed, it throws `ERR_HTTP_HEADERS_SENT` before it reads the hints
   * (see `#informs()`).
   */
  public override writeEarlyHints(
    hints: Record<string, string[] | string>,
    callback?: () => void,
  ): void {
    try {
      if (!this.#informs()) {
        BindenResponse.#ignore([callback]);
        return;
      }
      super.writeEarlyHints(
        hintsOf(hints) as Record<string, string[] | string>,
        ...(callbacksOf([callback]) as []),
      );
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /**
   * Sends an informational response (see `writeInformation()` of Node.js,
   * from 24.18.0), unless the response is sealed or the request is HTTP/1.0
   * (its callback is then called asynchronously). Once the head is committed,
   * it throws `ERR_HTTP_HEADERS_SENT` (see `#informs()`). Without the method
   * of Node.js (before 24.18.0), it throws a `TypeError` of binden.
   */
  public override writeInformation(
    statusCode: number,
    headers?: OutgoingHttpHeaders | readonly string[],
    callback?: () => void,
  ): void;
  /**
   * Sends an informational response without headers (as the first signature,
   * which Node.js has: binden gives it no headers)
   */
  public override writeInformation(
    statusCode: number,
    callback: () => void,
  ): void;
  public override writeInformation(...args: unknown[]): void {
    try {
      // Of Node.js from 24.18.0, read as it is called
      const informational: unknown = Reflect.get(parent, "writeInformation");
      // Also once the head is committed, on every version (see `#informs()`)
      if (!this.#informs()) {
        BindenResponse.#ignore(args);
        return;
      } else if (typeof informational !== "function") {
        throw formatStack(
          new TypeError(
            "writeInformation() is not supported by this version of Node.js (24.18.0 or later)",
          ),
        );
      }
      // The callback in place of the headers, which Node.js does not take:
      // no headers
      const [statusCode, second] = args;
      const given =
        args.length === 2 && typeof second === "function"
          ? [statusCode, null, second]
          : args;
      Reflect.apply(informational, this, callbacksOf(given));
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /**
   * Whether an informational response may be sent: not once the response is
   * sealed, and never to an HTTP/1.0 client, which does not know them
   * (RFC 9110, section 15.2). Otherwise, once the head of the response is
   * committed, it throws `ERR_HTTP_HEADERS_SENT`, formatted (see
   * `formatStack()`), as Node.js 26 does: before 24.18.0, Node.js would write
   * the informational head into the body, which the client would read as part
   * of it (or, past its `Content-Length`, as the next response of the
   * connection).
   */
  #informs(): boolean {
    const { httpVersionMajor = 1, httpVersionMinor = 1 } = this.req as {
      httpVersionMajor?: number;
      httpVersionMinor?: number;
    };
    const old =
      httpVersionMajor < 1 || (httpVersionMajor === 1 && httpVersionMinor < 1);
    if (old || !this.#allows()) {
      return false;
    } else if (this.headersSent) {
      throw BindenResponse.#headersSent();
    }
    return true;
  }

  /** The error of Node.js for a head written once it is committed, formatted (see `formatStack()`) */
  static #headersSent(): Error {
    return Object.assign(
      formatStack(
        new Error("Cannot write headers after they are sent to the client"),
      ),
      { code: "ERR_HTTP_HEADERS_SENT" },
    );
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
   * Sets how the framework handles the works that own the response (see
   * `IOwnership`)
   *
   * @internal
   */
  public [kOwnership](ownership: IOwnership): void {
    this.#ownership = ownership;
  }

  /**
   * Works may no longer mutate the response (see `kRevoke`): they are told so
   * on the next tick, after what they do now (e.g. the listeners that
   * `pipeline()` adds once it has piped), with the failure of a pipe of one
   * of them (see `#deliver()`)
   *
   * @internal
   */
  public [kRevoke](
    revoked: readonly object[],
    failure: IPipeFailure | null,
  ): Promise<void> {
    // Read once, at once: what reading them throws is formatted (see
    // `formatting()`), never thrown on the next tick
    const [works, failed] = formatting(
      () =>
        [
          [...revoked],
          failure === null
            ? null
            : { owner: failure.owner, error: failure.error },
        ] as const,
    );
    for (const owner of works) {
      this.#revoked.set(owner, false);
    }
    return new Promise<void>((resolve) => {
      process.nextTick(() => {
        for (const owner of works) {
          this.#revoked.set(owner, true);
          // Without a failure, also for a work that is `undefined`
          this.#deliver(
            owner,
            failed !== null && failed.owner === owner ? [failed.error] : null,
          );
        }
        resolve();
      });
    });
  }

  /**
   * Fails a pipe of a work of the exchange of the response (see
   * `kPipeFailure`)
   *
   * @internal
   */
  public [kPipeFailure](
    owner: object,
    error: unknown,
    source: EventEmitter,
  ): boolean {
    return this.#pipeFailed(owner, error, source);
  }

  /**
   * Adds an observer of the framework (see `kListen`), once by default:
   * returns what removes it
   *
   * @internal
   */
  public [kListen](
    event: string,
    listener: (...args: never[]) => unknown,
    options: {
      /** Whether it runs once (`true`), and is removed then */
      readonly once?: boolean | undefined;
    } = {},
  ): () => void {
    // Checked, and read once, before anything is changed: never a value that
    // would throw as its event is emitted (see `formatting()`)
    const given: unknown = listener;
    if (typeof given !== "function") {
      throw formatStack(
        new TypeError(`The listener is not a function: ${described(given)}`),
      );
    }
    const { once = true } = formatting(() => ({ once: options.once }));
    const observer: IObserver = {
      listener: listener as IListener,
      owner: owners.getStore(),
      once: Boolean(once),
      fired: false,
    };
    const observers = this.#observers.get(event) ?? [];
    observers.push(observer);
    this.#observers.set(event, observers);
    return (): void => {
      this.#unobserve(event, observer);
    };
  }

  /**
   * Removes the last observer of the framework of a listener (see
   * `kUnlisten`)
   *
   * @internal
   */
  public [kUnlisten](
    event: string,
    listener: (...args: never[]) => unknown,
  ): void {
    const observer = this.#observers
      .get(event)
      ?.findLast((candidate) => candidate.listener === listener);
    if (typeof observer !== "undefined") {
      this.#unobserve(event, observer);
    }
  }

  /** Removes an observer (see `[kListen]()`), if it is still there */
  #unobserve(event: string | symbol, observer: IObserver): void {
    const observers = this.#observers.get(event) ?? [];
    const index = observers.indexOf(observer);
    if (index !== -1) {
      observers.splice(index, 1);
      if (observers.length === 0) {
        this.#observers.delete(event);
      }
    }
  }

  /**
   * Emits an event to the listeners of the response, then to the observers
   * of the framework that it has then (see `[kListen]()`): also when a
   * listener throws, which is thrown once they have run. An `error` that the
   * response has no listener of, but observers, is not thrown (as when they
   * were listeners): only its `errorMonitor` listeners get it before them,
   * and one of them that throws is thrown once they have run as well.
   */
  #emit(event: string | symbol, args: unknown[]): boolean {
    const observers = this.#observers.get(event);
    if (typeof observers === "undefined") {
      return parent.emit.call(this, event, ...args);
    }
    const snapshot = [...observers];
    const monitored =
      event === "error" && intrinsic.listenerCount.call(this, "error") === 0;
    try {
      parent.emit.call(this, monitored ? errorMonitor : event, ...args);
    } catch (error: unknown) {
      const failure = this.#observe(event, snapshot, args);
      if (failure !== null) {
        const message = "An observer of the response has failed";
        this.#ownership.debug(message, failure.error);
      }
      throw error;
    }
    const failure = this.#observe(event, snapshot, args);
    if (failure !== null) {
      throw failure.error;
    }
    return true;
  }

  /**
   * Runs the observers of an event (see `[kListen]()`), each as the work
   * that has added it, with the response as its receiver, and once when it
   * runs once (also when it emits its event again): what the first one that
   * throws has thrown, once they have all run
   */
  #observe(
    event: string | symbol,
    observers: readonly IObserver[],
    args: unknown[],
  ): { error: unknown } | null {
    let failure: { error: unknown } | null = null;
    for (const observer of observers) {
      if (!observer.fired) {
        if (observer.once) {
          observer.fired = true;
          this.#unobserve(event, observer);
        }
        try {
          as(observer.owner, () =>
            Reflect.apply(observer.listener, this, args),
          );
        } catch (error: unknown) {
          failure ??= { error };
        }
      }
    }
    return failure;
  }

  /**
   * Cancels the sends in progress (of a stream, or of a file), unless the
   * headers have been committed: each rejects with the reason, its source is
   * released, and the response is restored as it was before the earliest of
   * them (its status and its headers), without the framing of their bodies
   * (also one set before them, e.g. by the application) nor the
   * representation chosen for them, also for a send that has settled once
   * its cancellation was recorded (see `[kCancelling]()`), so that another
   * reply can be sent at once
   *
   * @internal
   */
  public [kCancel](reason: unknown): void {
    if (!this.headersSent) {
      // A stream piped by the work that is abandoned has written nothing,
      // and writes nothing from now on: it no longer starts the response
      this.#piped = false;
      const release: (() => void)[] = [];
      this[kFramework](() => {
        // Restored first, the latest first (e.g. the send of the file of a
        // `sendFile()`, then that `sendFile()`), so that the response is as
        // it was before the earliest: a later send (e.g. a second
        // `sendFile()`, once the first has set the headers of its file) never
        // reinstates what an earlier one has set. Also a send that has
        // settled once its cancellation was recorded (see `#settled()`)
        const rollbacks = [...this.#rollbacks.values()].reverse();
        this.#rollbacks.clear();
        for (const rollback of rollbacks) {
          rollback?.();
        }
        if (rollbacks.length > 0) {
          // Then the framing of the bodies that are not sent, also one that
          // was set before the earliest of them (e.g. a `Content-Length` of
          // the application before a `sendFile()`), which no body of the
          // reply that replaces them has: once, as the representation chosen
          // for them, which that reply chooses again
          this.#remove("Content-Length", "Transfer-Encoding", "Content-Range");
          this.#forget();
        }
        for (const cancel of [...this.#pending.values()]) {
          cancel(reason, release);
        }
      });
      // Without the rights of the framework: a source is code of the
      // application (e.g. its `_destroy()`), which may not change the response
      // of the framework either
      for (const fn of release) {
        fn();
      }
    }
  }

  /**
   * Records at once the cancellation of the sends in progress (of a stream,
   * or of a file), unless the headers have been committed, which
   * `[kCancel]()` carries out later: each rejects with the reason, however it
   * settles in between (e.g. a `sendFile()` that sees that its work may no
   * longer mutate the response, whose send would otherwise be ignored), and
   * is restored by `[kCancel]()` all the same (see `#rollbacks`). The sends
   * started afterwards are not cancelled.
   *
   * @internal
   */
  public [kCancelling](reason: unknown): void {
    if (!this.headersSent) {
      for (const key of this.#pending.keys()) {
        // Whatever it is (e.g. `null`), as `[kCancel]()`
        this.#cancellations.set(key, { reason: reason as Error });
      }
    }
  }

  /**
   * The promise of a send in progress (see `#pending`), by its key: once its
   * cancellation has been recorded (see `[kCancelling]()`), it rejects with
   * its reason, however the send settles
   */
  #cancellable(
    key: object,
    executor: (resolve: () => void, reject: (error: Error) => void) => void,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      executor(
        () => {
          const cancellation = this.#cancellations.get(key);
          if (typeof cancellation === "undefined") {
            resolve();
          } else {
            reject(cancellation.reason);
          }
        },
        (error) => {
          const cancellation = this.#cancellations.get(key);
          reject(
            typeof cancellation === "undefined" ? error : cancellation.reason,
          );
        },
      );
    });
  }

  /**
   * A send in progress has settled (see `#pending`): it is no longer
   * cancelled, nor restored, unless its cancellation has been recorded (see
   * `[kCancelling]()`), whose rollback (see `#rollbacks`) `[kCancel]()` still
   * runs, whatever the send has done in between (e.g. failed, or settled as
   * ignored)
   */
  #settled(key: object): void {
    this.#pending.delete(key);
    if (!this.#cancellations.has(key)) {
      this.#rollbacks.delete(key);
    }
  }

  /**
   * Runs a function of the framework with its rights, whoever owns the
   * response (e.g. to destroy it once sealed)
   *
   * @internal
   */
  public [kFramework]<T>(fn: () => T): T {
    // What it throws is formatted (see `formatStack()`), e.g. for a value
    // that is not a function
    try {
      return force(this, fn);
    } catch (error: unknown) {
      throw formatStack(error as Error);
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

  /**
   * Reports that the write (or the `end()`) that it is called in is
   * discarded by the library that has replaced the response (see
   * `kDiscardWrite`): a send is not cut for the bytes of that write
   *
   * @internal
   */
  public [kDiscardWrite](): void {
    this.#discardedWrites += 1;
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
    if (forced(this)) {
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
   * the body of the response (see `[kRepresentation]()`): an object whose
   * `choose` and `forget` are functions, read once, and called on it later.
   * Anything else is refused with a `TypeError` that describes it (see
   * `described()`), before it is kept. What reading it throws (e.g. a revoked
   * proxy) is formatted (see `formatting()`).
   *
   * @internal
   */
  public [kNegotiator](negotiator: IRepresentationNegotiator): void {
    const { choose, forget } = formatting(() => {
      const { choose: chosen, forget: forgotten } = objectOf(
        negotiator,
        "negotiator",
      ) as Partial<Record<keyof IRepresentationNegotiator, unknown>>;
      return { choose: chosen, forget: forgotten };
    });
    if (typeof choose !== "function") {
      throw BindenResponse.#notFunction("negotiator.choose", choose);
    } else if (typeof forget !== "function") {
      throw BindenResponse.#notFunction("negotiator.forget", forget);
    }
    this.#negotiator = {
      choose: (length: number | null): IRepresentation =>
        Reflect.apply(choose, negotiator, [length]) as IRepresentation,
      forget: (): void => {
        Reflect.apply(forget, negotiator, []);
      },
    };
  }

  /** The refusal of a value that is not a function (`name`), which describes it (see `described()`) */
  static #notFunction(name: string, value: unknown): TypeError {
    return formatStack(
      new TypeError(`\`${name}\` is not a function: ${described(value)}`),
    );
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
    // What the negotiator throws is formatted (see `formatStack()`)
    try {
      return this.#negotiator === null || !this.#allows()
        ? identity
        : this.#negotiator.choose(length);
    } catch (error: unknown) {
      throw formatStack(error as Error);
    }
  }

  /**
   * The body that a representation has been chosen for is not sent (e.g. its
   * stream has failed before its first chunk): the reply that replaces it
   * gets a representation of its own. Not by the abandoned work, whose
   * failure must not change the reply of the new owner.
   */
  #forget(): void {
    if (this.#allows()) {
      // Where a send settles (e.g. in a listener of its source): what the
      // negotiator throws is logged (`debug`), never thrown there
      try {
        this.#negotiator?.forget();
      } catch (error: unknown) {
        this.#ownership.debug("The negotiator has failed to forget", error);
      }
    }
  }

  /**
   * Send a response: a string (or a number), bytes, a `Readable`, a
   * stream-like source (see `IStreamLike`, e.g. of `readable-stream`), or no
   * body. Any other object rejects with a `TypeError` before anything is
   * sent, and so does a view of a detached `ArrayBuffer` (e.g. transferred),
   * also as a chunk of a `Readable`, which is never written (the response is
   * cut once it has sent anything). It resolves once the response is flushed
   * to the connection. When the client goes away before, it rejects with the
   * error of the connection when a pending write fails first (e.g. `EPIPE`,
   * `ECONNRESET` or `ECANCELED`, whichever Node.js and the system report),
   * otherwise as a premature close (`ERR_STREAM_PREMATURE_CLOSE`): a release
   * of its source never decides it.
   */
  public send(
    data?:
      Buffer | IStreamLike | Readable | Uint8Array | bigint | number | string,
  ): Promise<void>;
  /** Send a string in an encoding (e.g. `latin1`) */
  public send(data: string, encoding: BufferEncoding): Promise<void>;
  public send(data?: unknown, encoding?: BufferEncoding): Promise<void> {
    try {
      return this.#send(data, null, encoding);
    } catch (error: unknown) {
      // E.g. a reason phrase or a `Trailer` that Node.js refuses once it sends
      // the headers: the response is unchanged, and the error can be replied
      // (formatted, see `formatStack()`)
      return Promise.reject(formatStack(error as Error));
    }
  }

  /**
   * Whether a send (also of `text()`, `html()`, `json()` and `form()`) is
   * ignored: the response has ended, or the current work may no longer
   * mutate it (see `[kSeal]()`)
   */
  #ignored(): boolean {
    return this.writableEnded || !this.#allows();
  }

  /**
   * The status code of a send (see `#status()`): when its conversion throws,
   * the source is released first (see `#release()`)
   */
  #sending(
    data: unknown,
    kind: IStreamLikeMethods | "readable" | "value",
  ): number {
    try {
      return this.#status();
    } catch (error: unknown) {
      this.#release(data, kind);
      throw error;
    }
  }

  /**
   * `send()`, which may throw before it has changed the response. The
   * `Content-Type` of `text()`, `html()`, `json()` and `form()` (`type`) is set
   * once the data and the status are accepted: a refused call changes nothing
   * of the response.
   */
  #send(
    data: unknown,
    type: string | null,
    encoding?: BufferEncoding,
  ): Promise<void> {
    if (this.#ignored()) {
      // Ignored: nothing of the data is read (e.g. a getter of an object of
      // a work that may no longer mutate the response), but a Node.js
      // `Readable` is released (see `#releaseIgnored()`)
      this.#releaseIgnored(data);
      return Promise.resolve();
    }
    // What is sent (see `#kind()`): the methods of a stream-like source are
    // read once
    const kind = BindenResponse.#kind(data);
    // The bytes of a view, read once by the getters of the engine (see
    // `bytesOf()`): what is sized and written for a `Uint8Array` (any other
    // view is refused below). Any view whose bytes are gone (e.g. of a
    // detached `ArrayBuffer`) throws a `TypeError` of binden, which `send()`
    // rejects with before anything is changed
    const bytes = ArrayBuffer.isView(data) ? bytesOf(data) : null;
    if (kind === null) {
      // Before anything is changed: never its `toString()` (e.g. `[object
      // Object]`), nor a source that cannot be read with backpressure or
      // released (its methods are not called)
      return Promise.reject(
        formatStack(
          new TypeError(
            "The data is not a string, a number, a Buffer, a Uint8Array, a Readable nor a stream-like source (with on(), pause(), resume(), and removeListener() or off())",
          ),
        ),
      );
    } else if (
      typeof encoding !== "undefined" &&
      !Buffer.isEncoding(encoding)
    ) {
      return Promise.reject(
        formatStack(new TypeError(`Unknown encoding: ${described(encoding)}`)),
      );
    }
    // Converted once, before anything decides by it (see `#status()`): one
    // that is refused releases the source, as the refusal of a status below
    const code = this.#sending(data, kind);
    if (BindenResponse.#informational(code)) {
      this.#release(data, kind);
      return Promise.reject(BindenResponse.#notFinal(code));
    } else if (type !== null) {
      // Accepted: the media type of `text()`, `html()`, `json()` or `form()`
      this.setHeader("Content-Type", type);
    }

    if (kind !== "value") {
      // Read once, before anything of the source runs (see `#pipe()`)
      const declared = this.#declared(data, kind);
      if (this.#bodiless()) {
        // Nothing of the source would be sent: it is not read at all
        this.#release(data, kind);
        // The representation and the framing of the length that it declares
        // (unknown without one, not empty), without a stale `Transfer-Encoding`
        this[kRepresentation](declared);
        this.#frame(declared);
        this.#remove(...contentDigests);
        return this.#end();
      }
      return this.#pipe(
        kind === "readable"
          ? (data as Readable)
          : readStreamLike(
              data as object,
              kind,
              () => this.#abandoned(BindenResponse.#premature()),
              this.#report(),
              () => {
                this.#unreleased();
              },
              this.#streamLikeLogs(),
            ),
        declared,
      );
    }

    if (typeof data === "undefined" || this.destroyed) {
      // No body: as for `GET`, `Content-Length: 0`, but a valid length given
      // to `HEAD` (of the body that `GET` would send) is kept, without a
      // stale `Transfer-Encoding`
      this.#frame(this.req.method === "HEAD" ? (this.#length() ?? 0) : 0);
      if (this.#bodiless()) {
        // Of the body of `GET` (e.g. of `sendFile()`), which is not sent
        this.#remove(...contentDigests);
      }
      return this.#end();
    }

    // Encoded once: the bytes give the length and the `ETag`, and are sent
    const body =
      typeof data === "string"
        ? Buffer.from(data, encoding)
        : (bytes ?? Buffer.from(String(data as bigint | number)));

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
      return this.#endNotModified(body.length);
    } else if (status !== null) {
      // Empty, also for `HEAD` (which would keep the length of a body), and
      // without the coding, the digests (e.g. of a precompressed body) nor
      // the trailers (which Node.js refuses without chunks) of the body whose
      // representation it replaces
      this.statusCode = status;
      this.#remove(
        "Content-Encoding",
        "Trailer",
        ...contentDigests,
        ...representationDigests,
      );
      this.#frame(0);
      return this.#end();
    }

    // Counted once: the bytes that the head declares (see `bytesLost()`)
    const { length } = body;
    this.#frame(length);

    if (this.#bodiless()) {
      // The headers of the body (as for `GET`), but not the body itself, nor
      // the digest of its content (only of its representation)
      this.#remove(...contentDigests);
      return this.#end();
    }

    // The body is written rather than passed to `end()`: a write that fails
    // (e.g. the client went away) rejects, although Node.js 24 emits `finish`
    // once the response is ended. Its length keeps it from being chunked.
    return new Promise<void>((resolve, reject) => {
      const discarded = this.#discardedWrites;
      this.write(body, (error?: Error | null) => {
        if (error) {
          reject(error);
        }
      });
      if (bytesLost(body, length) && !this.#dropped(discarded)) {
        // Detached by code of the application inside that write (see
        // `bytesLost()`): never flushed, also once that write has ended the
        // response, unless the write has been discarded (see `#dropped()`)
        this.#cutLost();
        reject(detachedView());
        return;
      }
      this.#end().then(resolve, reject);
    });
  }

  /**
   * Ends the response, then settles once it has finished, or rejects when it
   * is closed before (e.g. the client went away). Listened to once `end()` has
   * returned: an `end()` that throws (e.g. for a reason phrase that Node.js
   * refuses) leaves no listener, nor a promise that would reject unobserved.
   */
  #end(): Promise<void> {
    this.end();
    return this.#finished(() => false);
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
   * headers of the `200`, with its `Content-Length` (RFC 9110, section 8.6)
   * and the digests of its representation, but no body (nor the digest of
   * its content)
   */
  #endNotModified(length: number): Promise<void> {
    this.statusCode = 304;
    // Without the trailers of the body (see `#frame()`)
    this.#remove("Transfer-Encoding", "Trailer", ...contentDigests);
    this.setHeader("Content-Length", length);
    return this.#end();
  }

  /**
   * Send a JSON value as `application/json`. A value that has no JSON text
   * (`undefined`, a function or a symbol), a `bigint` or a cyclic value
   * rejects with a `TypeError` before the response is started, as does a
   * `stringify` that is not a function, or that does not return a string;
   * what a `stringify` throws (e.g. one that cannot be called) is formatted
   * (see `formatting()`). Ignored as `send()` is, once the response has
   * ended or the work may no longer mutate it: neither the value nor
   * `stringify` is read, checked or called.
   */
  public async json<T = unknown>(
    data: T,
    stringify?: (data: T) => string,
  ): Promise<void> {
    if (this.#ignored()) {
      return;
    }
    const type = typeof data;
    if (
      type === "undefined" ||
      type === "function" ||
      type === "symbol" ||
      type === "bigint"
    ) {
      throw formatStack(new TypeError(`A ${type} is not a JSON value`));
    } else if (
      typeof stringify !== "undefined" &&
      typeof stringify !== "function"
    ) {
      throw formatStack(new TypeError("`stringify` is not a function"));
    }
    const body: unknown =
      typeof stringify === "undefined"
        ? jsonText(data)
        : formatting(() => stringify(data));
    if (typeof body !== "string") {
      throw formatStack(new TypeError("The JSON text is not a string"));
    }
    await this.#sendAs(body, ct_json);
  }

  /**
   * Send text as `text/plain; charset=utf-8`: data that `send()` refuses (or
   * a 1xx status) rejects before the `Content-Type` is set
   */
  public async text(data: string): Promise<void> {
    if (!this.#allows()) {
      return;
    }
    await this.#sendAs(data, `${ct_text}; charset=utf-8`);
  }

  /**
   * Send text as `text/html; charset=utf-8`: data that `send()` refuses (or
   * a 1xx status) rejects before the `Content-Type` is set
   */
  public async html(data: string): Promise<void> {
    if (!this.#allows()) {
      return;
    }
    await this.#sendAs(data, `${ct_html}; charset=utf-8`);
  }

  /**
   * `send()` of data as a media type, which is set once `send()` has accepted
   * the data and the status (see `#send()`)
   */
  #sendAs(data: unknown, type: string): Promise<void> {
    try {
      return this.#send(data, type);
    } catch (error: unknown) {
      // As `send()`: the response is unchanged, and the error can be replied
      return Promise.reject(formatStack(error as Error));
    }
  }

  /**
   * Send `URLSearchParams` as `application/x-www-form-urlencoded`: anything
   * else rejects with a `TypeError` before the response is started (see
   * `formText()`). Ignored as `send()` is, once the response has ended or
   * the work may no longer mutate it: nothing of the parameters is read nor
   * checked.
   */
  public async form(params: URLSearchParams): Promise<void> {
    if (this.#ignored()) {
      return;
    }
    const text = formText(params);
    await this.#sendAs(text, ct_form);
  }

  /**
   * Redirect (`302 Found` by default) to a path or a URL of the same origin as
   * the request, or with `allow_external` to another origin, with an empty
   * body. `Location` is the WHATWG URL serialization of the location (a
   * relative one stays relative). A location with userinfo, a control
   * character, whitespace, a backslash or a scheme other than `http` and
   * `https` rejects with a `TypeError`, as does an external one without
   * `allow_external`, a status that is not a redirect, and options that are
   * not an object. What reading the location or the options throws (e.g. of
   * a revoked proxy) is formatted (see `formatting()`).
   */
  public async redirect(
    location: URL | string,
    status: IRedirectStatus = 302,
    options: IRedirectOptions = {},
  ): Promise<void> {
    if (!this.#allows()) {
      return;
    } else if (!isRedirectStatus(status)) {
      throw formatStack(
        new TypeError(`Status code ${described(status)} is not a redirect`),
      );
    }
    // Checked as given (e.g. `null` by JavaScript)
    const given: unknown = options;
    if (typeof given !== "object" || given === null) {
      throw formatStack(new TypeError("`options` is not an object"));
    }
    // Read as destructuring reads it (also an inherited one)
    const allowed: unknown = formatting(() => options.allow_external);
    const allow_external = typeof allowed === "undefined" ? false : allowed;
    if (typeof allow_external !== "boolean") {
      throw formatStack(new TypeError("`allow_external` is not a boolean"));
    }
    const { base, origin } = this.#base();
    const value = formatting(() =>
      redirectLocation(location, base, origin, allow_external),
    );
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
      // First: when it throws (e.g. for a reason phrase that Node.js refuses),
      // the promise rejects without a listener left
      this.flushHeaders();
      const listening: (() => void)[] = [];
      const unlisten = (): void => {
        for (const dispose of listening) {
          dispose();
        }
      };
      const fail = (error?: Error): void => {
        unlisten();
        reject(error ?? BindenResponse.#premature());
      };
      listening.push(
        this[kListen]("close", fail),
        this[kListen]("error", fail),
      );
      // Its callback runs once the writes before it are flushed
      this.write("", (error?: Error | null) => {
        unlisten();
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * The length that the body of a source declares (see `#length()`): one of
   * another type refuses its send before anything is sent, and the source is
   * released (see `#release()`), as for an informational status
   */
  #declared(
    data: unknown,
    kind: IStreamLikeMethods | "readable",
  ): number | null {
    try {
      return this.#length();
    } catch (error: unknown) {
      this.#release(data, kind);
      throw error;
    }
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

  /**
   * The refusal of a send by an informational status (see `#informational()`),
   * formatted (see `formatStack()`): not a final response, whose client
   * would wait for the final one
   */
  static #notFinal(status: number): Error {
    return formatStack(
      new TypeError(
        `Status code ${String(status)} is informational (use writeEarlyHints())`,
      ),
    );
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
   * the next response of the connection as this body. A response without a
   * body has no `Trailer` either (e.g. one set for the chunked body of `GET`).
   */
  #frame(length: number | null): void {
    const { statusCode } = this;
    if (this.headersSent) {
      return;
    } else if (this.#bodiless()) {
      // Nor the trailers of a body, which Node.js refuses without chunks
      // (also to `HEAD`, which may omit the fields that only generating the
      // content determines, RFC 9110, section 9.3.2)
      this.#remove("Trailer");
    }
    if (statusCode === 205) {
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
   * maybe before the source ends; an empty one (`Content-Length: 0`) only
   * once the response has finished, since nothing of it is written (a client
   * that goes away before may not have its head).
   *
   * The `Content-Length` that the body declares (`declared`, see `#send()`) is
   * read once, before anything of the source runs (a compression removes the
   * header): a source that fails, closes before its end, or does not have
   * exactly that length rejects.
   * Nothing sent yet, before the headers are committed, the error can still
   * be replied (see `.started`); otherwise the response is closed (see
   * `#cutFailed()`), so that a truncated body (or a head that promises one,
   * e.g. once `flushHeaders()` has sent it) does not look complete, and more
   * bytes are not read by the client as the next response of the connection.
   * A source that has already ended is an empty body; one that has been
   * destroyed or has errored before rejects at once (see `#unreadable()`).
   * One that is paused (e.g. by the application, or by an `unpipe()`) is
   * resumed once the listeners of the send are added, as
   * `Readable.prototype.pipe()` does: once the response drains when it needs
   * to.
   *
   * Code of the source that throws (its own `on()`, e.g. by a listener of its
   * `newListener`, or its `resume()`: also the one that `on("data")` of
   * Node.js calls for a source that is not paused, and the one at a drain)
   * fails the send as binden fails it itself (see `fail`), with what it has
   * thrown, as it is (also `null`): `done` is observed before any code of
   * the source runs, so that nothing of the send is left.
   *
   * Once the response has been ended (by another writer, e.g. a compression
   * that has replaced it with `406` when its first chunk committed the
   * headers, or by the send itself, once the whole body is written), the
   * rest of the source is not read, and its failure no longer fails the send
   * (see `stop`): it is released, and the response is left as it is.
   *
   * The callbacks of the source run as the owner that has started the send,
   * whose rights they keep: once that owner may no longer mutate the
   * response, they do not either. Before the headers are committed, the
   * framework may cancel the send (see `[kCancel]()`): it then rejects with
   * the reason at once, and its source is released.
   *
   * When the response closes before the send has settled (e.g. the client
   * goes away), the send rejects with the error of the connection when a
   * pending write fails first (e.g. `EPIPE`, `ECONNRESET` or `ECANCELED`,
   * which Node.js and the system decide), otherwise at once as the response
   * has ended (see `unclose`): as a premature close, or resolved once its
   * body is complete for the client. Only then is its source released: a
   * release that fails never decides it.
   *
   * Once the send has settled (sent, failed or cancelled), every listener
   * that it has added to the source (by its own `on()`, also of `end` and
   * `close`, which a source that has ended or closed before never emits) is
   * removed by its own `removeListener()` (or `off()`), which pairs with
   * that `on()` (e.g. one that wraps them, such as the `context.bind()` of
   * OpenTelemetry), and every observer of the response is removed, so that
   * a source that the application keeps holds nothing of the response, and
   * the listeners of the application stay. The guard of the source listens
   * before, and reports a late error of it (e.g. of a destroy by
   * `autoDestroy` that fails after its end); a removal that throws is
   * logged (`debug`).
   */
  #pipe(data: Readable, declared: number | null): Promise<void> {
    if (!data.readableEnded) {
      // Read once (e.g. a getter of the source)
      const { destroyed, errored } = data;
      if (destroyed || errored !== null) {
        // The value that the readable of a stream-like source stands for, in
        // place of its carrier (see `uncarried()`)
        return this.#unreadable(
          data,
          destroyed,
          uncarried(errored, data) as Error | null,
        );
      }
    }
    const operation = this.#operation();
    // A body of a declared length is framed by it: a stale
    // `Transfer-Encoding` would frame it by chunks as well (RFC 9112,
    // section 6.1), which a client or a proxy may read either way
    this.#frame(declared);
    // The framing of this send (see `#unframe()`)
    const framed = this.#framing;
    const key = {};
    let flushed = 0;
    let sent = 0;
    // Once the response is closed, `#finished()` tells how it ended
    let closed = false;
    // Once the response has been ended (see `stop`)
    let stopped = false;
    let settled = false;
    // Once the source has emitted an `error` (see its `close`)
    let heard = false;
    /** What removes the observers that `#finished()` adds to the response */
    const finishing: (() => void)[] = [];
    /**
     * How the response has ended for the send (see `#finished()`): its
     * error, `null` once it has finished (or is complete for the client).
     * Told as `done` settles, before its reactions, and before the `close`
     * of the response reaches `unclose` (`done` observes it first).
     */
    let ending: Error | null = null;
    const done = this.#finished(
      () => {
        // An empty body only once the response has finished: nothing is
        // written of it, and the client may not even have its head. Read as
        // the response closes (e.g. removed by a compression), never by a
        // listener that throws: bytes have been flushed only once the head
        // has been committed, whose `Content-Length` binden has checked (see
        // `kValidateHead`), and a value of another type is no length here
        if (flushed === 0) {
          return false;
        }
        const length = this.#knownLength();
        return length !== null && flushed >= length;
      },
      finishing,
      (error) => {
        ending = error;
      },
    );
    return this.#cancellable(key, (resolve, reject) => {
      /** The listeners that the send adds to the source (see `listening`) */
      const listeners: [string, (...args: never[]) => void][] = [];
      /**
       * Whether the listener of `error` of the send is in place (see
       * `errors`): its `on()` has returned, or it has heard an error. Kept
       * once the send has settled when no guard listens (see `unlisten`)
       */
      let listened = false;
      /** Whether the guard of the source listens, once the send has settled */
      let guarded = false;
      /**
       * The listener of `error` of the send (every error, also one emitted
       * while the source is destroyed later), which holds nothing of the
       * send once it has settled (see `forwarder()`). The readable of a
       * stream-like source fails the send with the value of its source, in
       * place of its carrier (see `uncarried()`)
       */
      const errors = forwarder((error: unknown) => {
        heard = true;
        listened = true;
        operation.run(() => {
          // eslint-disable-next-line @typescript-eslint/no-use-before-define -- only once it is added, below
          fail(uncarried(error, data), false, true);
        });
      });
      /**
       * What removes the other observers that the send adds to the response:
       * of its `close`, and of each `drain` that it waits for
       */
      const observers = new Set<() => void>();
      /**
       * Removes every listener of the source and every observer of the
       * response that the send has added, once it has settled, so that a
       * source that lives on holds nothing of the response: the guard of the
       * source (see `#guardReleased()`) listens before, and reports a late
       * error of it (e.g. of a destroy by `autoDestroy` that fails after its
       * end). So does the guard of the request of the response, which the
       * send never destroys (see `#destroys()`), but whose error Node.js may
       * already have scheduled once it has found the listener of the send
       * (e.g. of a client that aborts): whether a source needs a guard does
       * not depend on whether it may be destroyed
       */
      const unlisten = (): void => {
        // First: an error that the source emits while the listener of its
        // guard is added (e.g. by a listener of its `newListener`) is a late
        // one (see `forwarder()`), never one of the send, which has settled
        errors.detach(data, this.#report());
        guarded = this.#guardReleased(data);
        for (const [event, listener] of listeners) {
          // Kept when no guard listens, without which an error of its
          // release (see `drop`) would crash the process: it reports a late
          // error itself (see `forwarder()`), heard as long as it listens
          if (listener !== errors.listener || !listened || guarded) {
            try {
              Reflect.apply(removerOf(data), data, [event, listener]);
            } catch (error: unknown) {
              // Its guard keeps it harmless: once the send has settled, its
              // listeners change nothing of the response
              const message =
                "The removal of a listener of a stream has failed";
              this.#ownership.debug(message, error);
            } finally {
              if (listener === errors.listener) {
                // No longer heard by the send, even when a removal that
                // throws leaves it: once detached, it reports an error that
                // the guard does not (see `forwarder()`)
                hear(data, -1);
              }
            }
          }
        }
        for (const dispose of [...finishing, ...observers]) {
          dispose();
        }
      };
      /**
       * Destroys the source under its guard, by one call of its own
       * `destroy()`, with the error that binden has failed the send with
       * (`failure`), or without one. Node.js reads the `stack` of that error
       * (before anything is destroyed, and again once its `_destroy()` has
       * called back): it is the error itself only when Node.js reads it
       * without running code of the application (see `readsSafely()`), and
       * otherwise an `Error` that carries it as its `cause` (see
       * `carrierOf()`), so that the source is destroyed in any case (e.g. its
       * file closed). The `destroy()` of Node.js (`Readable.prototype`, read
       * once), which throws before it destroys the stream (e.g. as it reads
       * that `stack`), is called once more, with the carrier of the error.
       * What else throws is thrown (see `drop`), and a `destroy()` of the
       * source's own is never called again: it may have done anything before.
       */
      const destroyWith = (
        failure: { readonly error: unknown } | null,
      ): void => {
        if (failure === null) {
          data.destroy();
          return;
        }
        // Read once (e.g. by a getter of the source), before the error is
        // checked
        const destroy = Reflect.get(data, "destroy") as (
          error: unknown,
        ) => unknown;
        const { error } = failure;
        const safe = readsSafely(error);
        try {
          Reflect.apply(destroy, data, [safe ? error : carrierOf(error)]);
        } catch (thrown: unknown) {
          if (
            destroy !== destroyReadable ||
            !safe ||
            Reflect.apply(readableDestroyed, data, [])
          ) {
            throw thrown;
          }
          Reflect.apply(destroyReadable, data, [carrierOf(error)]);
        }
      };
      /**
       * Releases the source that the send no longer reads, unless it has
       * ended or is destroyed: it is destroyed (with the error that binden
       * has failed the send with, `failure`, see `fail`), unless it is the
       * request of the response (see `#destroys()`), which is only left, no
       * longer paused (e.g. by the backpressure of the send, once another
       * writer has ended the response), so that Node.js reads the rest of its
       * body, and the next request of the connection. Without its guard (see
       * `unlisten`), it is destroyed without that error, which the send has
       * failed with already, while the listener of `error` of the send
       * listens, and else left (see `#unreleased()`). A failure of the release
       * (e.g. of a `destroy()` of its own) is logged (`debug`)
       */
      const drop = (
        failure: { readonly error: unknown } | null = null,
      ): void => {
        try {
          if (data.readableEnded || data.destroyed) {
            return;
          } else if (!this.#destroys(data)) {
            if (data.isPaused()) {
              data.resume();
            }
          } else if (guarded) {
            // Its guard does not report it again when the source emits it
            // (decided, see `settle`)
            destroyWith(failure);
          } else if (listened) {
            data.destroy();
          } else {
            this.#unreleased();
          }
        } catch (error: unknown) {
          this.#ownership.debug("The release of a stream has failed", error);
        }
      };
      /**
       * Decides an error that the source has brought (by an event of it, or
       * thrown by its code) for that source (see `decidedFor()`), unless a
       * cancellation recorded for the send (see `[kCancelling]()`, e.g. of a
       * failed error handler or of a failed pipe) replaces it with another
       * reason, which the send rejects with: the error then decides nothing,
       * and is a late error, reported once on a later turn (see
       * `reportLate()`)
       */
      const brought = (error: unknown): void => {
        const cancellation = this.#cancellations.get(key);
        if (
          typeof cancellation === "undefined" ||
          cancellation.reason === error
        ) {
          decidedFor(data, error);
        } else {
          reportLate(data, error, this.#report());
        }
      };
      /**
       * Settles the send once: it resolves without a `failure`, otherwise it
       * rejects with its error, whatever it is (e.g. the `null` that code of
       * the source has thrown, or the reason of a cancellation). Only then, a
       * source still read (neither ended nor destroyed, e.g. once another
       * writer has ended the response) is released, as it would be once the
       * response has closed: with the error that binden fails the send with
       * itself (`own`, see `fail`). A send that `[kCancel]()` cancels removes
       * its listeners and releases its source afterwards (`release`), without
       * the rights of the framework: that runs code of the source (e.g. its
       * own `removeListener()`), which belongs to the work that is abandoned.
       */
      const settle = (
        failure: {
          readonly error: unknown;
          readonly own: boolean | "thrown";
        } | null,
        release: (() => void)[] | null = null,
      ): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (failure === null) {
          // Before it is released (see `drop`): a stream-like source is then
          // destroyed without an error, as a Node.js `Readable` is, never
          // with the reason of a cancellation (see `resolved()`)
          resolved(data);
        } else if (failure.own === "thrown") {
          // What code of the source has thrown, an object of the
          // application, before its guard is installed (see `unlisten`): its
          // code that throws it again then is not logged (see `guard()`), nor
          // is it reported once the source emits it (see `drop`), but it may
          // still be a late error of another source (see `decidedFor()`)
          brought(failure.error);
        } else if (failure.own) {
          // An error of binden (e.g. a body longer than its
          // `Content-Length`), decided as above for every source
          decided(failure.error);
        }
        // Restored by `[kCancel]()` still, once its cancellation is recorded
        this.#settled(key);
        if (release === null) {
          unlisten();
        } else {
          release.push(unlisten, () => {
            this.#discard(data, listened);
          });
        }
        if (failure === null) {
          resolve();
        } else {
          // Unless `[kCancel]()` cancels it (`release`): it has removed the
          // framing, and forgotten the representation, once for every send
          if (release === null && !this.headersSent) {
            this.#forget();
            this.#unframe(framed);
          }
          // Abandoned at the deadline (e.g. its source destroyed by a
          // listener of `signal`, before the deadline cancels it), it fails
          // as a cancelled send (whose reason may be anything)
          const error = failure.error as Error;
          reject(operation.active ? error : this.#abandoned(error));
        }
        if (release === null) {
          drop(failure !== null && failure.own !== false ? failure : null);
        }
      };
      /**
       * Stops the send once the response has been ended (see `fail`): the
       * source is released (see `#discard()`), and the response is left as
       * it is (its reply is complete, and the responses that follow it on
       * the connection are sent), which the send settles as (see `done`).
       * The error of the source is reported once, as a late error (see
       * `reportLate()`; `emitted`: whether an event of the source has
       * brought it, `null` for none), by the send also when the source has
       * emitted it: the send hears it (see `hear()`), so its guard does not
       * report it. It is reported on a later turn (see `reportLate()`), once
       * the event that may have brought it has reached every listener of the
       * source: a live send of the source (e.g. of another response) that
       * fails with that error in the same event has decided it for the source
       * then (see `fail`), and it is not reported, whichever of them listens
       * first. The guard of the source is installed while the send decides
       * that error (see `decide()`): code of the source that throws that same
       * object for a listener of the guard (e.g. a listener of its
       * `newListener`) is not logged as a refusal of the guard as well
       */
      const stop = (error: unknown, emitted: boolean | null): void => {
        if (emitted !== null) {
          reportLate(data, error, this.#report());
        }
        stopped = true;
        decide(data, error, () => {
          this.#discard(data, listened);
        });
      };
      /**
       * Fails the send: once anything is sent, or the headers are committed
       * (e.g. by `flushHeaders()`, whose head promises a body), the response is
       * closed (see `#cutFailed()`), so that the client never takes it for
       * complete, nor reads the next response of the connection as its body. A
       * failure that binden finds itself (`own`: `true` for an error of binden
       * or of Node.js, e.g. a body longer than its `Content-Length`; `"thrown"`
       * for what code of the source throws, an object of the application,
       * decided for this source only) fails it at once, never by an `error`
       * event of the source (which a `_destroy()` that calls back without the
       * error never emits), then destroys the source with it under its guard
       * (see `settle`), unless it is the request of the response (see
       * `#destroys()`). Once the response has been ended (by another writer,
       * e.g. a compression that has replaced it with `406`, or by the send
       * itself, once the whole body is written), a failure no longer fails the
       * send, which is stopped instead (see `stop`, `emitted`). An error that
       * an event of the source has brought (`emitted`: its `error`, or its
       * `close` with its `errored`, which reach every listener of the source;
       * `null` for none) and that fails the send has decided it for that source
       * (see `decidedFor()`): no guard of the source reports it, e.g. the one
       * that another response has installed on a source that it has released,
       * whose listener of `error` comes after the one of the send
       */
      const fail = (
        error: unknown,
        own: boolean | "thrown" = false,
        emitted: boolean | null = false,
      ): void => {
        if (settled) {
          return;
        } else if (stopped || this.writableEnded) {
          stop(error, emitted);
          return;
        } else if (sent > 0 || this.headersSent) {
          this.#cutFailed();
        }
        if (emitted === true) {
          // For this source only: the same object of the application (e.g.
          // one that it destroys each of its streams with) may still be a
          // late error of another source
          brought(error);
        }
        settle({ error, own });
      };
      /**
       * Resumes the source that the send has paused, or has found paused: a
       * `resume()` of its own that throws fails the send (see `fail`)
       */
      const resume = (): void => {
        try {
          data.resume();
        } catch (error: unknown) {
          fail(error, "thrown");
        }
      };
      /**
       * Resumes the source, which is paused, once the response drains: as the
       * owner that has started the send (see `Operation.run()`)
       */
      const drain = (): void => {
        const drained = this[kListen]("drain", () => {
          observers.delete(drained);
          operation.run(resume);
        });
        observers.add(drained);
      };
      /**
       * Pauses the source while the response is full, until it drains: a
       * `pause()` of its own that throws fails the send (see `fail`)
       */
      const pause = (): void => {
        try {
          data.pause();
        } catch (error: unknown) {
          fail(error, "thrown");
          return;
        }
        drain();
      };
      const end = (): void => {
        if (settled || this.writableEnded) {
          // Once another writer has ended the response, the send settles as
          // the response does (see `stop`)
          return;
        } else if (declared !== null && sent < declared) {
          fail(BindenResponse.#mismatch(sent, declared));
          return;
        }
        try {
          this.end();
        } catch (error: unknown) {
          // Nothing sent (e.g. an empty source, whose headers Node.js
          // refuses): never thrown out of the events of the source
          fail(error);
        }
      };
      // Before any code of the source runs, which may fail the send
      done.then(
        () => {
          settle(null);
        },
        (error: unknown) => {
          settle({ error, own: false });
        },
      );
      // Nothing of its own to restore: `[kCancel]()` removes the framing of
      // the body that is not sent, and its representation (see `#rollbacks`)
      this.#rollbacks.set(key, null);
      this.#pending.set(key, (reason: unknown, release: (() => void)[]) => {
        settle({ error: reason, own: false }, release);
      });

      const unclose = this[kListen]("close", () => {
        closed = true;
        // Settled at once as the response has ended (see `ending`), before
        // its source is released (e.g. the file of `sendFile()`, see
        // `settle`): a release that fails (e.g. a `destroy()` of the source
        // that destroys it with an error of its own, or a `_destroy()` that
        // fails on the next tick) can no longer decide the send, and is
        // reported by the guard of the source
        settle(ending === null ? null : { error: ending, own: false });
      });
      observers.add(unclose);
      /**
       * Adds the listeners of the send to the source by its own `on()`, and
       * records them first (an `on()` that throws may have added it), so
       * that its own `removeListener()` removes them (see `unlisten`): never
       * by `once()`, whose wrapper a `removeListener()` that pairs with a
       * wrapping `on()` may not find (e.g. of a wrapper that patches `on()`
       * and `removeListener()`, but not `once()`). None once the send has
       * settled (e.g. by an `error` that its `on()` has emitted at once)
       */
      const listening: IListening = {
        on: (event, listener) => {
          if (!settled) {
            listeners.push([event, listener]);
            if (listener === errors.listener) {
              // Heard by the send (see `hear()`): until it is removed (see
              // `unlisten`), its error fails the send, and is not reported
              // by the guard of the source (e.g. installed by another
              // response that has released it)
              hear(data, 1);
            }
            data.on(event, listener as IListener);
            if (listener === errors.listener) {
              listened = true;
            }
          }
          return listening;
        },
      };
      try {
        listening
          // First: nothing of the source runs (e.g. the `resume()` that
          // `on("data")` of Node.js calls, which emits `resume` to the
          // listeners of the application) until a listener of its `error` is
          // in place, without which a later error of it would crash the
          // process (see `#unreleased()`)
          .on("error", errors.listener)
          .on("data", (chunk: Uint8Array | string) => {
            operation.run(() => {
              if (settled || !operation.active) {
                // Cancelled, or its owner may no longer write
                this.#discard(data, listened);
                return;
              } else if (this.writableEnded) {
                stopped = true;
                // No longer read, it no longer fails the send (see `stop`):
                // released without an error (see `resolved()`), as at its
                // resolution
                resolved(data);
                this.#discard(data, listened);
                return;
              }
              try {
                // A view (a typed array or a `DataView`, e.g. a chunk of an
                // object-mode `Readable`) is read once, as a `Buffer` of
                // binden, which is what is sized and written (see
                // `bytesOf()`): Node.js reads nothing of it. One whose bytes
                // are gone (e.g. of a detached `ArrayBuffer`) is never
                // written (Node.js would throw once it writes it, e.g. as it
                // uncorks the connection on the next tick, out of any call):
                // what it throws is an error of binden, decided as below
                const written = ArrayBuffer.isView(chunk)
                  ? bytesOf(chunk)
                  : chunk;
                const size = Buffer.byteLength(written);
                if (declared !== null && sent + size > declared) {
                  fail(BindenResponse.#mismatch(sent + size, declared), true);
                  return;
                }
                const discarded = this.#discardedWrites;
                const accepted = this.write(written, (error?: Error | null) => {
                  if (error) {
                    // Not delivered: the client went away, and the error of
                    // the connection (e.g. `EPIPE`, `ECONNRESET` or
                    // `ECANCELED`) may come before its close, which the send
                    // then rejects with (Node.js 24 may still emit `finish`
                    // once the response is ended)
                    settle({ error, own: false });
                  } else {
                    flushed += size;
                  }
                });
                if (
                  written !== chunk &&
                  bytesLost(written as Buffer, size) &&
                  !this.#dropped(discarded)
                ) {
                  // Detached by code of the application inside that write
                  // (see `bytesLost()`): never flushed, and the send rejects,
                  // also once that write has ended the response (which
                  // `fail` would leave as it is), unless the write has been
                  // discarded (see `#dropped()`)
                  this.#cutLost();
                  settle({ error: detachedView(), own: true });
                  return;
                }
                // Once written: a first write that throws (e.g. for a reason
                // phrase that Node.js refuses) has sent nothing
                sent += size;
                if (!accepted) {
                  pause();
                }
              } catch (error: unknown) {
                // Not a chunk of bytes (e.g. an object), a view whose bytes
                // are gone (see above), or a write that Node.js refuses: an
                // error of its own
                fail(error, true);
              }
            });
          })
          .on("end", () => {
            operation.run(end);
          })
          .on("close", () => {
            // Destroyed before its end, without an `error` event (which
            // precedes the close): with its error (e.g. of `destroy(error)`,
            // whose `_destroy()` calls back without it), which its `close`
            // brings to every listener of the source, as an `error` event
            // would (see `fail`), or without one (nothing to report once the
            // response has ended, see `stop`)
            if (!closed && !heard && !data.readableEnded) {
              operation.run(() => {
                const { errored } = data;
                fail(
                  errored ?? BindenResponse.#premature(),
                  false,
                  errored === null ? null : true,
                );
              });
            }
          });
        if (settled) {
          // E.g. by an `error` that its `on()` has emitted at once
        } else if (data.readableEnded) {
          // Its end has been read already: an empty body
          end();
        } else if (data.readableFlowing !== true) {
          // Paused (e.g. by the application, by an `unpipe()`, or the request
          // that a body parser has refused), which a listener of `data` does
          // not resume: read, as `Readable.prototype.pipe()` does, once the
          // response has room
          if (this.writableNeedDrain) {
            drain();
          } else {
            data.resume();
          }
        }
      } catch (error: unknown) {
        // Code of the source (e.g. its own `on()`, a listener of its
        // `newListener`, or its own `resume()`, also the one that `on("data")`
        // of Node.js calls for a source that is not paused)
        fail(error, "thrown");
      }
    });
  }

  /**
   * The send of a `Readable` that nothing more can be read of (see
   * `#pipe()`): `destroyed`, or `errored` (e.g. without `autoDestroy`),
   * before its end. Its destroy (e.g. by the application) may still fail:
   * its guard listens, as for a stream-like source (see `#guardReleased()`).
   * It rejects at once, with the error of the source (its `errored`, which
   * decides the send while its guard is installed, see `decide()`, and then
   * for that source: its guard does not report it, see `decidedFor()`),
   * or as a premature close, as a send that fails in `#pipe()`: before the
   * headers are committed, without the framing of its body (see
   * `#unframe()`), nor the representation chosen for it (see `#forget()`),
   * so that a reply that follows (e.g. an `end()` of the work that catches
   * the rejection) frames its own body; once they are committed, the
   * response is closed (see `#cutFailed()`), whose head promises a body that
   * will not come. Once another writer has ended the response (e.g. code of
   * the source, such as a getter that the checks of `#send()` have run), the
   * response is left as it is: the send settles as the response does, and
   * the error of the source is reported once, as a late error, whatever
   * reports it (see `reportLate()`). Then a source that has errored without
   * being destroyed is released (see `#discard()`), so that what it holds
   * (e.g. the file of a stream) is freed.
   */
  #unreadable(
    data: Readable,
    destroyed: boolean,
    errored: Error | null,
  ): Promise<void> {
    // Decided meanwhile (see `decide()`): code of the source that emits its
    // error while its guard is installed (e.g. a listener of its
    // `newListener`) is not reported by the guard, nor logged when it throws
    // it. Code of the source that ends the response meanwhile leaves its
    // error a late one, which is reported below
    decide(data, errored, () => this.#guardReleased(data));
    try {
      if (this.writableEnded) {
        if (errored !== null) {
          reportLate(data, errored, this.#report());
        }
        return this.#finished(() => false);
      } else if (this.headersSent) {
        this.#cutFailed();
      } else {
        this.#forget();
        this.#unframe(this.#framing);
      }
      // For this source only (see `decidedFor()`), as an error that it emits
      // while it is sent
      decidedFor(data, errored);
      return Promise.reject(errored ?? BindenResponse.#premature());
    } finally {
      // Once the send has settled, or knows how it settles
      if (!destroyed) {
        this.#discard(data);
      }
    }
  }

  /**
   * Installs the guard of a source (see `guard()`), which a send no longer
   * listens to: whether it listens. Code of the source that throws (e.g. a
   * listener of its `newListener`) is logged (`debug`): a source that
   * refuses the listener of `error` of its guard is not guarded, and is not
   * destroyed without another listener of `error` (see `#discard()`). Never
   * an object known for the source (see `guard()`): an error that has
   * decided a send, or that a send of the source decides meanwhile (see
   * `decide()`, e.g. in `#unreadable()`), which its rejection, or its late
   * report, tells
   */
  #guardReleased(source: Readable): boolean {
    return guard(
      source,
      emitterMethods,
      this.#report(),
      hasClosed(source),
      (error: unknown) => {
        this.#ownership.debug("The release of a stream has failed", error);
      },
    );
  }

  /**
   * Leaves a source that cannot be released: no listener of its `error` is
   * in place (it refuses the one of its guard, see `guard()`, and its send
   * has none), without which an error of its destroy, or of its pause (e.g.
   * of a listener of its `pause` that fails later), would crash the process.
   * Nothing of it is called, neither its own `pause()` nor
   * `Readable.prototype.pause()` (which emits `pause` to the listeners of
   * the application): that is only logged (`debug`), and it is the
   * application's to release. Also for a stream-like source (see
   * `readStreamLike()`).
   */
  #unreleased(): void {
    this.#ownership.note(
      "A stream could not be released",
      "No listener of its error event can be added",
    );
  }

  /**
   * Closes a response whose send has failed once its headers are committed
   * (see `#pipe()`), as the framework closes it, while the work that sends it
   * may still mutate it: one that waits for the response before it on its
   * connection is cut once it gets its socket (see `#cutQueued()`), so that
   * its committed head is never sent, and no later response of the
   * connection is read as its body
   */
  #cutFailed(): void {
    if (this.#allows()) {
      this[kFramework](() => this.destroy());
    }
  }

  /**
   * Whether a write of a send (`discarded`, the count of the discarded writes
   * before it, see `#discardedWrites`) has been discarded explicitly by the
   * library that has replaced the response inside it (see
   * `[kDiscardWrite]()`, e.g. the `406` of `@binden/compression`, which
   * discards the writes of the application and calls back each of them).
   * Bytes that are gone then (see `bytesLost()`) are not part of the
   * response, whose head frames its own empty body: no mismatch, and the
   * send settles as the response does. Nothing else drops them: the bytes
   * that a writer has given to Node.js (by `write()`, or by `end()`), or to
   * a compressor, are framed and queued, also when that write has ended the
   * response.
   */
  #dropped(discarded: number): boolean {
    return this.#discardedWrites !== discarded;
  }

  /**
   * Closes a response whose bytes are gone once binden has written them (see
   * `bytesLost()`), with the rights of the framework, before Node.js flushes
   * what it has queued: its head declares bytes that are never written (or,
   * in chunks, they are dropped), and the client would read the next
   * response of the connection as its body. Also once the response has ended
   * (e.g. by a writer that has given them to binden, then ended it, inside
   * that write), and whichever work may mutate it: one that waits for the response before it on its
   * connection is cut once it gets its socket (see `#cutQueued()`).
   */
  #cutLost(): void {
    this.#cut = true;
    this[kFramework](() => this.destroy());
  }

  /**
   * Removes the framing of a send that has failed before the headers are
   * committed (whatever has ended it), so that the reply that follows does
   * not inherit it: with the rights of the framework (its owner may have been
   * abandoned), but only while the framing is still the one of that send
   * (`generation`): the headers of another reply that has framed the
   * response since stay.
   */
  #unframe(generation: number): void {
    if (generation === this.#framing) {
      this[kFramework](() => {
        this.#remove("Content-Length", "Transfer-Encoding", "Content-Range");
      });
    }
  }

  /**
   * The reason of a send whose owner has been abandoned: the reason of the
   * signal of the request once it is aborted (as `[kCancel]()` would), its
   * own error otherwise
   */
  #abandoned(error: Error): Error {
    const signal = Exchange.find(this.req)?.signal;
    return signal?.aborted === true ? (signal.reason as Error) : error;
  }

  /**
   * The `Content-Length` of the response, `null` without a valid one (see
   * `framingLength()`, which `@binden/compression` reads it by as well). A
   * value of another type (or an element, also a hole of an array) throws
   * the `TypeError` of `ERR_HTTP_INVALID_HEADER_VALUE` (see
   * `lengthValues()`): never converted, never read as no length
   */
  #length(): number | null {
    return framingLength(this.getHeader("Content-Length"));
  }

  /**
   * The `Content-Length` of the response (see `#length()`), `null` for a
   * value that it refuses: only to tell whether a body is complete for the
   * client, never to frame it (e.g. once the head has been committed around
   * binden, by `writeHead()` of Node.js)
   */
  #knownLength(): number | null {
    try {
      return this.#length();
    } catch {
      return null;
    }
  }

  /**
   * The error of a close before the end, whose stack is formatted (see
   * `formatStack()`): a send rejects with it, or destroys its source with it
   */
  static #premature(): Error {
    return Object.assign(formatStack(new Error("Premature close")), {
      code: "ERR_STREAM_PREMATURE_CLOSE",
    });
  }

  /**
   * The error of a body that does not have its `Content-Length`, whose stack
   * is formatted (see `formatStack()`), as the one of `#premature()`
   */
  static #mismatch(size: number, length: number): Error {
    const message = `The body (${size} bytes) does not match its Content-Length (${length} bytes)`;
    return Object.assign(formatStack(new Error(message)), {
      code: "ERR_HTTP_CONTENT_LENGTH_MISMATCH",
    });
  }

  /**
   * What `send()` sends: a `Readable`, a stream-like source (its methods, see
   * `IStreamLike`), a value (bytes, a string, a number or nothing), or
   * `null` for another object, which it refuses. What reading the data throws
   * (e.g. of a revoked proxy) is formatted (see `formatting()`).
   */
  static #kind(
    data: unknown,
  ): IStreamLikeMethods | "readable" | "value" | null {
    return formatting(() => {
      if (data instanceof Readable) {
        return "readable";
      } else if (
        isUint8Array(data) ||
        (typeof data !== "object" && typeof data !== "function")
      ) {
        return "value";
      }
      return data === null ? null : streamLikeOf(data);
    });
  }

  /**
   * Releases a source (a `Readable`, or a stream-like one) that will not be
   * sent: a late error of a stream-like one is reported (see `#report()`)
   */
  #release(
    data: unknown,
    kind: IStreamLikeMethods | "readable" | "value" | null,
  ): void {
    if (kind === "readable") {
      this.#discard(data as Readable);
    } else if (kind !== null && kind !== "value") {
      releaseStreamLike(
        data as object,
        kind,
        this.#report(),
        () => {
          this.#unreleased();
        },
        this.#streamLikeLogs(),
      );
    }
  }

  /**
   * How a late error of a source that is not sent, or no longer (also the
   * request of the response, which is never destroyed), is reported (see
   * `ISourceReport`): by the framework (see `IOwnership.released`), or not at
   * all
   */
  #report(): ISourceReport {
    return this.#ownership.released ?? unreported;
  }

  /**
   * How code of a stream-like source that throws while it is released (its
   * guard refused, a `pause()` or a `destroy()`, or a removal of a listener)
   * is logged (`debug`, see `IStreamLikeLogs`): with the messages of a
   * Node.js `Readable` (see `#guardReleased()`, `#pipe()`), not as a late
   * error. They hold the response: no listener of the guard of the source
   * holds them (see `guard()`), which only the report of a late error does
   * (see `#report()`)
   */
  #streamLikeLogs(): IStreamLikeLogs {
    return {
      released: (error: unknown): void => {
        this.#ownership.debug("The release of a stream has failed", error);
      },
      removed: (error: unknown): void => {
        const message = "The removal of a listener of a stream has failed";
        this.#ownership.debug(message, error);
      },
    };
  }

  /**
   * Releases the data of a send that is ignored when it is a Node.js
   * `Readable` (see `#isReadable()`), whose file (or the like) would stay
   * open (see `#discard()`): the send is still ignored. Anything else (e.g. a
   * stream-like source, or a `Proxy`) is not touched.
   */
  #releaseIgnored(data: unknown): void {
    if (BindenResponse.#isReadable(data)) {
      this.#discard(data);
    }
  }

  /**
   * Whether a value is a Node.js `Readable`, without running any code of it:
   * an object whose prototype chain reaches `Readable.prototype`, read link
   * by link, none of which may be a `Proxy` (whose `getPrototypeOf` trap
   * would run)
   */
  static #isReadable(value: unknown): value is Readable {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    for (let link: object | null = value; link !== null;) {
      if (isProxy(link)) {
        return false;
      }
      link = Object.getPrototypeOf(link) as object | null;
      if (link === Readable.prototype) {
        return true;
      }
    }
    return false;
  }

  /**
   * Releases a Node.js `Readable` that is not sent, or no longer (to a
   * response without a body, for an informational status, once its send is
   * ignored, cancelled, or stopped by another writer), unless it has emitted
   * its `close` already: it is destroyed by `Readable.prototype.destroy()`
   * (never through its own `destroy()`, its `_destroy()` runs) under a guard
   * that the methods of `EventEmitter` install (see `guard()`), one however
   * many sends release it, which reports a late error (e.g. of a file that
   * fails to close). A source that refuses its guard is destroyed only
   * while the listener of `error` of its send listens (`listened`), and is
   * left otherwise (see `#unreleased()`). A failure of the release is logged
   * (`debug`). Never the request of the response (e.g. an echo, see
   * `#destroys()`).
   */
  #discard(source: Readable, listened = false): void {
    if (!this.#destroys(source)) {
      return;
    }
    try {
      const state = Reflect.get(source, "_readableState") as
        { readonly closeEmitted?: unknown } | undefined;
      if (state?.closeEmitted !== true) {
        // Its guard listens before it is destroyed, or else the listener of
        // `error` of its send (`listened`)
        if (this.#guardReleased(source) || listened) {
          Reflect.apply(destroyReadable, source, []);
        } else {
          this.#unreleased();
        }
      }
    } catch (error: unknown) {
      const message = "The release of a stream has failed";
      this.#ownership.debug(message, error);
    }
  }

  /**
   * Whether a source that is not sent, or no longer, may be destroyed: not
   * the request of the response (e.g. an echo, `send(request)`), whose
   * `_destroy()` would destroy the socket when its body has not been read to
   * its end, and with it the reply (e.g. of the error that follows) and the
   * responses before it on the connection. It is only left (its listeners
   * stop reading it): once the reply has finished, Node.js reads the rest of
   * its body, and the reply of the framework closes the connection when that
   * body has not come in full (see `request.complete`).
   */
  #destroys(source: Readable): boolean {
    return source !== this.req;
  }

  /**
   * Resolves when the response has finished (flushed to the connection), rejects
   * when it is closed before (e.g. the client went away), unless it is
   * `complete()` for the client already. What removes its observers is added
   * to `unlisten` (e.g. for a send that settles otherwise, see `#pipe()`).
   * `ended` is told at once how it settles (its error, `null` once it has
   * finished, or is complete), before any reaction to the promise runs: e.g.
   * for a send that settles at once when the response closes (see `#pipe()`).
   */
  #finished(
    complete: () => boolean,
    unlisten: (() => void)[] = [],
    ended?: (error: Error | null) => void,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const settle = (error: Error | null): void => {
        for (const dispose of unlisten) {
          dispose();
        }
        ended?.(error);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      if (this.destroyed) {
        settle(BindenResponse.#premature());
        return;
      }
      const listeners: [string, (error?: Error) => void][] = [];
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
        unlisten.push(this[kListen](event, listener));
      }
    });
  }

  /**
   * What refuses a send of a file by its status (`null` when it is
   * accepted): converted once, before anything decides by it (see
   * `#status()`), one that its conversion refuses (or whose conversion
   * throws), or an informational one, as `#send()` refuses it (which would
   * refuse the file only once its headers are set)
   */
  #fileRefusal(): Error | null {
    try {
      const code = this.#status();
      return BindenResponse.#informational(code)
        ? BindenResponse.#notFinal(code)
        : null;
    } catch (error: unknown) {
      return formatStack(error as Error);
    }
  }

  /**
   * A send of a file (by its key, see `#rollbacks`) has failed once it has
   * set the headers of the file, before the head is committed (e.g. refused
   * by a status that the application has changed while the file was opened,
   * or by Node.js as it commits the head): the response is restored as it was
   * before it, without the framing of a body nor the representation chosen
   * for it (as by `[kCancel]()`), so that the reply that follows (e.g. of the
   * error) has none of the headers of the file. Not once its cancellation is
   * recorded (`[kCancel]()` restores it), nor by a work that may no longer
   * mutate the response (`owner`).
   */
  #unwind(key: object, owner: object | undefined): void {
    const rollback = this.#rollbacks.get(key);
    if (
      typeof rollback === "function" &&
      !this.headersSent &&
      !this.#cancellations.has(key) &&
      this.#allows(owner)
    ) {
      this.#rollbacks.delete(key);
      rollback();
      this.#remove("Content-Length", "Transfer-Encoding", "Content-Range");
      this.#forget();
    }
  }

  /**
   * Send a file: a filesystem path (or a `file:` URL), trusted without `root`;
   * with `root`, a relative path that must stay inside it (see
   * `ISendFileOptions`). Its metadata and its content are read from one file
   * handle, and no more than its size is sent. It is the body of the status
   * set before (e.g. a page of an error): the preconditions apply to a `2xx`
   * (or a `412`) only, the ranges to a `200`. Before the headers are
   * committed, the framework may cancel it (see `[kCancel]()`): it then
   * rejects with the reason at once, its headers and status are those from
   * before it, or from before an earlier send in progress that is cancelled
   * with it (e.g. another `sendFile()`), without the framing of a body (e.g.
   * a `Content-Length` set before it), and a file opened later is closed. So
   * is a file whose send would be ignored (once the response has ended, or
   * once the work that has called it may no longer mutate the response, e.g.
   * a failed error handler): it then resolves without sending anything, at
   * once when it is called so (without reading its options, nor resolving
   * its path).
   */
  public sendFile(
    path: URL | string,
    options?: ISendFileOptions,
  ): Promise<void> {
    // The work that sends the file, whose rights it keeps
    const owner = owners.getStore();
    if (this.writableEnded || !this.#allows(owner)) {
      // Ignored, as `#send()`: its options are not read, nor its path
      // resolved
      return Promise.resolve();
    }
    // Before anything is read, nor set
    const refusal = this.#fileRefusal();
    if (refusal !== null) {
      return Promise.reject(refusal);
    }
    const status = this.statusCode;
    const headers = new Map(
      this.getHeaderNames().map((name) => [name, this.getHeader(name)]),
    );
    const key = {};
    let settled = false;
    return this.#cancellable(key, (resolve, reject) => {
      // As the settlement of `#pipe()`: a cancellation always fails (with a
      // reason that may be anything)
      const settle = (error: Error | null, cancelled = false): void => {
        if (!settled) {
          settled = true;
          // Restored by `[kCancel]()` still, once its cancellation is
          // recorded (e.g. it has seen that its work may no longer mutate the
          // response, or the send of its file has failed in between)
          this.#settled(key);
          if (error === null && !cancelled) {
            resolve();
            return;
          }
          const failure = error as Error;
          reject(failure);
        }
      };
      // The headers and the status from before the file, which
      // `[kCancel]()` restores first (see `#rollbacks`)
      this.#rollbacks.set(key, () => {
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
      });
      // Started at once (see `.started`), until it fails before sending
      // anything
      this.#pending.set(key, (reason: unknown) => {
        settle(reason as Error, true);
      });
      sendFileTo(
        this,
        path,
        options,
        // Called right after its last check (below): nothing is awaited
        // in between
        (length) => this.#endNotModified(length),
        // Cancelled, or its send would be ignored (see `#send()`)
        () => settled || this.writableEnded || !this.#allows(owner),
        // It has failed once it has set the headers of the file
        () => {
          this.#unwind(key, owner);
        },
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
