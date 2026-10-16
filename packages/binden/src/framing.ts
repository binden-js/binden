/**
 * The fields of Node.js that frame a response, which an attempt to commit
 * its head may change before Node.js refuses it (e.g. `_storeHeader()` has
 * decided to close the connection when it refuses a `Trailer` of a body that
 * is not chunked): its body (`_hasBody`, `_contentLength`, `chunkedEncoding`,
 * `useChunkedEncodingByDefault`, `strictContentLength`), its connection
 * (`_last`, `shouldKeepAlive`, `maxRequestsOnConnectionReached`,
 * `_defaultKeepAlive`, `_keepAliveTimeout`), its `Date` (`sendDate`), and the
 * headers that the application has removed (`_removedConnection`,
 * `_removedContLen`, `_removedTE`). For the packages of binden only.
 *
 * @internal
 */
export const framingFields: readonly string[] = Object.freeze([
  "_contentLength",
  "_defaultKeepAlive",
  "_hasBody",
  "_keepAliveTimeout",
  "_last",
  "_removedConnection",
  "_removedContLen",
  "_removedTE",
  "chunkedEncoding",
  "maxRequestsOnConnectionReached",
  "sendDate",
  "shouldKeepAlive",
  "strictContentLength",
  "useChunkedEncodingByDefault",
]);

/**
 * The framing state of a `BindenResponse` before an attempt to commit its
 * head (see `kSaveFraming`): its status and reason phrase, the values of
 * `framingFields`, and its headers (their names in order and case, and copies
 * of their values). Its lifecycle, its listeners and the output it has
 * written are not part of it. For the packages of binden only.
 *
 * @internal
 */
export interface IFramingState {
  /** The status code of the response */
  readonly status: number;
  /** The reason phrase of the response */
  readonly reason: string | undefined;
  /** The values of `framingFields`, by name */
  readonly fields: readonly (readonly [string, unknown])[];
  /** The headers: their names (in order, with their case) and their values */
  readonly headers: readonly (readonly [string, number | string | string[]])[];
  /** The generation of the framing headers (see `BindenResponse`) */
  readonly generation: number;
}

/**
 * The key of the method of `BindenResponse` that saves its framing state:
 * `response[kSaveFraming]()` (see `IFramingState`). A library that commits the
 * head itself (e.g. `@binden/compression`) saves it before, and restores it
 * when Node.js refuses the head. For the packages of binden only.
 *
 * @internal
 */
export const kSaveFraming: unique symbol = Symbol("binden.saveFraming");

/**
 * The key of the method of `BindenResponse` that restores a framing state
 * saved by `kSaveFraming`: `response[kRestoreFraming](state)` sets its
 * headers, then its fields (removing a header sets some of them), its status
 * and its reason phrase, with the rights of the framework. For the packages of
 * binden only.
 *
 * @internal
 */
export const kRestoreFraming: unique symbol = Symbol("binden.restoreFraming");
