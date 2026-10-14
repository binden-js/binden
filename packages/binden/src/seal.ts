/**
 * The key of the internal method that seals a response against late sends
 * (e.g. of a middleware once its deadline has passed): `response[kSeal](late)`
 * makes the sending methods resolve without writing anything while `late()`
 * returns `true` (always without it). Not part of the public API.
 *
 * @internal
 */
export const kSeal: unique symbol = Symbol("binden.seal");
