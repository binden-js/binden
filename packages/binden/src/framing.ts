import { type OutgoingHttpHeader, OutgoingMessage } from "node:http";
import { trimOws } from "./headers/list.js";

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
 * The counter of the bytes of the body that Node.js has accepted, which
 * `strictContentLength` checks: its own symbol `kBytesWritten`, found once at
 * load on a message of its own (none on a version of Node.js without it).
 * Node.js counts a chunk before it commits the head, also when it refuses it.
 */
export const framingCounters: readonly symbol[] = Object.freeze(
  Object.getOwnPropertySymbols(new OutgoingMessage()).filter(
    (key) => key.description === "kBytesWritten",
  ),
);

/**
 * The framing state of a `BindenResponse` before an attempt to commit its
 * head (see `kSaveFraming`): its status and reason phrase, the values of
 * `framingFields` and of the byte counter of Node.js (see
 * `strictContentLength`), and its headers (their names in order and case, and
 * copies of their values). Its lifecycle, its listeners and the output it has
 * written are not part of it. For the packages of binden only.
 *
 * @internal
 */
export interface IFramingState {
  /** The status code of the response */
  readonly status: number;
  /** The reason phrase of the response */
  readonly reason: string | undefined;
  /**
   * The values of `framingFields` (by name) and of the byte counter of
   * Node.js (by its symbol)
   */
  readonly fields: readonly (readonly [string | symbol, unknown])[];
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

/**
 * Why the `Content-Length` values of a head are refused, `null` when they
 * are not: a list (e.g. `2, 3`, also `2, 2`, alone or as an element of an
 * array), which Node.js cannot read, even of members that agree; or
 * elements of an array (which Node.js sends a line of each of, and frames
 * the body by the last) that are not all one same length (each of digits
 * only), so that a recipient may read either of them (RFC 9110, section
 * 8.6). `BindenResponse` refuses them before anything is committed (see
 * `kValidateHead`), where Node.js would send them.
 */
export function lengthRefusal(value: unknown): string | null {
  const elements = (
    Array.isArray(value) ? value : typeof value === "undefined" ? [] : [value]
  ).map((element) => trimOws(String(element)));
  if (elements.some((element) => element.includes(","))) {
    return "Content-Length is a list";
  }
  const [first = ""] = elements;
  return elements.length > 1 &&
    !elements.every(
      (element) =>
        /^\d+$/u.test(element) &&
        Number.isSafeInteger(Number(element)) &&
        Number(element) === Number(first),
    )
    ? "Content-Length values disagree"
    : null;
}

/**
 * The length of the body that the `Content-Length` of a response (its value,
 * see `getHeader()`) declares, as Node.js reads it (the last element of an
 * array, which agrees with the others), `null` without a valid one: none for
 * an empty array, nor for values that `BindenResponse` refuses (see
 * `lengthRefusal()`). binden frames the body by it, and `@binden/compression`
 * decides by it. For the packages of binden only.
 *
 * @internal
 */
export function framingLength(
  value: OutgoingHttpHeader | undefined,
): number | null {
  if (lengthRefusal(value) !== null) {
    return null;
  }
  const length = Number(
    (Array.isArray(value) ? value.at(-1) : value) ?? Number.NaN,
  );
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}
