import Cookie, { type ICookie } from "./headers/cookie.js";
import {
  type IFramingState,
  framingCounters,
  framingFields,
  kRestoreFraming,
  kSaveFraming,
} from "./framing.js";
import {
  type IListener,
  adderNames,
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
  kFramework,
  kListen,
  kNegotiator,
  kOperation,
  kOwnership,
  kPipeFailure,
  kRepresentation,
  kRevoke,
  kSeal,
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
  IncomingMessage,
  type OutgoingHttpHeader,
  type OutgoingHttpHeaders,
  ServerResponse,
  validateHeaderName,
  validateHeaderValue,
} from "node:http";
import { contentDigests, representationDigests } from "./digests.js";
import { isProxy, isUint8Array } from "node:util/types";
import { split, trimOws } from "./headers/list.js";
import { BindenRequest } from "./request.js";
import ContentType from "./headers/content-type.js";
import { EventEmitter } from "node:events";
import { Exchange } from "./exchange.js";
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

/** How a response handles the works that own it without the framework (see `kOwnership`) */
const unowned: IOwnership = {
  fail: (): boolean => false,
  guards: (): boolean => false,
  debug: (): void => {
    // Nobody to tell
  },
  warn: (): void => {
    // Nobody to tell
  },
};

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
 * one of the source itself), if it is still piped into it
 */
function unpipe(source: EventEmitter, destination: object): void {
  const method: unknown = Reflect.get(
    Object.getPrototypeOf(source) as object,
    "unpipe",
  );
  if (typeof method === "function" && pipesInto(source, destination)) {
    Reflect.apply(method, source, [destination]);
  }
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
  readonly #pending = new Map<
    object,
    (reason: unknown, release: (() => void)[]) => void
  >();
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
  /** The works whose re-emitted `error` is absorbed now (see `#deliver()`) */
  readonly #absorbing = new Set<object>();
  /** The pipe whose adopted `data` listener runs now (see `destroy()`) */
  #marker: IMarker | null = null;
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
    function rawListeners(
      this: BindenResponse,
      event: string | symbol,
    ): IListener[] {
      return rawListenersOf(this, event as string).map((raw) => {
        const binding = bindingOf(raw);
        return binding && !binding.once ? binding.listener : raw;
      });
    }
    function emit(
      this: BindenResponse,
      event: string | symbol,
      ...args: unknown[]
    ): boolean {
      if (event === "pipe") {
        this.#piping(args[0]);
      } else if (event === "unpipe") {
        this.#unpiped(args[0]);
      } else if (
        event === "error" &&
        this.#absorbing.has(owners.getStore() as object)
      ) {
        // Re-emitted by a listener of an abandoned work (e.g. the pipe of
        // Node.js once it has unpiped): the framework handles the error
        return false;
      }
      return parent.emit.call(this, event, ...args);
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
        const owner = owners.getStore();
        const bound = bind(
          listener,
          owner,
          "user",
          once ? { emitter: this, event } : null,
        );
        const result = parent[name].call(this, event, bound) as BindenResponse;
        if (event === "close") {
          this.#late(owner, bound);
        }
        return result;
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
    if (this.#allows(owner)) {
      this.#piped = true;
    }
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
   * (see `#refuse()`), and the work that has piped it fails.
   */
  #adopt(source: EventEmitter, owner: object | undefined): void {
    const refusal = this.#refusal(source);
    if (refusal !== null) {
      this.#refuse(source, owner, refusal);
      return;
    } else if (!openWindow(source)) {
      this.#refuse(source, owner, "its listeners cannot be bound");
      return;
    }
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
   * response, or a method of the source itself that the pipe calls), or it is
   * not a pipe of `Readable.prototype.pipe()` (e.g. the legacy
   * `Stream.prototype.pipe()`), whose last `data` listener and `end` wrapper
   * it has just added. The source is inspected by the methods of every
   * emitter, never by its own ones.
   */
  #refusal(source: EventEmitter): string | null {
    const listens = (emitter: EventEmitter): boolean =>
      intrinsic.listenerCount.call(emitter, "newListener") +
        intrinsic.listenerCount.call(emitter, "removeListener") >
      0;
    if (listens(source)) {
      return "the source has listeners of its listeners";
    } else if (listens(this)) {
      return "the response has listeners of its listeners";
    }
    const own = inspected.find(
      (name) => Object.hasOwn(source, name) && !isPatch(source, name),
    );
    if (typeof own !== "undefined") {
      return `the source has its own ${own}()`;
    } else if (!pipesInto(source, this)) {
      return "it is not a pipe of Readable.prototype.pipe()";
    }
    const data = rawListenersOf(source, "data").at(-1);
    const plain =
      bindingOf(data)?.once === false ||
      (typeof data === "function" && !("listener" in data));
    if (!plain) {
      return "its data listener is not the one of the pipe";
    } else if (hasEnded(source)) {
      return null;
    }
    const end = rawListenersOf(source, "end").at(-1);
    const once =
      typeof end === "function" &&
      typeof (end as { listener?: unknown }).listener === "function";
    return once ? null : "its end listener is not the one of the pipe";
  }

  /**
   * Refuses a pipe (see `#refusal()`): the work that has piped it fails at
   * once with a `TypeError` (see `#pipeFailed()`), which revokes it before
   * anything runs code of the application, and closes the response for it
   * (see `[kRevoke]()`). Then it is unpiped (by the method of the class of
   * the source) in that work, which may no longer mutate the response (e.g.
   * from a listener of `removeListener` of the source): a failure of that
   * cleanup is only logged. A legacy pipe, which has no `unpipe()`, is
   * dismantled by its `close` listener. The pipe of a work that the framework
   * does not know (e.g. of no request, or of another request) is unpiped as
   * well, and the response left to its owner.
   */
  #refuse(
    source: EventEmitter,
    owner: object | undefined,
    reason: string,
  ): void {
    const error = new TypeError(
      `The pipe into the response is refused: ${reason}`,
    );
    const failed = this.#pipeFailed(owner, error, null);
    try {
      unpipe(source, this);
    } catch (cleanup: unknown) {
      const message = "The cleanup of a refused pipe has failed";
      this.#ownership.debug(message, cleanup);
    }
    if (!failed) {
      const message =
        "A pipe of a work of no request (or of another) has been refused";
      this.#ownership.warn(message, reason);
    }
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
   * still piped are then unpiped. Never the listeners of another work, nor
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
      unpipe(source, this);
    }
    this.#sources.delete(owner);
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
   * anything), or by its headers being sent
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
      typeof media_type === "string" && isStrictMediaType(media_type)
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
    } else if (!this.headersSent) {
      // Node.js would throw only once it has changed the response (its status
      // and reason phrase, and some of the headers)
      this[kValidateHead](statusCode, reason, headers);
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
    return this.#restoring(() => {
      if (this.headersSent || this.cookies.size === 0) {
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
    this[kFramework](() => {
      for (const name of this.getHeaderNames()) {
        super.removeHeader(name);
      }
      for (const [name, value] of state.headers) {
        super.setHeader(name, BindenResponse.#copy(value));
      }
      for (const [name, value] of state.fields) {
        Reflect.set(this, name, value);
      }
    });
    this.#statusCode = state.status;
    this.#statusMessage = state.reason;
    this.#framing = state.generation;
  }

  /**
   * Checks the arguments of `writeHead()` as Node.js does, without changing
   * the response (see `kValidateHead`): the reason phrase that it would send
   * (the one given, or else the one of the response), and the names and the
   * values of the headers given (a list must be of pairs). An invalid status
   * code is left to `writeHead()`, which throws before it changes anything.
   *
   * @internal
   */
  public [kValidateHead](...args: unknown[]): void {
    const [statusCode, reason, headers] = args;
    const code = (statusCode as number) | 0;
    if (code < 100 || code > 999) {
      return;
    }
    const message = typeof reason === "string" ? reason : this.statusMessage;
    if (typeof message === "string" && invalidReason.test(message)) {
      throw Object.assign(new TypeError("Invalid character in statusMessage"), {
        code: "ERR_INVALID_CHAR",
      });
    }
    const given = typeof reason === "string" ? headers : (headers ?? reason);
    const pairs: unknown[] = Array.isArray(given)
      ? Array.isArray(given[0])
        ? given.flat()
        : given
      : Object.entries(given ?? {}).flat();
    if (pairs.length % 2 !== 0) {
      throw Object.assign(new TypeError("The argument 'headers' is invalid"), {
        code: "ERR_INVALID_ARG_VALUE",
      });
    }
    for (let index = 0; index < pairs.length; index += 2) {
      const name = pairs[index] as string;
      // Node.js skips an empty name (of the headers that it sets)
      if (name !== "") {
        validateHeaderName(name);
        // Also an array (of the values of the header) or a number
        validateHeaderValue(name, pairs[index + 1] as string);
      }
    }
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
    // The method of the response itself (e.g. of a compression)
    return this.writeHead(...(args as [number, string]));
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
    const written = this.#normalized(args, false);
    // Node.js counts the bytes of its chunk before it commits the head (see
    // `#restoring()`)
    return this.#restoring(() => {
      this.#ordered(written, false);
      return super.write(...(callbacksOf(written) as [unknown]));
    });
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
        new TypeError(`Unknown encoding: ${encoding as string}`),
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
    const status = this.statusCode;
    return (
      Reflect.get(this, "_hasBody") === true &&
      (Boolean(Reflect.get(this, "_header")) ||
        !(
          BindenResponse.#informational(status) ||
          status === 204 ||
          status === 304
        ))
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
    if (!this.#allows()) {
      BindenResponse.#ignore(args);
      return this;
    }
    this.#chunkOfEnd(args[0]);
    const ended = this.#normalized(args, true);
    // Node.js frames the body of its chunk before it commits the head (see
    // `#restoring()`)
    return this.#restoring(() => {
      this.#ordered(ended, true);
      return this.#uncorking(() => super.end(...(callbacksOf(ended) as [])));
    });
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
   * (and uncorks it once it has ended the response): when it throws (e.g. for
   * a head that Node.js refuses), the socket is uncorked back to what it was,
   * so that the reply that follows is not held (e.g. a `flush()` would never
   * resolve, and a body larger than the socket buffers would wait for a
   * `drain` that never comes)
   */
  #uncorking<T>(fn: () => T): T {
    const { socket } = this;
    const corked = socket?.writableCorked ?? 0;
    try {
      return fn();
    } catch (error: unknown) {
      if (socket !== null) {
        while (socket.writableCorked > corked) {
          socket.uncork();
        }
      }
      throw error;
    }
  }

  /** Sends the headers (see `flushHeaders()` of Node.js), unless the response is sealed */
  public override flushHeaders(): void {
    if (this.#allows()) {
      super.flushHeaders();
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
    if (!this.#allows()) {
      return this;
    }
    super.setHeader(name, BindenResponse.#copy(value));
    this.#reframed(name);
    return this;
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
    return BindenResponse.#copy(super.getHeader(name));
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

  /** Appends a header (see `appendHeader()` of Node.js), unless the response is sealed */
  public override appendHeader(
    name: string,
    value: string | readonly string[],
  ): this {
    if (!this.#allows()) {
      return this;
    }
    super.appendHeader(name, value);
    this.#reframed(name);
    return this;
  }

  /** Sets headers (see `setHeaders()` of Node.js), unless the response is sealed */
  public override setHeaders(
    headers: Headers | Map<string, number | string | readonly string[]>,
  ): this {
    return this.#allows() ? super.setHeaders(headers) : this;
  }

  /**
   * Sets the timeout of the socket (see `setTimeout()` of Node.js), unless the
   * response is sealed: the abandoned work cannot cut the reply of the
   * framework by the timeout of its connection
   */
  public override setTimeout(msecs: number, callback?: () => void): this {
    return this.#allows() ? super.setTimeout(msecs, callback) : this;
  }

  /** Removes a header (see `removeHeader()` of Node.js), unless the response is sealed */
  public override removeHeader(name: string): void {
    if (this.#allows()) {
      super.removeHeader(name);
      this.#reframed(name);
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
   * of the framework. With an error while an adopted pipe writes (see
   * `#adopt()`), it is the `data` listener of the pipe that catches a write
   * that throws (e.g. for a head that Node.js refuses): the pipe fails
   * instead (see `#pipeFailed()`), so that its work gets the error. So does
   * a destroy by an error handler that its pipe guards (see `#guarded()`),
   * with its error (or `ERR_STREAM_PREMATURE_CLOSE`).
   */
  public override destroy(error?: Error): this {
    const marker = this.#marker;
    const owner = owners.getStore();
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
    }
    return this.#allows() ? super.destroy(error) : this;
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
  #guarded(owner: object | undefined): owner is object {
    return (
      typeof owner !== "undefined" &&
      !this.headersSent &&
      !this.destroyed &&
      !forced(this) &&
      this.#ownership.guards(owner) &&
      this.#allows(owner) &&
      (this.#sources.get(owner)?.size ?? 0) > 0
    );
  }

  /**
   * Sends `100 Continue`, unless the response is sealed or the request is
   * HTTP/1.0 (its callback is then called asynchronously)
   */
  public override writeContinue(callback?: () => void): void {
    if (!this.#informs()) {
      BindenResponse.#ignore([callback]);
      return;
    }
    super.writeContinue(...(callbacksOf([callback]) as []));
  }

  /**
   * Sends `102 Processing`, unless the response is sealed or the request is
   * HTTP/1.0 (its callback is then called asynchronously)
   */
  public override writeProcessing(callback?: () => void): void {
    if (!this.#informs()) {
      BindenResponse.#ignore([callback]);
      return;
    }
    super.writeProcessing(...(callbacksOf([callback]) as []));
  }

  /**
   * Sends `103 Early Hints`, unless the response is sealed or the request is
   * HTTP/1.0 (its callback is then called asynchronously)
   */
  public override writeEarlyHints(
    hints: Record<string, string[] | string>,
    callback?: () => void,
  ): void {
    if (!this.#informs()) {
      BindenResponse.#ignore([callback]);
      return;
    }
    super.writeEarlyHints(hints, ...(callbacksOf([callback]) as []));
  }

  /**
   * Sends an informational response (see `writeInformation()` of Node.js,
   * from 24.18.0), unless the response is sealed or the request is HTTP/1.0
   * (its callback is then called asynchronously)
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
    if (!this.#informs()) {
      BindenResponse.#ignore(args);
      return;
    }
    super.writeInformation(...(callbacksOf(args) as [number]));
  }

  /** Calls the callback (if any) of an ignored call once, asynchronously and without an error */
  /**
   * Whether an informational response may be sent: not once the response is
   * sealed, and never to an HTTP/1.0 client, which does not know them
   * (RFC 9110, section 15.2)
   */
  #informs(): boolean {
    const { httpVersionMajor = 1, httpVersionMinor = 1 } = this.req as {
      httpVersionMajor?: number;
      httpVersionMinor?: number;
    };
    const old =
      httpVersionMajor < 1 || (httpVersionMajor === 1 && httpVersionMinor < 1);
    return !old && this.#allows();
  }

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
    for (const owner of revoked) {
      this.#revoked.set(owner, false);
    }
    return new Promise<void>((resolve) => {
      process.nextTick(() => {
        for (const owner of revoked) {
          this.#revoked.set(owner, true);
          this.#deliver(
            owner,
            failure?.owner === owner ? [failure.error] : null,
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
   * Adds a listener of the framework (see `kListen`), which runs once
   *
   * @internal
   */
  public [kListen](event: string, listener: () => void): void {
    const owner = owners.getStore();
    const once = { emitter: this, event };
    parent.on.call(this, event, bind(listener, owner, "service", once));
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
      // A stream piped by the work that is abandoned has written nothing,
      // and writes nothing from now on: it no longer starts the response
      this.#piped = false;
      const release: (() => void)[] = [];
      this[kFramework](() => {
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
   * Runs a function of the framework with its rights, whoever owns the
   * response (e.g. to destroy it once sealed)
   *
   * @internal
   */
  public [kFramework]<T>(fn: () => T): T {
    return force(this, fn);
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
    try {
      return this.#send(data, encoding);
    } catch (error: unknown) {
      // E.g. a reason phrase or a `Trailer` that Node.js refuses once it sends
      // the headers: the response is unchanged, and the error can be replied
      const failure = error as Error;
      return Promise.reject(failure);
    }
  }

  /** `send()`, which may throw before it has changed the response */
  #send(
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
        // The representation and the framing of the length that it declares
        // (unknown without one, not empty), without a stale `Transfer-Encoding`
        this[kRepresentation](this.#length());
        this.#frame(this.#length());
        this.#remove(...contentDigests);
        return this.#end();
      }
      return this.#pipe(data);
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
      return this.#endNotModified(body.length);
    } else if (status !== null) {
      // Empty, also for `HEAD` (which would keep the length of a body), and
      // without the coding nor the digests of the body (e.g. a precompressed
      // one), whose representation it replaces
      this.statusCode = status;
      this.#remove(
        "Content-Encoding",
        ...contentDigests,
        ...representationDigests,
      );
      this.#frame(0);
      return this.#end();
    }

    this.#frame(body.length);

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
      this.write(body, (error?: Error | null) => {
        if (error) {
          reject(error);
        }
      });
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
   * Sends `304 Not Modified` for a `200` whose body has `length` bytes (see
   * `sendFile()`, whose headers are not sent yet), unless it is late
   */
  #sendNotModified(length: number): Promise<void> {
    if (!this.#allows()) {
      return Promise.resolve();
    }
    return this.#endNotModified(length);
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
      // First: when it throws (e.g. for a reason phrase that Node.js refuses),
      // the promise rejects without a listener left
      this.flushHeaders();
      const fail = (error?: Error): void => {
        this.off("close", fail).off("error", fail);
        reject(error ?? BindenResponse.#premature());
      };
      this[kListen]("close", fail);
      this[kListen]("error", fail);
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
            this.#unframe(framed);
          }
          // Abandoned at the deadline (e.g. its source destroyed by a
          // listener of `signal`, before the deadline cancels it), it fails
          // as a cancelled send
          reject(operation.active ? error : this.#abandoned(error));
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
          return;
        }
        try {
          this.end();
        } catch (error: unknown) {
          // Nothing sent (e.g. an empty source, whose headers Node.js
          // refuses): never thrown out of the events of the source
          fail(error as Error);
        }
      };
      this.#pending.set(key, (reason: unknown, release: (() => void)[]) => {
        release.push(() => {
          BindenResponse.#discard(data);
        });
        // The framing of the body that is not sent
        this.#remove("Content-Length", "Transfer-Encoding", "Content-Range");
        settle(reason as Error);
      });

      this[kListen]("close", () => {
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
              // Once written: a first write that throws (e.g. for a reason
              // phrase that Node.js refuses) has sent nothing
              sent += size;
              if (!accepted) {
                data.pause();
                this[kListen]("drain", () => {
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
        this[kListen](event, listener);
      }
    });
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
