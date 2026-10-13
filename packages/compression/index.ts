import { Context, type IMiddlewareParams, Middleware } from "binden";
import { Writable, pipeline } from "node:stream";
import { createBrotliCompress, createDeflate, createGzip } from "node:zlib";

export const DefaultCompression = "br";

export type IComressFormats = "auto" | "br" | "deflate" | "gzip";

export interface ICompressionOptions extends IMiddlewareParams {
  format?: IComressFormats;
}

type IWrite = (
  chunk: unknown,
  encoding?: BufferEncoding | ((error?: Error | null) => void),
  cb?: (error?: Error | null) => void,
) => boolean;

type IEnd = (
  chunk?: unknown,
  encoding?: BufferEncoding,
  cb?: () => void,
) => void;

export class Compression extends Middleware {
  readonly #format: IComressFormats;

  public constructor({ format = "auto", ...rest }: ICompressionOptions = {}) {
    super(rest);
    this.#format = format;
  }

  public get format(): IComressFormats {
    return this.#format;
  }

  public run(context: Context): void {
    const { response } = context;

    if (this.format === "auto") {
      Compression.#varyOnAcceptEncoding(response);
    }

    const format = Compression.#getFormat(context, this.format);

    if (format === "identity" || response.headersSent) {
      return;
    }

    const compress =
      format === "br"
        ? createBrotliCompress()
        : format === "deflate"
          ? createDeflate()
          : createGzip();

    // `write`/`end` are replaced on the response itself, so that every writer
    // (the following middlewares, `sendFile`, the error handler) goes through
    // the compressor; several compressions chain their replaced methods.
    const write = response.write.bind(response) as IWrite;
    const end = response.end.bind(response) as IEnd;

    // Compression starts with the first body chunk. A `Content-Length` of the
    // uncompressed body (e.g. from `sendFile`) is dropped. Nothing is compressed
    // when the headers have already been sent, nor for partial responses: their
    // ranges refer to the uncompressed body (RFC 9110, section 14.1.2).
    let active: boolean | null = null;
    let ended = false;
    const activate = (): boolean => {
      if (active === null) {
        active =
          !response.headersSent &&
          response.statusCode !== 206 &&
          !response.hasHeader("Content-Range");
        if (active) {
          const raw = response.getHeader("Content-Encoding");
          response.setHeader(
            "Content-Encoding",
            typeof raw === "undefined"
              ? format
              : [...(Array.isArray(raw) ? raw : [`${raw}`]), format],
          );
          response.removeHeader("Content-Length");
          // Backpressure in both directions: a compressed chunk is acknowledged
          // once the response has flushed it (so the compressor waits while the
          // response is full), and `drain` of the compressor is the `drain`
          // that writers of the response wait for. Errors of the chain and a
          // response closed early (client gone) end both sides.
          pipeline(
            compress.on("drain", () => response.emit("drain")),
            new Writable({
              write(chunk, _encoding, callback): void {
                write(chunk, () => {
                  callback();
                });
              },
              final(callback): void {
                end();
                callback();
              },
            }),
            (error) => {
              if (error) {
                response.destroy();
              }
            },
          );
          response.once("close", () => {
            compress.destroy();
          });
        }
      }
      return active;
    };

    response.write = ((
      chunk: unknown,
      encoding?: BufferEncoding,
      cb?: (error?: Error | null) => void,
    ): boolean => {
      if (activate()) {
        return compress.write(chunk, encoding as BufferEncoding, cb);
      }
      return write(chunk, encoding, cb);
    }) as typeof response.write;

    // As for an uncompressed response, `writableEnded` is set by `end()`, the
    // `end()` callback runs once the response has finished, and a second
    // `end()` does nothing.
    Object.defineProperty(response, "writableEnded", {
      configurable: true,
      get: () => ended,
    });

    response.end = ((...args: unknown[]): typeof response => {
      const callback = args.find((arg) => typeof arg === "function");
      if (typeof callback === "function") {
        response.once("finish", () => {
          (callback as () => void)();
        });
      }
      if (!ended) {
        ended = true;
        const [chunk, encoding] = args.filter(
          (arg) => typeof arg !== "function",
        ) as [unknown, BufferEncoding];
        if (activate()) {
          compress.end(chunk, encoding);
        } else {
          end(chunk, encoding);
        }
      }
      return response;
    }) as typeof response.end;
  }

  static #getFormat(
    context: Context,
    format: IComressFormats,
  ): Exclude<IComressFormats, "auto"> | "identity" {
    if (format !== "auto") {
      return format;
    }

    const { request } = context;

    // No `Accept-Encoding` means that any coding is acceptable
    if (typeof request.headers["accept-encoding"] === "undefined") {
      return DefaultCompression;
    }

    // The effective quality of a coding is its own `q` (`x-gzip` is `gzip`),
    // otherwise the one of `*`, otherwise 0 (not acceptable)
    const qualities = new Map<string, number>();
    for (const { encoding, q_value } of request.accept_encoding) {
      qualities.set(encoding === "x-gzip" ? "gzip" : encoding, q_value ?? 1);
    }
    const wildcard = qualities.get("*") ?? 0;
    const quality = (coding: string): number =>
      qualities.get(coding) ?? wildcard;

    // The best acceptable coding (on a tie, in the order of `#formats`)
    let best: Exclude<IComressFormats, "auto"> | null = null;
    for (const coding of Compression.#formats) {
      if (
        quality(coding) > 0 &&
        (best === null || quality(coding) > quality(best))
      ) {
        best = coding;
      }
    }

    // `identity` wins only when it is explicitly preferred. When no coding is
    // acceptable, the header is disregarded and the response is not encoded
    // (RFC 9110, section 12.5.3) instead of replying with 406.
    const identity = qualities.get("identity");
    if (
      best === null ||
      (typeof identity === "number" && identity > quality(best))
    ) {
      return "identity";
    }

    return best;
  }

  /** Response codings in the order of preference (the first one is the default) */
  static readonly #formats = [DefaultCompression, "gzip", "deflate"] as const;

  /** The response depends on `Accept-Encoding` (keeps the existing `Vary` values) */
  static #varyOnAcceptEncoding(response: Context["response"]): void {
    const raw = response.getHeader("Vary");
    const values = (
      Array.isArray(raw) ? raw : typeof raw === "undefined" ? [] : [`${raw}`]
    )
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter((value) => value !== "");

    if (
      !values.some((v) => v === "*" || v.toLowerCase() === "accept-encoding")
    ) {
      response.setHeader("Vary", [...values, "Accept-Encoding"].join(", "));
    }
  }
}

export default new Compression();
