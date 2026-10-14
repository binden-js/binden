import {
  type BindenRequest,
  type BindenResponse,
  ContentType,
  type Context,
  ct_text,
} from "binden";
import {
  type ICompressEncodings,
  type ICompressor,
  createCompressor,
} from "./codings.js";
import {
  type OutgoingHttpHeader,
  type OutgoingHttpHeaders,
  STATUS_CODES,
} from "node:http";
import type { ICompressionFilter } from "./filter.js";
import { negotiate } from "./negotiate.js";

/** The settings of a compression, validated */
export interface ISettings {
  readonly format: ICompressEncodings | "auto";
  readonly encodings: readonly ICompressEncodings[];
  readonly threshold: number;
  readonly filter: ICompressionFilter;
}

/**
 * What a response becomes once its headers are committed: sent as it is,
 * compressed, or replaced with an empty one (`406`, or `500` for a `filter`
 * that has failed)
 */
type IOutcome =
  | { readonly kind: "as_is" }
  | { readonly kind: "compress"; readonly coding: ICompressEncodings }
  | { readonly kind: "replace"; readonly status: 406 | 500 };

/**
 * Where the body goes: the decision is not taken yet (`pending`), to the
 * response as it is, to the compressor, or nowhere once the response has
 * been replaced
 */
type ISink = "as_is" | "compressor" | "discard" | "pending";

type IResponse = BindenResponse<BindenRequest>;

type ICallback = (error?: Error | null) => void;

const AS_IS: IOutcome = { kind: "as_is" };

/** The headers of a representation, which an empty replacement does not have */
const representation = [
  "Accept-Ranges",
  "Content-Disposition",
  "Content-Encoding",
  "Content-Language",
  "Content-Length",
  "Content-Location",
  "Content-Range",
  "Content-Type",
  "ETag",
  "Last-Modified",
  "Transfer-Encoding",
];

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

/** The size of a chunk of the body in bytes, or `null` when it is not one */
function sizeOf(chunk: unknown, encoding: unknown): number | null {
  if (typeof chunk === "string") {
    const coding =
      typeof encoding === "string" && Buffer.isEncoding(encoding)
        ? encoding
        : "utf8";
    return Buffer.byteLength(chunk, coding);
  } else if (chunk instanceof Uint8Array) {
    return chunk.byteLength;
  } else if (typeof chunk === "number" || typeof chunk === "bigint") {
    // As `send()` sends them
    return `${chunk}`.length;
  }
  return null;
}

/**
 * Sets the headers given to `writeHead()` as Node.js does once headers have
 * been set: an object sets them, a list (flat, or of pairs) replaces each of
 * its names with its values. `false` for a list that is not of pairs (which
 * Node.js rejects).
 */
function setGiven(
  response: IResponse,
  given: OutgoingHttpHeader[] | OutgoingHttpHeaders | undefined,
): boolean {
  if (Array.isArray(given)) {
    const flat: unknown[] = Array.isArray(given[0]) ? given.flat() : given;
    if (flat.length % 2 !== 0) {
      return false;
    }
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
  return true;
}

/** The result of a function, or `ok: false` once it throws */
function attempt<T>(fn: () => T): { ok: true; value: T } | { ok: false } {
  try {
    return { ok: true, value: fn() };
  } catch {
    return { ok: false };
  }
}

/** The error of a write after `end()` */
function writeAfterEnd(): Error {
  return Object.assign(new Error("write after end"), {
    code: "ERR_STREAM_WRITE_AFTER_END",
  });
}

/**
 * Leaves one response uncompressed: called before its headers are committed
 * (afterwards, it has no effect)
 */
export function skip(response: object): void {
  skipped.add(response);
}

/**
 * The compression of one response. Its methods are replaced on the response
 * itself, so that every writer (the following middlewares, `sendFile()`, the
 * error handler) goes through it, and the decision is taken once, when the
 * headers are committed: by `writeHead()`, `flushHeaders()`,
 * or the first `write()` or `end()`.
 */
export class CompressedResponse {
  readonly #context: Context;
  readonly #settings: ISettings;
  readonly #response: IResponse;
  // The methods that the compression replaces, as they were
  readonly #writeHead: IResponse["writeHead"];
  readonly #write: IResponse["write"];
  readonly #end: IResponse["end"];
  readonly #send: IResponse["send"];
  #sink: ISink = "pending";
  #compressor: ICompressor | null = null;
  /** Whether the application has ended a compressed response */
  #ended = false;
  /** The size of the body given to `send()`, which a `304` does not have */
  #hint: number | null = null;

  private constructor(context: Context, settings: ISettings) {
    const { response } = context;
    this.#context = context;
    this.#settings = settings;
    this.#response = response;
    this.#writeHead = response.writeHead.bind(response);
    this.#write = response.write.bind(response);
    this.#end = response.end.bind(response);
    this.#send = response.send.bind(response);
  }

  /**
   * Installs the compression on the response of a context, unless its headers
   * have been sent (it is then left as it is), or a compression is installed
   * on it already
   */
  public static install(context: Context, settings: ISettings): void {
    const { response } = context;
    if (response.headersSent || installed.has(response)) {
      return;
    }
    installed.add(response);
    new CompressedResponse(context, settings).#hook();
  }

  /** Replaces the methods of the response */
  #hook(): void {
    const response = this.#response;
    response.writeHead = (...args: unknown[]): IResponse =>
      this.#onWriteHead(args);
    response.write = ((...args: unknown[]): boolean =>
      this.#onWrite(args)) as IResponse["write"];
    response.end = ((...args: unknown[]): IResponse =>
      this.#onEnd(args)) as IResponse["end"];
    response.send = (...args: unknown[]): Promise<void> => {
      if (this.#sink === "pending") {
        this.#hint = sizeOf(args[0], args[1]);
      }
      return Reflect.apply(this.#send, response, args) as Promise<void>;
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
   * `writeHead()`: the headers it is given are set first (as Node.js does),
   * then the decision is taken, and the headers are committed
   */
  #onWriteHead(args: unknown[]): IResponse {
    const response = this.#response;
    const [code, reason, headers] = args;
    // As Node.js reads it
    const status = Number(code) | 0;
    const given = (
      typeof reason === "string" ? headers : (headers ?? reason)
    ) as OutgoingHttpHeader[] | OutgoingHttpHeaders | undefined;
    if (
      this.#sink !== "pending" ||
      response.headersSent ||
      status < 100 ||
      status > 999 ||
      !setGiven(response, given)
    ) {
      // Decided already, or rejected by Node.js
      return Reflect.apply(this.#writeHead, response, args) as IResponse;
    }
    response.statusCode = status;
    this.#apply(this.#decide(null));
    // Decided now (the type does not see it)
    if ((this.#sink as ISink) === "discard") {
      return response;
    }
    return typeof reason === "string"
      ? this.#writeHead(status, reason)
      : this.#writeHead(status);
  }

  /** `write()`: the decision is taken first, unless it has been */
  #onWrite(args: unknown[]): boolean {
    if (this.#sink === "pending") {
      this.#decideForBody(null);
    }
    const [chunk, second, third] = args;
    const callback = (typeof second === "function" ? second : third) as
      ICallback | undefined;
    if (this.#sink === "compressor") {
      const compressor = this.#compressor as ICompressor;
      if (this.#ended) {
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

  /** `end()`: the decision is taken first (with the size of its chunk), unless it has been */
  #onEnd(args: unknown[]): IResponse {
    const response = this.#response;
    const [first, second, third] = args;
    const chunk: unknown = typeof first === "function" ? null : first;
    const encoding = typeof second === "string" ? second : "utf8";
    const callback = [first, second, third].find(
      (arg) => typeof arg === "function",
    ) as ICallback | undefined;
    if (this.#sink === "pending") {
      // Without writes before it, its chunk is the body
      this.#decideForBody(
        chunk === null || typeof chunk === "undefined"
          ? 0
          : sizeOf(chunk, encoding),
      );
    }
    if (this.#sink === "compressor") {
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
      if (!this.#ended) {
        this.#ended = true;
        (this.#compressor as ICompressor).end(
          chunk,
          encoding as BufferEncoding,
        );
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
   * the whole body when `end()` writes it, `null` otherwise): a compressed
   * body commits the headers at once
   */
  #decideForBody(size: number | null): void {
    const response = this.#response;
    if (response.headersSent) {
      // Sent by another path: left as it is
      this.#sink = "as_is";
      return;
    }
    this.#apply(this.#decide(size));
    if (this.#sink === "compressor") {
      this.#writeHead(response.statusCode);
    }
  }

  /**
   * The decision, by the status and the headers of the response, the same
   * for `GET` and `HEAD`. A `304` gets the decision of the `200` that it
   * stands for: the same validators and `Vary`, without a body.
   */
  #decide(size: number | null): IOutcome {
    const { request } = this.#context;
    const response = this.#response;
    const status = response.statusCode;
    if (
      status < 200 ||
      status === 204 ||
      status === 205 ||
      // Ranges refer to the representation as it is (RFC 9110, section 14.1.2)
      status === 206 ||
      response.hasHeader("Content-Range")
    ) {
      return AS_IS;
    }
    const encoding = response.getHeader("Content-Encoding");
    if (typeof encoding !== "undefined") {
      if (!isIdentity(encoding)) {
        // Encoded already (e.g. a precompressed file)
        return AS_IS;
      }
      // Not a content coding (RFC 9110, section 8.4.1)
      response.removeHeader("Content-Encoding");
    }
    if (
      noTransform(response.getHeader("Cache-Control")) ||
      skipped.has(response)
    ) {
      return AS_IS;
    }

    const head = request.method === "HEAD";
    const length =
      lengthOf(response.getHeader("Content-Length")) ??
      (status === 304 ? this.#hint : head ? null : size);
    if (length === 0) {
      // No body
      return AS_IS;
    }
    const filtered = this.#filter();
    if (filtered === null) {
      return { kind: "replace", status: 500 };
    } else if (
      !filtered ||
      (length !== null && length < this.#settings.threshold)
    ) {
      return AS_IS;
    }

    const { format, encodings } = this.#settings;
    if (format !== "auto") {
      return { kind: "compress", coding: format };
    }
    response.vary("Accept-Encoding");
    const coding = negotiate(request.headers["accept-encoding"], encodings);
    if (coding === "identity") {
      return AS_IS;
    } else if (coding === false) {
      return { kind: "replace", status: 406 };
    }
    return { kind: "compress", coding };
  }

  /**
   * The result of the `filter`: `null` when it fails, or does not return a
   * boolean (a configuration error, logged)
   */
  #filter(): boolean | null {
    const context = this.#context;
    // `send()` sends a body as `text/plain` by default, but not with a `304`
    const raw =
      this.#response.getHeader("Content-Type") ??
      (this.#hint === null ? null : ct_text);
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
    } else if (outcome.kind === "compress") {
      // A `304` has no body, nor its encoding (a cache would update the
      // stored response with it)
      const bodiless = response.statusCode === 304;
      if (!bodiless) {
        response.setHeader("Content-Encoding", outcome.coding);
      }
      response.removeHeader("Content-Length");
      response.removeHeader("Accept-Ranges");
      // A strong validator of the uncompressed body does not validate the
      // compressed one (RFC 9110, section 8.8.3.3): it becomes weak
      const etag = response.getHeader("ETag");
      if (typeof etag === "string" && !etag.startsWith("W/")) {
        response.setHeader("ETag", `W/${etag}`);
      }
      if (!bodiless && this.#context.request.method !== "HEAD") {
        this.#compressor = this.#start(outcome.coding);
        this.#sink = "compressor";
        return;
      }
    }
    this.#sink = "as_is";
  }

  /**
   * Replaces the response with an empty one of the status, and sends it: the
   * writes of the application are then discarded
   */
  #replace(status: 406 | 500): void {
    const response = this.#response;
    for (const name of representation) {
      response.removeHeader(name);
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
   * early (the client has gone away), end both sides.
   */
  #start(coding: ICompressEncodings): ICompressor {
    const response = this.#response;
    const compressor = createCompressor(coding);
    compressor
      .on("data", (chunk: Buffer) => {
        const accepted = this.#write(chunk);
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
        response.destroy();
      })
      .once("end", () => {
        this.#end();
      });
    response.once("close", () => {
      // Its pending writes fail
      compressor.destroy();
    });
    return compressor;
  }
}
