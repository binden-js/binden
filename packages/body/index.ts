import { addAbortListener } from "node:events";
import {
  type Duplex,
  Transform,
  Writable,
  finished,
  pipeline,
} from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import {
  BindenAbortError,
  BindenError,
  type ContentType,
  type Context,
  type IMiddlewareParams,
  Middleware,
  serializers,
} from "binden";

/** How a selected body is parsed: JSON (with `parse`), text, a form or raw bytes */
export type IBodyKind = "form" | "json" | "raw" | "text";

/**
 * The bodies to parse: a list of media types (`type/subtype`, `type/*`,
 * `* /*`, or a structured syntax suffix such as `+json`), or a function of
 * the `Content-Type` that returns the kind of the body (`null` skips it)
 */
export type IBodyType =
  readonly string[] | ((content_type: ContentType) => IBodyKind | null);

/**
 * Parses a JSON body into its final value (`T`), synchronously or not:
 * `undefined` tells that the body is invalid (`400 Bad Request`)
 */
export type IParse<T = unknown> = (
  input: string,
) => T | undefined | Promise<T | undefined>;

/** The options of a `BodyParser` */
export interface IBodyParserOptions<T = unknown> extends IMiddlewareParams {
  /**
   * Parses a JSON body (`JSON.parse()` by default): its result (or what its
   * promise resolves to) is `request.body`
   */
  parse?: IParse<T> | undefined;
  /**
   * The largest body in bytes once its content codings are removed, at every
   * stage of the decoding (no limit by default, `Infinity`): a larger one
   * gets a `413 Content Too Large`
   */
  limit?: number | undefined;
  /**
   * The largest body in bytes as received (no limit by default, `Infinity`):
   * a larger `Content-Length` gets a `413 Content Too Large` before the body
   * is read, as does a larger body once read
   */
  encoded_limit?: number | undefined;
  /**
   * The bodies to parse (JSON, `+json`, `text/plain` and forms by default):
   * the others are skipped, and left to the next middlewares
   */
  type?: IBodyType | undefined;
  /** Whether `application/octet-stream` is parsed, as a `Buffer` (`false`) */
  raw?: boolean | undefined;
  /** Whether the default `parse` accepts only an object or an array (`true`) */
  strict?: boolean | undefined;
  /** The most parameters of a form (`1000`): more get a `413 Content Too Large` */
  parameter_limit?: number | undefined;
}

/** A decoder of a content coding, created once every coding is known to be supported */
type IDecoder = () => Duplex;

/** The outcome of a callback of the options that has settled */
type IOutcome<R> =
  | { readonly ok: true; readonly value: R }
  | { readonly ok: false; readonly error: unknown };

/** The logger of the parser (`context.log`, whose calls never fail) */
type ILog = Context["log"];

/** The most content codings that a body may have */
const MAX_CODINGS = 2;

const kinds: ReadonlySet<string> = new Set(["form", "json", "raw", "text"]);

const token = "[!#$%&'*+.^_`|~\\w-]+";

/** `type/subtype` (either may be `*`), or a structured syntax suffix (`+json`) */
const mediaRange = new RegExp(`^(?:${token}/${token}|\\+${token})$`, "u");

/** A JSON text that the strict default `parse` accepts: an object or an array */
const strictJSON = /^[\t\n\r ]*[[{]/u;

/** The requests whose body has been claimed by a parser (read, or being read) */
const claimed = new WeakSet<object>();

function isKind(value: unknown): value is IBodyKind {
  return typeof value === "string" && kinds.has(value);
}

/** Does nothing (e.g. with a rejection that is observed) */
function ignore(): void {
  // Observed
}

/** The outcome of a call that may throw */
function attempt<R>(call: () => R): IOutcome<R> {
  try {
    return { ok: true, value: call() };
  } catch (error: unknown) {
    return { ok: false, error };
  }
}

/** Whether a media type matches an entry of `type` */
function matches(entry: string, type: string): boolean {
  if (entry.startsWith("+")) {
    return type.endsWith(entry) && !type.endsWith(`/${entry}`);
  }
  const [range = "", subrange = ""] = entry.split("/");
  const [main = "", sub = ""] = type.split("/");
  return (
    (range === "*" || range === main) && (subrange === "*" || subrange === sub)
  );
}

/** The kind of a media type that a list of `type` selects */
function kindOf(type: string): IBodyKind {
  if (type === "application/json" || type.endsWith("+json")) {
    return "json";
  } else if (type === "application/x-www-form-urlencoded") {
    return "form";
  } else if (type.startsWith("text/")) {
    return "text";
  }
  return "raw";
}

/** Whether a form has more than `max` parameters (counted without parsing it) */
function tooManyParameters(form: string, max: number): boolean {
  let count = 0;
  let start = 0;
  while (count <= max) {
    const end = form.indexOf("&", start);
    const stop = end === -1 ? form.length : end;
    if (stop > start) {
      count += 1;
    }
    if (end === -1) {
      break;
    }
    start = end + 1;
  }
  return count > max;
}

/** A limit: a non-negative integer, or `Infinity` */
function validateLimit(name: string, value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new TypeError(`\`${name}\` is not a number`);
  } else if (
    value !== Infinity &&
    !(Number.isSafeInteger(value) && value >= 0)
  ) {
    throw new RangeError(
      `\`${name}\` is not a non-negative integer or \`Infinity\``,
    );
  }
  return value;
}

function validateBoolean(name: string, value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`\`${name}\` is not a boolean`);
  }
  return value;
}

/** The entries of a list of `type`, in lowercase */
function validateTypes(type: unknown): readonly string[] {
  if (!Array.isArray(type)) {
    throw new TypeError("`type` is not an array or a function");
  }
  return type.map((entry: unknown) => {
    if (typeof entry !== "string" || !mediaRange.test(entry)) {
      throw new TypeError(`Invalid media type in \`type\`: ${String(entry)}`);
    }
    return entry.toLowerCase();
  });
}

/**
 * The error of an aborted request: a client that has gone away is a
 * `400 Bad Request` (`aborted`), a deadline or a shutdown is the reason of
 * `context.signal`
 */
function abortError(reason: unknown): Error {
  return reason instanceof BindenAbortError && reason.reason !== "client_closed"
    ? reason
    : new BindenError(400, { code: "aborted", cause: reason });
}

/**
 * Counts the bytes that pass through it: more than `limit` fails it with a
 * `413 Content Too Large`
 */
function counter(limit: number): Transform {
  let size = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback): void {
      size += chunk.byteLength;
      if (size > limit) {
        callback(new BindenError(413));
        return;
      }
      callback(null, chunk);
    },
  });
}

/**
 * Parses the body of a request into `request.body`: JSON (with `parse`),
 * text, a form (`URLSearchParams`) or raw bytes (a `Buffer`), once its
 * content codings are removed. The bodies that `type` does not select are
 * skipped (e.g. left to `@binden/multipart`).
 */
export class BodyParser<T = unknown> extends Middleware {
  readonly #parse: IParse<T> | null;
  readonly #limit: number;
  readonly #encoded_limit: number;
  readonly #types: readonly string[] | null;
  readonly #type: ((content_type: ContentType) => unknown) | null;
  readonly #strict: boolean;
  readonly #parameter_limit: number;

  public constructor({
    parse,
    limit = Infinity,
    encoded_limit = Infinity,
    type,
    raw = false,
    strict = true,
    parameter_limit = 1000,
    ...rest
  }: IBodyParserOptions<T> = {}) {
    super(rest);
    if (typeof parse !== "undefined" && typeof parse !== "function") {
      throw new TypeError("`parse` is not a function");
    }
    this.#limit = validateLimit("limit", limit);
    this.#encoded_limit = validateLimit("encoded_limit", encoded_limit);
    this.#parameter_limit = validateLimit("parameter_limit", parameter_limit);
    validateBoolean("raw", raw);
    this.#strict = validateBoolean("strict", strict);

    if (typeof type === "function") {
      if (raw) {
        throw new TypeError("`raw` cannot be used with a `type` function");
      }
      this.#type = type;
      this.#types = null;
    } else {
      const types =
        typeof type === "undefined"
          ? BodyParser.#defaults
          : validateTypes(type);
      this.#types = raw ? [...types, "application/octet-stream"] : types;
      this.#type = null;
    }

    // `JSON.parse` itself is the default parse
    this.#parse =
      typeof parse === "undefined" || (parse as unknown) === JSON.parse
        ? null
        : parse;
  }

  public async run(context: Context): Promise<void> {
    const { request } = context;
    const log = context.log.child({ middleware: BodyParser.name });
    const { method = "GET", content_type } = request;

    if (BodyParser.#methods.has(method)) {
      log.debug("A method without a body", { method });
      return;
    }

    const kind = content_type === null ? null : this.#kind(content_type, log);
    if (kind === null) {
      log.debug("The `Content-Type` is not selected", {
        content_type: content_type?.type ?? null,
      });
      return;
    } else if (claimed.has(request)) {
      log.debug("The body has already been parsed");
      return;
    }
    claimed.add(request);

    const { decoders, decoder } = this.#prepare(context, kind, log);
    const decoded = await this.#read(context, decoders, log);

    let text = "";
    if (decoder) {
      try {
        text = decoder.decode(decoded);
      } catch (error: unknown) {
        log.debug("The body is not valid in its charset", {
          charset: decoder.encoding,
        });
        throw new BindenError(400, { cause: error });
      }
    }

    if (kind === "json" && text === "") {
      // An empty JSON body has no value (`undefined`)
      return;
    }
    request.body =
      kind === "json"
        ? await this.#json(text, context, log)
        : kind === "form"
          ? this.#form(text, log)
          : kind === "text"
            ? text
            : decoded;
  }

  /** The kind of a body, `null` when `type` does not select it */
  #kind(content_type: ContentType, log: ILog): IBodyKind | null {
    if (this.#types !== null) {
      const { type } = content_type;
      return this.#types.some((entry) => matches(entry, type))
        ? kindOf(type)
        : null;
    }

    const select = this.#type as (content_type: ContentType) => unknown;
    const outcome = attempt(() => select(content_type));
    if (!outcome.ok) {
      log.error("The `type` function has failed", {
        failure: serializers.error(outcome.error),
      });
      throw new BindenError(500, { cause: outcome.error });
    }
    const kind = outcome.value;
    if (kind === null || isKind(kind)) {
      return kind;
    }
    // E.g. a promise, whose rejection is observed
    Promise.resolve(kind).catch(ignore);
    log.error("The `type` function has returned an invalid kind");
    throw new BindenError(500);
  }

  /**
   * Checks what can be checked before the body is read: the request, its
   * content codings (decoders are created only once all are supported), its
   * charset and its `Content-Length`. A refusal closes the connection after
   * the reply, as the body is not read.
   */
  #prepare(
    context: Context,
    kind: IBodyKind,
    log: ILog,
  ): { decoders: IDecoder[]; decoder: TextDecoder | null } {
    const { request } = context;
    const refuse = (error: Error, message: string, extra?: object): Error => {
      log.debug(message, { ...extra });
      if (!context.response.headersSent) {
        context.setHeader("Connection", "close");
      }
      return error;
    };

    // An aborted signal stops the reading (see `#read()`)
    if (request.readableDidRead || request.readableEnded) {
      // E.g. by a middleware that has read the stream itself
      log.error("The body has already been read");
      throw new BindenError(500);
    } else if (request.destroyed) {
      throw refuse(abortError(null), "The request has been aborted");
    }

    const codings = request.content_encoding;
    if (codings === null) {
      throw refuse(new BindenError(415), "Unsupported content coding");
    } else if (codings.length > MAX_CODINGS) {
      throw refuse(new BindenError(415), "Too many content codings", {
        codings: codings.length,
      });
    }

    const decoders: IDecoder[] = [];
    for (const { encoding } of codings) {
      const decoder = BodyParser.#decoder(encoding);
      if (decoder === null) {
        throw refuse(new BindenError(415), "Unsupported content coding", {
          encoding,
        });
      }
      decoders.push(decoder);
    }

    let decoder: TextDecoder | null = null;
    if (kind !== "raw") {
      const charset = context.request.content_type?.charset ?? "utf-8";
      try {
        decoder = new TextDecoder(charset, { fatal: true });
      } catch (error: unknown) {
        const unsupported = new BindenError(415, { cause: error });
        throw refuse(unsupported, "Unsupported charset", { charset });
      }
    }

    const length = Number(request.headers["content-length"] ?? Number.NaN);
    if (
      length > this.#encoded_limit ||
      (decoders.length === 0 && length > this.#limit)
    ) {
      throw refuse(new BindenError(413), "The body is too large", { length });
    }

    return { decoders, decoder };
  }

  /** The decoder of a content coding, `null` when it is not supported */
  static #decoder(encoding: string): IDecoder | null {
    if (encoding === "gzip" || encoding === "x-gzip") {
      return createGunzip;
    } else if (encoding === "deflate") {
      return createInflate;
    } else if (encoding === "br") {
      return createBrotliDecompress;
    }
    return null;
  }

  /**
   * Reads the body through its decoders, each followed by a counter of its
   * output (`limit`), after a counter of the body as received
   * (`encoded_limit`). A refusal (or an abort) stops the reading: the
   * request is paused (not destroyed, so that the reply is sent), every
   * decoder destroyed and the connection closed after the reply.
   */
  #read(
    context: Context,
    decoders: readonly IDecoder[],
    log: ILog,
  ): Promise<Buffer> {
    const { request, response, signal } = context;
    const wire = counter(this.#encoded_limit);
    const stages: Duplex[] = [wire];
    for (const create of decoders) {
      stages.push(create(), counter(this.#limit));
    }
    if (decoders.length === 0) {
      stages.push(counter(this.#limit));
    }
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback): void {
        chunks.push(chunk);
        callback();
      },
    });

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanups: (() => void)[] = [];
      const settle = (): boolean => {
        if (settled) {
          return false;
        }
        settled = true;
        for (const cleanup of cleanups) {
          cleanup();
        }
        return true;
      };
      const fail = (error: Error, message: string): void => {
        if (!settle()) {
          return;
        }
        log.debug(message, { failure: serializers.error(error) });
        // Paused (once nothing else reads it), not destroyed: the reply is sent
        request.unpipe(wire);
        for (const stream of [...stages, sink]) {
          stream.destroy();
        }
        if (!response.headersSent) {
          response.setHeader("Connection", "close");
        }
        reject(error);
      };

      const listener = addAbortListener(signal, () => {
        fail(abortError(signal.reason), "The request has been aborted");
      });
      cleanups.push(
        () => {
          listener[Symbol.dispose]();
        },
        finished(request, (error) => {
          if (error) {
            fail(abortError(error), "The request has been aborted");
          }
        }),
      );
      pipeline([...stages, sink], (error) => {
        if (error instanceof BindenError) {
          fail(error, "The body is too large");
        } else if (error) {
          const invalid = new BindenError(400, { cause: error });
          fail(invalid, "The body cannot be decoded");
        } else if (settle()) {
          resolve(Buffer.concat(chunks));
        }
      });
      request.pipe(wire);
    });
  }

  /**
   * The value of a JSON body that is not empty: a `400 Bad Request` when it
   * has only whitespace or cannot be parsed
   */
  async #json(text: string, context: Context, log: ILog): Promise<unknown> {
    if (text.trim() === "") {
      log.debug("The JSON body has only whitespace");
      throw new BindenError(400);
    }

    if (this.#parse === null) {
      if (this.#strict && !strictJSON.test(text)) {
        log.debug("The JSON body is not an object or an array");
        throw new BindenError(400);
      }
      try {
        return JSON.parse(text) as unknown;
      } catch (error: unknown) {
        log.debug("The JSON body cannot be parsed");
        throw new BindenError(400, { cause: error });
      }
    }

    const parse = this.#parse;
    const outcome = await BodyParser.#call(() => parse(text), context, log);
    if (!outcome.ok) {
      log.debug("`parse` has failed", {
        failure: serializers.error(outcome.error),
      });
      throw outcome.error instanceof BindenError
        ? outcome.error
        : new BindenError(500, { cause: outcome.error });
    } else if (typeof outcome.value === "undefined") {
      // E.g. a parser of `ajv`, which tells why in its `message`
      const { message } = parse as { message?: unknown };
      log.debug("`parse` has not parsed the body");
      throw new BindenError(400, {
        ...(typeof message === "string" ? { message } : {}),
      });
    }
    return outcome.value;
  }

  /** The parameters of a form, at most `parameter_limit` of them */
  #form(text: string, log: ILog): URLSearchParams {
    if (tooManyParameters(text, this.#parameter_limit)) {
      log.debug("The form has too many parameters", {
        parameter_limit: this.#parameter_limit,
      });
      throw new BindenError(413);
    }
    return new URLSearchParams(text);
  }

  /**
   * Calls a callback of the options (`parse`) and awaits its
   * result, unless the request is aborted first: its late result is then
   * ignored, and its late rejection observed
   */
  static async #call<R>(
    call: () => R | PromiseLike<R>,
    context: Context,
    log: ILog,
  ): Promise<IOutcome<R>> {
    const { signal } = context;
    const outcome = await new Promise<IOutcome<R> | null>((resolve) => {
      // Called (in a microtask) when the signal has already been aborted
      const listener = addAbortListener(signal, () => {
        resolve(null);
      });
      Promise.resolve()
        .then(call)
        .then(
          (value) => {
            listener[Symbol.dispose]();
            resolve({ ok: true, value });
          },
          (error: unknown) => {
            listener[Symbol.dispose]();
            resolve({ ok: false, error });
          },
        );
    });
    if (outcome === null) {
      log.debug("The request has been aborted");
      throw abortError(signal.reason);
    }
    return outcome;
  }

  /** Set of methods with no request body */
  public static get unsupported_methods(): Set<string> {
    return new Set(BodyParser.#methods);
  }

  static readonly #methods: ReadonlySet<string> = new Set([
    "GET",
    "HEAD",
    "OPTIONS",
    "TRACE",
  ]);

  /** The bodies parsed by default */
  static readonly #defaults: readonly string[] = [
    "application/json",
    "+json",
    "text/plain",
    "application/x-www-form-urlencoded",
  ];
}

export default new BodyParser();
