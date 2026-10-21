import { described, formatting, objectOf } from "../formatting.js";
import { checkFieldValue } from "./list.js";
import { formatStack } from "../exchange.js";

/** The known content codings */
export type IEncodings =
  "br" | "compress" | "deflate" | "gzip" | "x-gzip" | "zstd";

/** A coding of `Content-Encoding` */
export interface IContentEncoding {
  /** A known content coding, in lowercase */
  encoding: IEncodings;
}

/** A coding of the `Content-Encoding` header (RFC 9110, section 8.4) */
export class ContentEncoding implements IContentEncoding {
  readonly #encoding: IEncodings;

  /**
   * A known content coding (in lowercase), or a `TypeError` (the coding
   * described without converting it, see `described()`), also for an init
   * that is not an object. What reading it throws (e.g. a revoked proxy) is
   * formatted (see `formatting()`).
   */
  public constructor(init: IContentEncoding) {
    const encoding = formatting(
      () => (objectOf(init, "init") as IContentEncoding).encoding,
    );
    if (!ContentEncoding.#encodings.has(encoding)) {
      throw formatStack(
        new TypeError(`Unknown content coding: ${described(encoding)}`),
      );
    }
    this.#encoding = encoding;
  }

  /** The content coding */
  public get encoding(): IEncodings {
    return this.#encoding;
  }

  /** The coding as in the header */
  public toString(): string {
    return this.#encoding;
  }

  /**
   * The codings in the order to remove them (the last applied first), or `null`
   * when one of them is unknown or malformed: the content cannot be decoded
   * then (RFC 9110, section 8.4). An input that is neither a string nor
   * `undefined` throws a `TypeError`.
   */
  public static fromString(input?: string): ContentEncoding[] | null {
    checkFieldValue(input);
    if (typeof input === "undefined") {
      return [];
    }

    // Codings are case-insensitive, empty list elements are ignored (RFC 9110,
    // sections 8.4.1 and 5.6.1)
    const codings = input
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e !== "");

    if (!codings.every((e) => ContentEncoding.#encodings.has(e))) {
      return null;
    }

    return (codings as IEncodings[])
      .map((encoding) => new ContentEncoding({ encoding }))
      .reverse();
  }

  static readonly #encodings: ReadonlySet<string> = new Set([
    "gzip",
    "x-gzip",
    "compress",
    "deflate",
    "br",
    "zstd",
  ]);
}

export default ContentEncoding;
