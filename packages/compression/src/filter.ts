import type { ContentType, Context } from "binden";

/**
 * Decides whether a response is compressed, by its `Content-Type` (`null`
 * without a valid one): called synchronously, it must return a boolean
 */
export type ICompressionFilter = (
  context: Context,
  content_type: ContentType | null,
) => boolean;

/** The compressible media types that are neither `text/*` nor `+json`/`+xml` */
const types: ReadonlySet<string> = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/json",
  "application/vnd.ms-fontobject",
  "application/wasm",
  "application/x-javascript",
  "application/x-www-form-urlencoded",
  "application/xml",
  "font/otf",
  "font/ttf",
  "image/bmp",
  "image/vnd.microsoft.icon",
  "image/x-icon",
]);

/**
 * The default `filter` of the compression: whether a media type is worth
 * compressing. Text (`text/*`, but `text/event-stream`, whose events would
 * wait in the compressor), JSON and XML (also as `+json` and `+xml`, such as
 * `image/svg+xml`), JavaScript, WebAssembly and uncompressed fonts and
 * images are; a response without a valid `Content-Type` is not.
 */
export function isCompressible(content_type: ContentType | null): boolean {
  if (content_type === null) {
    return false;
  }
  const type = content_type.type.toLowerCase();
  if (type.startsWith("text/")) {
    return type !== "text/event-stream";
  }
  return type.endsWith("+json") || type.endsWith("+xml") || types.has(type);
}
