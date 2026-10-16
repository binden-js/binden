import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The owner of the current asynchronous work: the token of the work of a
 * request that has started it (its middleware stack, or a run of its error
 * handler, see `Exchange.token()`), `undefined` for a work of no request.
 * Not part of the public API.
 *
 * @internal
 */
export const owners = new AsyncLocalStorage<object>();

/**
 * The key of the internal method that seals a response:
 * `response[kSeal](allows)` lets only the owners that `allows(owner)` accepts
 * mutate it (none without it, or when it throws). Not part of the public API.
 *
 * @internal
 */
export const kSeal: unique symbol = Symbol("binden.seal");

/**
 * The key of the internal method that cancels the pending sends of a response
 * whose headers are not committed yet: `response[kCancel](reason)` (see
 * `BindenResponse`). Not part of the public API.
 *
 * @internal
 */
export const kCancel: unique symbol = Symbol("binden.cancel");

/**
 * The key of the internal method that runs a function of the framework with
 * the rights of the framework, whoever owns the response:
 * `response[kFramework](() => response.destroy())`. Not part of the public API.
 *
 * @internal
 */
export const kFramework: unique symbol = Symbol("binden.framework");

/**
 * The key of the internal method that adds an observer of an event of a
 * response for the framework (or a library of binden), which runs once by
 * default: `response[kListen](event, listener, { once })` returns what
 * removes it (see also `kUnlisten`). It is not a listener of the response,
 * which the application may remove (e.g. `removeAllListeners()`): it runs
 * from `emit()` after the listeners (also when one of them throws, which is
 * then thrown), never before the event (see `kRevoke`), as the work that has
 * added it (without the rights of the framework), with the response as its
 * receiver. An `error` that observers listen to is not thrown without a
 * listener. Not part of the public API.
 *
 * @internal
 */
export const kListen: unique symbol = Symbol("binden.listen");

/**
 * The key of the internal method that removes an observer that
 * `[kListen]()` has added (the last one of the listener):
 * `response[kUnlisten](event, listener)`. Not part of the public API.
 *
 * @internal
 */
export const kUnlisten: unique symbol = Symbol("binden.unlisten");

/**
 * The key of the internal method that fails a pipe of a work of the exchange
 * of a response, from the failure handler that the exchange has set for the
 * work (see `onPipeFailure()`): `response[kPipeFailure](owner, error,
 * source)`, `true` once the framework handles it (see `IOwnership.fail()`).
 * Not part of the public API.
 *
 * @internal
 */
export const kPipeFailure: unique symbol = Symbol("binden.pipe_failure");

/**
 * A failure of a pipe of a work (see `IOwnership.fail()`): the work that it
 * belongs to, and its error
 *
 * @internal
 */
export interface IPipeFailure {
  /** The work whose pipe has failed (its token) */
  readonly owner: object;
  /** The error of the pipe (e.g. of the write of its source) */
  readonly error: unknown;
}

/**
 * The key of the internal method that tells a response that works may no
 * longer mutate it: `response[kRevoke](owners, failure)`. At once, their
 * mutations are ignored; on the next tick, the `error` of the failure (to its
 * owner only) then `close` are delivered to the listeners that each work has
 * added to the response (and only to them: the response is closed for the
 * abandoned work), and its sources still piped are unpiped. Resolves once
 * delivered. Not part of the public API.
 *
 * @internal
 */
export const kRevoke: unique symbol = Symbol("binden.revoke");

/**
 * How the framework handles the works that own a response (see
 * `kOwnership`). Not part of the public API.
 *
 * @internal
 */
export interface IOwnership {
  /**
   * A pipe of a work into the response has failed (e.g. a write of its source
   * has thrown for a head that Node.js refuses): `true` once the framework
   * handles it, `false` for a work that it does not know (e.g. of no request),
   * which is left to Node.js. Called synchronously: the work loses its rights
   * at once (see `kRevoke`).
   */
  fail(owner: object, error: unknown): boolean;
  /**
   * Whether a source piped by the work fails it when it errors or closes
   * before its end (e.g. the work of an error handler, which Node.js would
   * leave waiting)
   */
  guards(owner: object): boolean;
  /**
   * The work that replies now (the token of the latest reply of the
   * framework, e.g. a run of the error handler), whose adopted pipe a
   * destroy of no work fails (see `BindenResponse.destroy()`): `null`
   * without one, or once the connection terminates (it has closed, or the
   * server shuts down)
   */
  replier(): object | null;
  /**
   * Whether a pipe of the work whose source has listener methods of its own
   * (e.g. bound by OpenTelemetry), which cannot be adopted, is left to
   * Node.js rather than refused: a work whose rights do not matter until it
   * is revoked (the stack), whose pipe is dismantled then, and the response
   * closed unless it has ended (see `BindenResponse`)
   */
  native(owner: object): boolean;
  /** Logs a failure that nothing else handles (e.g. of an abandoned work) */
  debug(message: string, error: unknown): void;
  /**
   * Logs a refused pipe of a work that it does not know (e.g. of no
   * request), with the reason: the response is left to its owner
   */
  warn(message: string, reason: string): void;
  /** Logs (at `debug`) what is done with a pipe, with the reason */
  note(message: string, reason: string): void;
}

/**
 * The key of the internal method that sets how the framework handles the
 * works that own a response: `response[kOwnership](ownership)`. Not part of
 * the public API.
 *
 * @internal
 */
export const kOwnership: unique symbol = Symbol("binden.ownership");

/**
 * The key of the method of `BindenResponse` that starts an operation of a
 * library that writes to the response (e.g. the compressor of
 * `@binden/compression`): see `IResponseOperation`. For the packages of
 * binden only.
 *
 * @internal
 */
export const kOperation: unique symbol = Symbol("binden.operation");

/**
 * An operation on a response (e.g. a compressor): it belongs to the owner of
 * the work that has started it, whose rights it keeps in its asynchronous
 * callbacks. For the packages of binden only.
 *
 * @internal
 */
export interface IResponseOperation {
  /** Whether the operation may still mutate the response */
  readonly active: boolean;
  /**
   * Runs a callback of the operation (e.g. of its stream) as its owner: the
   * response accepts its mutations as long as the operation is `active`
   */
  run<T>(fn: () => T): T;
  /**
   * The response has been ended by the operation: the transfer of what it has
   * accepted continues (through `run()`) even once its owner may no longer
   * mutate the response
   */
  transfer(): void;
}

/**
 * The key of the method of `BindenResponse` that checks the arguments of
 * `writeHead()` as Node.js does, without changing the response:
 * `response[kValidateHead](statusCode, reason, headers)` throws the error
 * that `writeHead()` would throw for the reason phrase that it would send (the
 * one given, or the one of the response) or for a header given, after it had
 * changed the response. A library that takes a decision at the commit of the
 * headers (e.g. `@binden/compression`) checks them first. For the packages of
 * binden only.
 *
 * @internal
 */
export const kValidateHead: unique symbol = Symbol("binden.validate_head");

/**
 * The key of the method of `BindenResponse` that chooses the representation
 * of the body of a response before the preconditions of the request are
 * evaluated: `response[kRepresentation](length)` (see `IRepresentation`),
 * called by `sendFile()` and by the dynamic `ETag` of `send()`. For the
 * packages of binden only.
 *
 * @internal
 */
export const kRepresentation: unique symbol = Symbol("binden.representation");

/**
 * The key of the method of `BindenResponse` that lets a library (e.g.
 * `@binden/compression`) choose the representation of the body of a
 * response: `response[kNegotiator](negotiator)` (see
 * `IRepresentationNegotiator`). For the packages of binden only.
 *
 * @internal
 */
export const kNegotiator: unique symbol = Symbol("binden.negotiator");

/**
 * The representation of the body of a response, as it will be sent. For the
 * packages of binden only.
 *
 * @internal
 */
export interface IRepresentation {
  /**
   * The content coding that a library applies to the body as it is sent
   * (e.g. `gzip`): its `ETag` is then weak, and it has no ranges. `null` when
   * the body is sent as it is.
   */
  readonly coding: string | null;
  /**
   * The status of the empty response that replaces the response (e.g. `406
   * Not Acceptable`), whatever its preconditions: `null` when it is sent
   */
  readonly status: number | null;
}

/**
 * How a library chooses the representation of the body of a response (see
 * `kNegotiator`). For the packages of binden only.
 *
 * @internal
 */
export interface IRepresentationNegotiator {
  /**
   * The representation of a body of `length` bytes (`null` when it is not
   * known), chosen before the headers are committed: the choice sends no
   * header and starts no coding, and the commit of the headers applies it
   */
  choose(length: number | null): IRepresentation;
  /**
   * The body that the representation has been chosen for is not sent (e.g.
   * its stream has failed before its first chunk): the commit of another
   * reply chooses by itself
   */
  forget(): void;
}

/**
 * The headers of a body (its framing, representation and validators), which
 * do not apply to a reply that replaces it: the error replies of binden, and
 * the empty replacements of a library (e.g. the `406` of
 * `@binden/compression`). For the packages of binden only.
 *
 * @internal
 */
export const bodyHeaders: readonly string[] = Object.freeze([
  "Content-Digest",
  "Content-Disposition",
  "Content-Encoding",
  "Content-Language",
  "Content-Length",
  "Content-Location",
  "Content-Range",
  "Content-Type",
  "Digest",
  "ETag",
  "Last-Modified",
  "Repr-Digest",
  // The trailers of a chunked body: Node.js refuses them for another body
  "Trailer",
  "Transfer-Encoding",
]);
