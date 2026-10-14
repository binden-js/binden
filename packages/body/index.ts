import { finished } from "node:stream";
import { createInflate, createGunzip, createBrotliDecompress } from "node:zlib";
import {
  BindenError,
  Middleware,
  type IMiddlewareParams,
  Context,
  ct_text,
  ct_json,
  ct_form,
} from "binden";

import type { Duplex, Readable } from "stream";

export type IBodyContentType = typeof ct_form | typeof ct_json | typeof ct_text;

export type IParse<T = unknown> = (input: string) => T | undefined;

export interface IBodyParserOptions<T = unknown> extends IMiddlewareParams {
  parse?: IParse<T>;
  /**
   * The largest body in bytes, once decoded (no limit by default): a larger
   * one is not read further, and gets a `413 Content Too Large`
   */
  limit?: number;
}

export class BodyParser<T = unknown> extends Middleware {
  readonly #parse: IParse<T>;
  readonly #limit: number | null;

  public constructor({ parse, limit, ...rest }: IBodyParserOptions = {}) {
    super(rest);
    if (typeof parse !== "undefined" && typeof parse !== "function") {
      throw new TypeError("`parse` is not a function");
    } else if (
      typeof limit !== "undefined" &&
      !(Number.isSafeInteger(limit) && limit >= 0)
    ) {
      throw new TypeError("`limit` is not a non-negative integer");
    }
    this.#parse = parse ?? JSON.parse;
    this.#limit = limit ?? null;
  }

  public async run(context: Context): Promise<void> {
    const { name: middleware } = BodyParser;
    const { request, log: logger } = context;
    const log = logger.child({ middleware });
    const { destroyed, method = "GET" } = request;

    if (BodyParser.#methods.has(method)) {
      log.debug("Unsupported method", { method });
      return;
    }

    if (destroyed) {
      log.debug("Skip parsing", { destroyed });
      return;
    }

    const { content_type, content_encoding } = request;

    const type = content_type?.type ?? null;

    if (type !== ct_json && type !== ct_text && type !== ct_form) {
      log.debug("Unsupported Content-Type", { content_type: type });
      return;
    }

    if (content_encoding === null) {
      // An unknown (or malformed) coding: the body cannot be decoded
      log.debug("Unsupported encoding");
      throw new BindenError(415);
    }

    // The text is decoded with its charset (UTF-8 by default)
    const charset = content_type?.charset ?? "utf-8";
    const decoder = ((): TextDecoder => {
      try {
        return new TextDecoder(charset);
      } catch (error: unknown) {
        log.debug("Unsupported charset", { charset });
        throw new BindenError(415, { cause: error as Error });
      }
    })();

    const streams: [string, Duplex][] = [];

    for (const { encoding } of content_encoding) {
      if (encoding === "gzip" || encoding === "x-gzip") {
        streams.push([encoding, createGunzip()]);
      } else if (encoding === "deflate") {
        streams.push([encoding, createInflate()]);
      } else if (encoding === "br") {
        streams.push([encoding, createBrotliDecompress()]);
      } else {
        log.debug("Unsupported encoding", { encoding });
        throw new BindenError(415);
      }
    }

    const body = await new Promise<string>((resolve, reject) => {
      let { request: stream } = context as { request: Readable };
      const source = stream;

      for (const [encoding, decompresser] of streams) {
        decompresser.once("error", (error) => {
          log.debug("Decoding failed", { error, encoding });
          reject(new BindenError(415, { cause: error }));
        });
        stream.pipe(decompresser);
        stream = decompresser;
      }

      // `pipe` does not forward an aborted request to the decoders: destroy them,
      // so that the last one finishes (with a premature close) and settles this promise
      finished(source, (error) => {
        if (error) {
          for (const [, decompresser] of streams) {
            decompresser.destroy();
          }
        }
      });

      const chunks: Buffer[] = [];
      let size = 0;
      const limit = this.#limit;

      stream.on("data", (data: Buffer) => {
        size += data.byteLength;
        if (limit === null || size <= limit) {
          chunks.push(data);
          return;
        }
        // Not read further (e.g. a small compressed body that would decode to
        // gigabytes): the connection is closed after the reply
        log.debug("The body is too large", { limit });
        source.unpipe();
        source.pause();
        stream.removeAllListeners("data");
        for (const [, decompresser] of streams) {
          decompresser.destroy();
        }
        context.setHeader("Connection", "close");
        reject(new BindenError(413));
      });

      finished(stream, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve(decoder.decode(Buffer.concat(chunks)));
        }
      });
    });

    try {
      request.body =
        type === ct_json
          ? this.#parse(body)
          : type === ct_form
            ? new URLSearchParams(body)
            : body;
    } catch (error: unknown) {
      log.debug("Request body does not match provided Content-Type", {
        error,
        type,
        body,
      });

      throw new BindenError(415, { cause: error as Error });
    }
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
}

export default new BodyParser();
