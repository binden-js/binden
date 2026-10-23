import type { BindenRequest } from "./request.js";
import type { BindenResponse } from "./response.js";
import type { Context } from "./context.js";

/**
 * The private brand of a class (`#field in value`), which its static block
 * gives: whether an object has been made by its constructor (or by the one of
 * a subclass). Telling it runs no trap of a proxy, and a proxy, an object of
 * another realm and one made with `Object.create()` of the prototype have
 * none.
 *
 * @internal
 */
export type IBrand = (value: object) => boolean;

// eslint-disable-next-line init-declarations -- set by the static block of `BindenRequest`
let request: IBrand;
// eslint-disable-next-line init-declarations -- set by the static block of `BindenResponse`
let response: IBrand;
// eslint-disable-next-line init-declarations -- set by the static block of `Context`
let context: IBrand;

/**
 * Sets the brand of the requests (see `isRequest()`), by the static block of
 * `BindenRequest`
 *
 * @internal
 */
export function brandRequests(brand: IBrand): void {
  request = brand;
}

/**
 * Sets the brand of the responses (see `isResponse()`), by the static block
 * of `BindenResponse`
 *
 * @internal
 */
export function brandResponses(brand: IBrand): void {
  response = brand;
}

/**
 * Sets the brand of the contexts (see `isContext()`), by the static block of
 * `Context`
 *
 * @internal
 */
export function brandContexts(brand: IBrand): void {
  context = brand;
}

/**
 * Whether a value is a request made by the constructor of `BindenRequest`
 * (or of a subclass), by its brand (see `IBrand`)
 *
 * @internal
 */
export function isRequest(value: unknown): value is BindenRequest {
  return typeof value === "object" && value !== null && request(value);
}

/**
 * Whether a value is a response made by the constructor of `BindenResponse`
 * (or of a subclass), by its brand (see `IBrand`)
 *
 * @internal
 */
export function isResponse(value: unknown): value is BindenResponse {
  return typeof value === "object" && value !== null && response(value);
}

/**
 * Whether a value is a context made by the constructor of `Context` (or of a
 * subclass), by its brand (see `IBrand`)
 *
 * @internal
 */
export function isContext(value: unknown): value is Context {
  return typeof value === "object" && value !== null && context(value);
}
