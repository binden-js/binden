import { Context, type IMiddlewareParams, Middleware } from "binden";
import { createBrotliCompress, createDeflate, createGzip } from "node:zlib";

export const DefaultCompression = "br";

export type IComressFormats = "auto" | "br" | "deflate" | "gzip";

export interface ICompressionOptions extends IMiddlewareParams {
  format?: IComressFormats;
}

export class Compression extends Middleware {
  readonly #format: IComressFormats;

  public constructor({ format = "auto", ...rest }: ICompressionOptions = {}) {
    super(rest);
    this.#format = format;
  }

  public get format(): IComressFormats {
    return this.#format;
  }

  public run(context: Context): Context {
    if (this.format === "auto") {
      Compression.#varyOnAcceptEncoding(context);
    }

    const format = Compression.#getFormat(context, this.format);

    if (format === "identity") {
      return context;
    }

    const { response } = context;

    const compress =
      format === "br"
        ? createBrotliCompress()
        : format === "deflate"
          ? createDeflate()
          : createGzip();

    // Compression starts with the first body chunk written through this middleware,
    // so responses written past it (e.g. by the error handler) stay unencoded, and
    // a `Content-Length` of the uncompressed body (e.g. from `sendFile`) is dropped.
    let active: boolean | null = null;
    const activate = (): boolean => {
      if (active === null) {
        active = !response.headersSent;
        if (active) {
          const raw = response.getHeader("Content-Encoding");
          response.setHeader(
            "Content-Encoding",
            typeof raw === "undefined"
              ? format
              : [...(Array.isArray(raw) ? raw : [`${raw}`]), format],
          );
          response.removeHeader("Content-Length");
          compress.pipe(response);
        }
      }
      return active;
    };

    const proxyResponse = new Proxy(response, {
      get(_r, p: string): unknown {
        if (p === "write") {
          return function write(
            data: unknown,
            encoding: BufferEncoding,
            cb?: (error?: Error | null) => void,
          ): void {
            if (activate()) {
              compress.write(data, encoding, cb);
            } else {
              response.write(data, encoding, cb);
            }
          };
        } else if (p === "end") {
          return function end(
            data: unknown,
            encoding: BufferEncoding,
            cb?: () => void,
          ): void {
            if (activate()) {
              compress.end(data, encoding, cb);
            } else {
              response.end(data, encoding, cb);
            }
          };
        }

        return (response as unknown as Record<string, unknown>)[p];
      },
    });

    return new Proxy(context, {
      get(_ct, p: string): unknown {
        if (p === "response") {
          return proxyResponse;
        }

        return (context as unknown as Record<string, unknown>)[p];
      },

      set(_ct, p: string, value: unknown): boolean {
        (context as unknown as Record<string, unknown>)[p] = value;
        return true;
      },
    });
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
  static #varyOnAcceptEncoding({ response }: Context): void {
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
