import { finished } from "node:stream";
import { createInflate, createGunzip, createBrotliDecompress } from "node:zlib";
import {
  BindenError,
  Middleware,
  IMiddlewareParams,
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
}

export class BodyParser<T = unknown> extends Middleware {
  readonly #parse: IParse<T>;

  public constructor({ parse, ...rest }: IBodyParserOptions = {}) {
    super(rest);
    if (typeof parse !== "undefined" && typeof parse !== "function") {
      throw new TypeError("`parse` is not a function");
    }
    this.#parse = parse ?? JSON.parse;
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

      for (const [encoding, decompresser] of streams) {
        decompresser.once("error", (error) => {
          log.debug("Decoding failed", { error, encoding });
          reject(new BindenError(415, { cause: error }));
        });
        stream.pipe(decompresser);
        stream = decompresser;
      }

      const chunks: Buffer[] = [];

      stream.on("data", (data: Buffer) => chunks.push(data));

      finished(stream, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve(Buffer.concat(chunks).toString());
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
