import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The owner of the current asynchronous work: the reply of the framework that
 * has started it (see `Exchange.reply()`), `undefined` for any other work
 * (e.g. of the middlewares). Not part of the public API.
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
