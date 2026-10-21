import { carrierOf, formatStack, readsSafely } from "./exchange.js";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

/** A listener of an event of a stream-like source (see `IStreamLike`) */
export type IStreamLikeListener = (...args: unknown[]) => unknown;

/**
 * What `send()` calls on a stream-like source (see `IStreamLike`): its
 * events, and its flow for the backpressure
 */
export interface IStreamLikeSource {
  /** Adds a listener of its `data`, `end`, `error` or `close` */
  on(event: string, listener: IStreamLikeListener): unknown;
  /** Stops its `data` while the response is full */
  pause(): unknown;
  /** Resumes its `data` */
  resume(): unknown;
  /**
   * Destroys it once the send is cancelled (e.g. at the deadline), with the
   * reason: without it, the source is paused instead
   */
  destroy?(error?: Error): unknown;
}

/** A stream-like source whose listeners are removed by `removeListener()` */
export interface IStreamLikeRemovable extends IStreamLikeSource {
  /** Removes a listener that `send()` has added */
  removeListener(event: string, listener: IStreamLikeListener): unknown;
}

/** A stream-like source whose listeners are removed by `off()` */
export interface IStreamLikeOff extends IStreamLikeSource {
  /** Removes a listener that `send()` has added */
  off(event: string, listener: IStreamLikeListener): unknown;
}

/**
 * A stream that is not a Node.js `Readable` (e.g. of `readable-stream`, or of
 * another realm), which `send()` reads as one: an object with `on()`,
 * `pause()`, `resume()`, and `removeListener()` or `off()`
 */
export type IStreamLike = IStreamLikeOff | IStreamLikeRemovable;

/** A method of an object, called with the object as its receiver */
type IMethod = (...args: unknown[]) => unknown;

/** The methods of a stream-like source, as they were when it was sent */
export interface IStreamLikeMethods {
  readonly on: IMethod;
  readonly pause: IMethod;
  readonly resume: IMethod;
  readonly remove: IMethod;
  readonly destroy: IMethod | null;
}

/**
 * How a late error of a source that is not sent, or no longer, is reported
 * (see `guard()`), or, with a `message` of its own, another failure that the
 * guard of the source logs (e.g. a removal of one of its listeners that
 * throws, see `removalFailure`), which is not a late error: a function that
 * holds neither the request nor the response, since a source may keep it as
 * long as it lives
 */
export type ISourceReport = (error: unknown, message?: string) => void;

/**
 * The message of a removal of a listener of a stream that throws, as binden
 * logs it for a Node.js `Readable` (see `BindenResponse`), also for one of
 * the listeners of a guard (see `guard()`), which is not a late error
 */
const removalFailure = "The removal of a listener of a stream has failed";

/**
 * How a response logs (`debug`) what code of a source has thrown while it is
 * released (see `IStreamLikeLogs`). For the packages of binden only.
 *
 * @internal
 */
export type IStreamLikeLog = (error: unknown) => void;

/**
 * How code of a stream-like source that throws while `send()` releases it is
 * logged (see `readStreamLike()`, `releaseStreamLike()`), as for a Node.js
 * `Readable`: by the response, never by a listener left on the source. For
 * the packages of binden only.
 *
 * @internal
 */
export interface IStreamLikeLogs {
  /** Its guard refused (see `guard()`), or a `pause()` or a `destroy()` that throws */
  readonly released: IStreamLikeLog;
  /** A removal of a listener that throws (its `removeListener()` or `off()`) */
  readonly removed: IStreamLikeLog;
}

/** The logs of a release (see `IStreamLikeLogs`) by the report of a late error */
function logsOf(report: ISourceReport): IStreamLikeLogs {
  return { released: report, removed: report };
}

/** A method of an object (`null` when it is not a function) */
function methodOf(value: object, name: string): IMethod | null {
  const method: unknown = Reflect.get(value, name);
  return typeof method === "function" ? (method as IMethod) : null;
}

/**
 * The methods of a stream-like source (see `IStreamLike`), read once: `null`
 * for an object that is not one. Nothing of it is called.
 */
export function streamLikeOf(value: object): IStreamLikeMethods | null {
  const on = methodOf(value, "on");
  const pause = methodOf(value, "pause");
  const resume = methodOf(value, "resume");
  const remove = methodOf(value, "removeListener") ?? methodOf(value, "off");
  if (on === null || pause === null || resume === null || remove === null) {
    return null;
  }
  return { on, pause, resume, remove, destroy: methodOf(value, "destroy") };
}

/**
 * Whether a stream-like source has emitted its `end`: `readableEnded`, or
 * the state of a stream that has no such property (e.g. of `readable-stream`
 * 2 and 3)
 */
function hasEnded(source: object): boolean {
  const state = Reflect.get(source, "_readableState") as
    { readonly endEmitted?: unknown } | null | undefined;
  return (
    Reflect.get(source, "readableEnded") === true || state?.endEmitted === true
  );
}

/**
 * Whether a stream-like source has been destroyed: `destroyed`, or
 * `_destroyed` (of `through2` 2, whose `destroy()` sets only that)
 */
function isDestroyed(source: object): boolean {
  return (
    Reflect.get(source, "destroyed") === true ||
    Reflect.get(source, "_destroyed") === true
  );
}

/**
 * Whether a source has emitted its `close`: `closeEmitted` of its state
 * (e.g. of a Node.js `Readable`, or of `readable-stream` 4, but not 2 nor 3,
 * whose state does not tell), for its guard (see `guard()`)
 *
 * @internal
 */
export function hasClosed(source: object): boolean {
  try {
    const state = Reflect.get(source, "_readableState") as
      { readonly closeEmitted?: unknown } | null | undefined;
    return state?.closeEmitted === true;
  } catch {
    // Its state cannot be read (e.g. a getter of its own that throws): its
    // guard waits for its `close`
    return false;
  }
}

/**
 * The error of a stream-like source that has failed before its end:
 * `errored`, or the one of its state (e.g. of `readable-stream` 4, also
 * once it has errored without being destroyed, with `autoDestroy: false`),
 * `null` for none (nor for a falsy value, which Node.js drops as an error)
 */
function erroredOf(source: object): unknown {
  const state = Reflect.get(source, "_readableState") as
    { readonly errored?: unknown } | null | undefined;
  const errored: unknown = Reflect.get(source, "errored") ?? state?.errored;
  const failed = Boolean(errored);
  return failed ? errored : null;
}

/** The listener of `error` of the guard of each source (see `guard()`) */
const guards = new WeakMap<object, (error: unknown) => void>();

/**
 * How many sends listen to the `error` of each source: an error that one of
 * them hears fails it, and is not reported by the guard of the source too
 * (see `guard()`)
 */
const hearing = new WeakMap<object, number>();

/**
 * Counts a send that listens to the `error` of a source (`1`), or no longer
 * (`-1`): while one does, its guard (see `guard()`) and the detached
 * listeners of other sends (see `forwarder()`) do not report an error of it,
 * which fails that send. For the packages of binden only.
 *
 * @internal
 */
export function hear(source: object, change: 1 | -1): void {
  const count = (hearing.get(source) ?? 0) + change;
  if (count > 0) {
    hearing.set(source, count);
  } else {
    hearing.delete(source);
  }
}

/**
 * The errors that sends have failed with, and destroyed their sources with
 * (see `decided()`): no guard reports them again
 */
const decisions = new WeakSet<object>();

/**
 * Records an error of binden that has decided a send (e.g. a body longer
 * than its `Content-Length`), which the send destroys its source with once
 * it has settled: no guard (see `guard()`) reports it when the source emits
 * it (nor when a stream-like source read through it does). Only an object
 * can be recorded: any other value (e.g. a string that a `resume()` of the
 * source has thrown) is not, and is reported once the source emits it. For
 * the packages of binden only.
 *
 * @internal
 */
export function decided(error: unknown): void {
  if (Object(error) === error) {
    decisions.add(error as object);
  }
}

/**
 * An error of binden for a stream-like source (see `readStreamLike()`), once
 * it is created: decided for every source (see `decided()`), as the other
 * errors of binden that decide a send (e.g. a body longer than its
 * `Content-Length`), so that no guard reports it, whatever stream emits it
 * (e.g. another one that the application destroys with the error that the
 * send has rejected with), and returned
 */
function own<T extends Error>(error: T): T {
  decided(error);
  return error;
}

/**
 * The error of a chunk of a stream-like source that a response cannot send:
 * neither a string nor bytes (e.g. `null`, which would end the readable), an
 * error of binden (see `own()`), its stack formatted before anything has it
 * (see `formatStack()`)
 */
function invalidChunk(chunk: unknown): TypeError {
  const received = chunk === null ? "null" : typeof chunk;
  const message = `The chunk of a stream-like source must be a string or bytes (received ${received})`;
  return own(
    Object.assign(formatStack(new TypeError(message)), {
      code: "ERR_INVALID_ARG_TYPE",
    }),
  );
}

/**
 * The error of a close before the end, an error of binden (see `own()`), its
 * stack formatted (see `formatStack()`)
 */
function premature(): Error {
  return own(
    Object.assign(formatStack(new Error("Premature close")), {
      code: "ERR_STREAM_PREMATURE_CLOSE",
    }),
  );
}

/**
 * The values of stream-like sources that each readable of `readStreamLike()`
 * has been destroyed for, by the carriers that it has been destroyed with in
 * their place (see `carry()`): only the errors of that readable are taken for
 * them (see `uncarried()`), never a carrier that another stream emits (e.g.
 * one that the application has kept from the `destroy()` of a source)
 */
const carriers = new WeakMap<object, WeakMap<object, unknown>>();

/** The carriers of a readable that has none (see `carriers`) */
const uncarrying = new WeakMap<object, unknown>();

/**
 * The carrier of a value of a stream-like source (see `carrierOf()`: an
 * error of binden, decided as by `own()`, with a stack that Node.js reads as
 * it is, also when a `prepareStackTrace` of the application fails), which a
 * readable of `readStreamLike()` is destroyed with in its place: recorded for
 * that readable only, whose send takes it for that value (see `uncarried()`)
 */
function carry(readable: object, value: unknown): Error {
  const carrier = carrierOf(value);
  const values = carriers.get(readable) ?? new WeakMap<object, unknown>();
  carriers.set(readable, values.set(carrier, value));
  return carrier;
}

/**
 * What a readable of `readStreamLike()` is destroyed with for a value of its
 * source (an error that it emits, or what its code throws), as the send of a
 * Node.js `Readable` destroys its source (see `readsSafely()`): the value
 * itself only when Node.js reads its `stack` without running code of the
 * application, otherwise its carrier, for that readable (see `carry()`)
 */
function safely(readable: object, value: unknown): unknown {
  return readsSafely(value) ? value : carry(readable, value);
}

/**
 * The value that an error of a readable of `readStreamLike()` stands for: the
 * value of its source that a carrier of that readable carries (see
 * `carry()`), which the send rejects with (and decides, see `decidedFor()`),
 * as the send of a Node.js `Readable` does, or else the error itself (also a
 * carrier of another readable, which another stream emits: e.g. one that the
 * application has kept from the `destroy()` of a source, which is the value
 * of that stream). For the packages of binden only.
 *
 * @internal
 */
export function uncarried(error: unknown, readable: object): unknown {
  const values = carriers.get(readable) ?? uncarrying;
  const carrier = error as object;
  return values.has(carrier) ? values.get(carrier) : error;
}

/**
 * The sources that each late error has been reported for (see
 * `reportOnce()`), whatever has reported it: the guard of the source (see
 * `guard()`), its send (see `reportLate()`), or the listener of `error` of a
 * send once it is detached (see `forwarder()`). Also the sources whose sends
 * an error that they have emitted has decided (see `decidedFor()`)
 */
const reports = new WeakMap<object, WeakSet<object>>();

/**
 * The stream-like source that each readable of `readStreamLike()` reads: a
 * late error reported for the readable (e.g. by its send, see `reportLate()`)
 * is recorded for the source (see `reportOnce()`), so that its guard does not
 * report it again
 */
const links = new WeakMap<object, object>();

/** The readables of `readStreamLike()` whose sends have resolved (see `resolved()`) */
const resolutions = new WeakSet<object>();

/**
 * Tells a readable of a stream-like source (see `readStreamLike()`) that its
 * send has resolved, or settles without a failure (e.g. its body is complete
 * for the client, or another writer has ended the response): released then,
 * its source is destroyed without an error, as a Node.js `Readable` is, never
 * with the reason of a cancellation (see `readStreamLike()`), which the
 * listeners of `error` of the application, and its `errored`, would take for
 * a failure. A readable destroyed with an error destroys its source with that
 * error all the same. For the packages of binden only.
 *
 * @internal
 */
export function resolved(readable: object): void {
  resolutions.add(readable);
}

/**
 * Records an error (an object) for a source, or for the stream-like source of
 * a readable of `readStreamLike()` (see `links`): it is not reported for it
 * (see `reportOnce()`)
 */
function record(source: object, failure: object): void {
  const reported = links.get(source) ?? source;
  const sources = reports.get(failure) ?? new WeakSet<object>();
  reports.set(failure, sources.add(reported));
}

/**
 * Records an error that a source has emitted, and that has decided its send
 * (e.g. heard while the source is read): it is not reported for that source
 * (nor for a readable of a stream-like source that reads it, see `links`),
 * as if it had been already (see `reportOnce()`), but it still is for any
 * other source (e.g. one error of the application that it destroys each of
 * its streams with), unlike an error of binden (see `decided()`). Only an
 * object can be recorded, as by `decided()`. For the packages of binden
 * only.
 *
 * @internal
 */
export function decidedFor(source: object, error: unknown): void {
  if (Object(error) === error) {
    record(source, error as object);
  }
}

/**
 * The errors that the sends of each source decide meanwhile (see
 * `decide()`), each with how many of its decisions are pending: an inner
 * decision with the same error (e.g. of a send of the source that its code
 * starts meanwhile) that ends first leaves the outer one pending
 */
const pending = new WeakMap<object, Map<unknown, number>>();

/**
 * Runs `call` while a send of a source decides `error` (e.g. the error that
 * a destroyed source rejects it with), and returns what it returns: until
 * `call` returns or throws, no guard (see `guard()`) nor any other report of
 * a late error (see `reportOnce()`) reports that error for the source (nor
 * for a readable of a stream-like source that reads it, see `links`), nor
 * logs it as a refusal (see `refuse()`), whatever code of the source runs
 * (e.g. a listener of its `newListener` that emits it, or throws it, while
 * its guard is installed). Decisions nest: each is counted, so that an inner
 * one with the same error (e.g. of a send of the same source that its code
 * starts meanwhile) that ends first leaves the outer one pending. Only an
 * object is known as decided (see `isKnown()`): any other value (e.g. a
 * string) is reported, and logged. For the packages of binden only.
 *
 * @internal
 */
export function decide<T>(source: object, error: unknown, call: () => T): T {
  const decider = links.get(source) ?? source;
  const counts = pending.get(decider) ?? new Map<unknown, number>();
  pending.set(decider, counts.set(error, (counts.get(error) ?? 0) + 1));
  try {
    return call();
  } finally {
    const count = (counts.get(error) as number) - 1;
    if (count > 0) {
      counts.set(error, count);
    } else {
      counts.delete(error);
    }
    if (counts.size === 0) {
      pending.delete(decider);
    }
  }
}

/**
 * Whether an error of a source (or of a readable of a stream-like source, see
 * `links`) is known, and therefore not reported (see `reportOnce()`), nor
 * logged as a refusal (see `refuse()`): it has decided a send (see
 * `decided()`, or `decidedFor()` for that source), a send of the source
 * decides it meanwhile (see `decide()`), or it has been reported for that
 * source already. Only an object can be known: any other value (e.g. a
 * string) is not.
 */
function isKnown(source: object, error: unknown): boolean {
  if (Object(error) !== error) {
    return false;
  }
  const failure = error as object;
  const reported = links.get(source) ?? source;
  return (
    decisions.has(failure) ||
    pending.get(reported)?.has(failure) === true ||
    reports.get(failure)?.has(reported) === true
  );
}

/**
 * A log that never throws (see `IStreamLikeLogs`): a logger of the
 * application that throws (e.g. its own `debug()`) leaves no release of a
 * stream-like source half done (e.g. the readable of `readStreamLike()`
 * without the error that decides its send, or listeners left on the source),
 * and throws neither into the events of the source nor out of a turn of its
 * own. Nothing more can be told then.
 */
function quietly<T extends unknown[]>(
  log: (...args: T) => void,
): (...args: T) => void {
  return (...args: T): void => {
    try {
      log(...args);
    } catch {
      // The logger has failed: nothing more can be told
    }
  };
}

/**
 * Reports a late error of a source (see `ISourceReport`) once, on a later
 * turn (every report of a late error, whatever makes it: the guard of the
 * source, see `guard()`, the listener of a send once it is detached, see
 * `forwarder()`, or its send, see `reportLate()`), never an error that is
 * known for it (see `isKnown()`): one that has decided a send, one that a
 * send of it decides meanwhile, or one that has been reported for that source
 * already (e.g. by its send, before the source emits it to its guard), also
 * for a readable of a stream-like source (see `links`). Known when it is
 * brought, it is dropped at once; else it is checked again on that turn,
 * once the event that has brought it has reached every listener of the
 * source, and so has what they schedule within the turn (e.g. the `error` of
 * a readable of `readStreamLike()` that it destroys, which reaches its send
 * on the next tick), whichever listens first, or emits it again meanwhile: a
 * send of the source that it has decided since has recorded it then, and it
 * is dropped. Only an object can be recorded, as by `decided()`: any other
 * value (e.g. a string) is reported each time. Until then, it holds the
 * source, the error and the report (see `ISourceReport`), nothing else; a
 * report that throws (e.g. a logger of the application whose own `debug()`
 * throws) is ignored (see `quietly()`), never thrown out of its turn.
 */
function reportOnce(
  source: object,
  error: unknown,
  report: ISourceReport,
): void {
  if (isKnown(source, error)) {
    return;
  }
  setImmediate(() => {
    if (isKnown(source, error)) {
      return;
    } else if (Object(error) === error) {
      record(source, error as object);
    }
    quietly(report)(error);
  });
}

/**
 * Reports a late error of a source (see `ISourceReport`) that its send no
 * longer fails with (e.g. once the response has been ended, see
 * `BindenResponse.#pipe()`): on a later turn, once, whatever reports it (also
 * the guard of the source, which does not while a send hears it, see
 * `hear()`), and never once it has decided a send, also meanwhile (see
 * `reportOnce()`). For the packages of binden only.
 *
 * @internal
 */
export function reportLate(
  source: object,
  error: unknown,
  report: ISourceReport,
): void {
  reportOnce(source, error, report);
}

/**
 * How a guard (see `guard()`) adds its listeners to a source, and removes
 * them: by the methods of the source (see `IStreamLikeMethods`), or by
 * `emitterMethods`
 *
 * @internal
 */
export type IGuardMethods = Pick<IStreamLikeMethods, "on" | "remove">;

/**
 * The methods of Node.js that add and remove the listeners of an emitter
 * (`EventEmitter.prototype.on()` and `removeListener()`), for a guard (see
 * `guard()`) of a source whose own methods are not read (e.g. a Node.js
 * `Readable`, whose own `on` may be a getter)
 *
 * @internal
 */
export const emitterMethods: IGuardMethods = Object.freeze({
  on: Reflect.get(EventEmitter.prototype, "on") as IMethod,
  remove: Reflect.get(EventEmitter.prototype, "removeListener") as IMethod,
});

/**
 * The sources that have refused the listener of `error` of their guard (see
 * `guard()`): they are not asked again, so that the refusal is reported once
 */
const refusals = new WeakSet<object>();

/**
 * Gives `refused` what the code of a source has thrown while its guard is
 * installed (see `guard()`), unless it is an object that is known for the
 * source (see `isKnown()`): an error that has decided a send, or that a send
 * of the source decides meanwhile, which is not reported again. Any other
 * value (e.g. a string) is given each time. A function of the module, so
 * that no listener of the guard holds `refused` (it may hold the response)
 */
function refuse(
  source: object,
  refused: (error: unknown) => void,
  error: unknown,
): void {
  if (!isKnown(source, error)) {
    refused(error);
  }
}

/**
 * Removes the listener of `error` of a guard that is not installed (see
 * `guard()`): what the code of the source throws is given to `refused`
 */
function unguard(
  source: object,
  remove: IMethod,
  failed: (error: unknown) => void,
  refused: (error: unknown) => void,
): void {
  try {
    Reflect.apply(remove, source, ["error", failed]);
  } catch (error: unknown) {
    refuse(source, refused, error);
  }
}

/**
 * Removes a listener of the guard of a source that has closed (see
 * `guard()`): a removal that throws is logged as such by the report, which
 * holds only the logger (see `ISourceReport`, `removalFailure`), never as a
 * late error, and nothing is thrown out of the turn of the guard (also when
 * the logger throws, see `quietly()`)
 */
function leave(
  source: object,
  remove: IMethod,
  event: string,
  listener: (...args: never[]) => void,
  report: ISourceReport,
): void {
  try {
    Reflect.apply(remove, source, [event, listener]);
  } catch (error: unknown) {
    quietly(report)(error, removalFailure);
  }
}

/**
 * Keeps a late `error` of a source that is not sent, or no longer (released,
 * cancelled, or destroyed by the application), from crashing the process
 * without a listener of the application: its `destroy()` (or its `pause()`) may
 * fail asynchronously, at any time. Installed before the source is paused or
 * destroyed, and before a send removes its own listener of `error`. A guard of
 * its own reports it (see `ISourceReport`), but not an error that a send hears
 * (which fails the send), nor one that a send has failed with and destroyed it
 * with (see `decided()`, `decidedFor()`), nor one that a send of the source
 * decides meanwhile (see `decide()`), nor one that has been reported for the
 * source already (see `reportOnce()`), and holds nothing else (never the
 * response, nor the send), so that it may stay on a source that never emits
 * anything: it is never removed by a timer, only on the turn after the `close`
 * of a source whose state tells that it has closed (see `hasClosed()`, e.g. a
 * Node.js `Readable`, or of `readable-stream` 4), or after it is installed for
 * such a source that has emitted its `close` already (`closed`). A source whose
 * state cannot tell it (e.g. of `readable-stream` 2 or 3, of `through2`, or an
 * emitter of its own) keeps its guard as long as it lives: such a source may
 * emit an error after its `close` (e.g. of a write once binden has destroyed
 * it, or of a second destroy), each reported once. When it leaves, each of
 * its listeners is removed on its own: a removal that throws is logged as such
 * by the report (see `leave()`), never as a late error. One guard per source,
 * however many sends release it. For the packages of binden only.
 *
 * Returns whether its listener of `error` is in place, and only then is the
 * source guarded: a source that refuses it (its `on()` throws, e.g. by a
 * listener of its `newListener`) is not, and is not asked again, so that
 * the caller keeps a listener of its own (see `forwarder()`), or does not
 * release it. What the code of the source throws (also for the listener of
 * `close`, without which the guard stays) is given to `refused` (`report` by
 * default), never thrown, unless it is an object known for the source (see
 * `isKnown()`: e.g. an error that has decided a send, or that a send of the
 * source decides meanwhile, see `decide()`), which is not reported again.
 *
 * @internal
 */
export function guard(
  source: object,
  { on, remove }: IGuardMethods,
  report: ISourceReport,
  closed = false,
  refused: (error: unknown) => void = report,
): boolean {
  if (guards.has(source)) {
    return true;
  } else if (refusals.has(source)) {
    return false;
  }
  const failed = (error: unknown): void => {
    if (!hearing.has(source)) {
      // Once, whatever reports it (see `reportOnce()`)
      reportOnce(source, error, report);
    }
  };
  const close = (): void => {
    setImmediate(() => {
      // Once (e.g. not for a second `close`), and only once its state tells
      // that it has closed: a source that cannot tell it (e.g. of
      // `readable-stream` 2 or 3, or an emitter of its own) may still emit
      // an error after its `close` (e.g. of a write once it is destroyed, or
      // of a second destroy), and keeps its guard
      if (guards.get(source) === failed && hasClosed(source)) {
        guards.delete(source);
        // Each on its own: a removal that throws (e.g. by a listener of its
        // `removeListener`) leaves the other one to be removed
        leave(source, remove, "error", failed, report);
        leave(source, remove, "close", close, report);
      }
    });
  };
  // `refused` is never held by its listeners (it may hold the response)
  try {
    Reflect.apply(on, source, ["error", failed]);
  } catch (error: unknown) {
    refusals.add(source);
    refuse(source, refused, error);
    // A throwing `on()` of its own may have added it
    unguard(source, remove, failed, refused);
    return false;
  }
  if (guards.has(source)) {
    // Guarded meanwhile (e.g. by a listener of its `newListener` that
    // releases it): one guard per source
    unguard(source, remove, failed, refused);
    return true;
  }
  // Only once its listener of `error` is in place
  guards.set(source, failed);
  try {
    Reflect.apply(on, source, ["close", close]);
  } catch (error: unknown) {
    // It stays, holding nothing but the report
    refuse(source, refused, error);
    return true;
  }
  if (closed) {
    close();
  }
  return true;
}

/** A listener of `error` (see `IForwarder`) */
export type IErrorListener = (error: unknown) => void;

/**
 * The listener of `error` that a send adds to its source, which forwards
 * each error to a target: the send while it listens (`target`), then, once
 * it has settled (see `detach()`), the report of a late error, so that a
 * listener kept on a source that refuses its guard (see `guard()`), or that
 * a removal that throws leaves, holds nothing of the send (a function of
 * its own scope). For the packages of binden only.
 *
 * @internal
 */
export interface IForwarder {
  /** The listener of `error` that the send adds to the source */
  readonly listener: IErrorListener;
  /**
   * Forwards every later error to the report of a late error (see
   * `ISourceReport`) as a guard does (see `guard()`), but not one that the
   * guard of the source reports itself (it listens, and no send hears the
   * source, see `hear()`)
   */
  detach(source: object, report: ISourceReport): void;
}

/**
 * The listener of `error` of a send (see `IForwarder`), forwarded to
 * `target` until it is detached. For the packages of binden only.
 *
 * @internal
 */
export function forwarder(target: (error: unknown) => void): IForwarder {
  const forward = { target };
  return {
    listener: (error: unknown): void => {
      forward.target(error);
    },
    detach: (source: object, report: ISourceReport): void => {
      forward.target = (error: unknown): void => {
        // Unless its guard reports it (see `guard()`): not while a send
        // hears the source (e.g. the send of this listener, see `hear()`)
        if (!guards.has(source) || hearing.has(source)) {
          // Once, whatever reports it (see `reportOnce()`)
          reportOnce(source, error, report);
        }
      };
    },
  };
}

/**
 * Releases a stream-like source that is no longer read, by its `destroy()`
 * (with `args`) or its `pause()`: what it throws (e.g. a `pause()` once
 * more, after the one that has failed its send) is logged (see
 * `IStreamLikeLogs`), never thrown into the events of the source, nor in
 * place of the error that decides its send
 */
function releaseBy(
  source: object,
  method: IMethod,
  released: IStreamLikeLog,
  ...args: unknown[]
): void {
  try {
    Reflect.apply(method, source, args);
  } catch (error: unknown) {
    released(error);
  }
}

/**
 * Does nothing: the default of what tells that a stream-like source is left
 * untouched, since no listener of its `error` is in place (see
 * `releaseStreamLike()`)
 */
function unnoticed(): void {
  // Nobody to tell
}

/**
 * Releases a stream-like source that is not sent (e.g. to `HEAD`): it is
 * destroyed (without an error), or paused, and never read. A late error of
 * its destroy (or of its pause) is reported (see `guard()`). A source that
 * refuses its guard is left untouched: no listener of its `error` is in
 * place, without which an error of its destroy or of its pause (e.g. emitted
 * asynchronously) would crash the process, so that none of its code runs
 * (neither `destroy()` nor `pause()`), and `unreleased()` tells it: it is
 * the application's to release. Code of the source that throws meanwhile is
 * logged by `logs` (see `IStreamLikeLogs`).
 */
export function releaseStreamLike(
  source: object,
  methods: IStreamLikeMethods,
  report: ISourceReport,
  unreleased: () => void = unnoticed,
  logs: IStreamLikeLogs = logsOf(report),
): void {
  // Its guard listens before it is paused or destroyed
  if (!guard(source, methods, report, false, logs.released)) {
    // Untouched
    unreleased();
    return;
  }
  // Destroyed, or paused without `destroy()`: what it throws is logged, and
  // the send goes on (e.g. `HEAD` gets its reply)
  releaseBy(source, methods.destroy ?? methods.pause, logs.released);
}

/** A listener of an event of a stream-like source that `readStreamLike()` adds */
type IAdded = (...args: never[]) => void;

/**
 * A listener that the readable of a stream-like source adds to it (see
 * `readStreamLike()`), and what forgets its handler once it is removed (see
 * `relay()`)
 */
interface IRelay {
  /** The listener that the source has */
  readonly listener: IAdded;
  /** Forgets its handler: the listener does nothing from then on */
  drop(): void;
}

/**
 * A listener of a stream-like source that calls `handler` until it is
 * dropped (see `IRelay`), once the readable of `readStreamLike()` removes
 * it: one that a removal that throws (e.g. a `removeListener()` of the
 * source) leaves on the source then holds nothing of the readable, nor of its
 * send (a function of its own scope, as the hooks of the readable, see
 * `hooked()`). A Node.js `Readable` keeps such a listener of its own, which
 * is the application's.
 */
function relay(handler: IAdded): IRelay {
  const holder: { current: IAdded | null } = { current: handler };
  return {
    listener: (...args: never[]): void => {
      holder.current?.(...args);
    },
    drop: (): void => {
      holder.current = null;
    },
  };
}

/**
 * Forgets nothing: the listener of `error` of a send holds nothing of it once
 * it is detached (see `forwarder()`), and reports the later errors of a
 * source that a removal that throws leaves it on
 */
function forwarded(): void {
  // Nothing to forget
}

/** The hooks of a readable of `readStreamLike()` (see `hooked()`) */
interface IReadableHooks {
  /** Reads more of the source */
  read(): void;
  /** Releases the source once the readable is destroyed */
  destroy(error: Error | null, callback: (error?: Error | null) => void): void;
}

/**
 * A Node.js `Readable` that runs its hooks (`hooks.current`) until it is
 * destroyed, and forgets them then: once destroyed (Node.js neither reads it
 * nor destroys it again), it holds nothing of them, nor of what they hold
 * (e.g. the response that sends it, which the reason of its cancellation and
 * its logs hold), so that what keeps it (e.g. a pending report of a late
 * error of its source, see `reportOnce()`) keeps nothing of the response
 */
function hooked(hooks: { current: IReadableHooks | null }): Readable {
  return new Readable({
    read(): void {
      (hooks.current as IReadableHooks).read();
    },
    destroy(error, callback): void {
      const current = hooks.current as IReadableHooks;
      hooks.current = null;
      current.destroy(error, callback);
    },
  });
}

/**
 * A stream-like source (see `IStreamLike`) read as a Node.js `Readable`, which
 * `send()` sends as such. Its `data` is pushed with backpressure: the source is
 * paused once the readable is full (e.g. while the response is), and resumed
 * once it is read. A `data` that is neither a string nor bytes (e.g. `null`,
 * never taken as its end) destroys it with a `TypeError`
 * (`ERR_INVALID_ARG_TYPE`), and one that the readable cannot take (its `push()`
 * throws, e.g. for a view of an `ArrayBuffer` that has been detached) with what
 * it throws, never thrown into the `data` of the source. Its `end` ends the
 * readable, and its `error`, or a `close` before its end, destroys it with that
 * error (or `ERR_STREAM_PREMATURE_CLOSE`); a source that has failed without
 * being destroyed (e.g. without `autoDestroy`) is then released under its
 * guard, as for a cancellation, but without its error. An `end` or a `close` of
 * a source that has been destroyed (e.g. `readable-stream` 2 emits both before
 * the `error` of its `destroy()`) is not its end: the error that follows within
 * a turn destroys the readable, or else `ERR_STREAM_PREMATURE_CLOSE`. Destroyed
 * before (a cancellation: the deadline, the client gone away, another reply),
 * the readable destroys the source with the reason of the cancellation
 * (`reason()`, its stack formatted), recorded before as decided (see
 * `decided()`), so that its guard does not report it once the source emits it,
 * or pauses a source that cannot be destroyed; once its send has resolved (see
 * `resolved()`), the source is destroyed without an error, as a Node.js
 * `Readable` is. A destroy (or a pause) that throws is logged (see
 * `IStreamLikeLogs`), and the readable is destroyed with the error that decides
 * the send all the same. That error (an `error` of the source, or the one that
 * the readable is destroyed with) is pending before the guard of the source is
 * installed (see `decide()`): code of the source that emits it, or throws it
 * again, meanwhile (e.g. a listener of its `newListener`) is neither reported
 * nor logged when it is an object.
 *
 * Every listener that it adds is removed through the source (by its
 * `removeListener()` or `off()`): at once for a cancellation, whatever the
 * source emits then, and once the source has ended, failed or closed, but the
 * one of `error` on the next turn (which an error emitted after the end or the
 * close would otherwise crash the process without a listener of the
 * application, and is reported as a late error). A removal that throws is
 * logged by `logs` (see `IStreamLikeLogs`), and the listener that it leaves
 * holds nothing of the send (see `relay()`, `forwarder()`). A source that has
 * ended already is an empty body, one destroyed before its end closes the
 * readable at once (with its error, its `errored`, without being destroyed
 * again), and one that has failed without being destroyed (its `errored`, e.g.
 * of `readable-stream` 4 with `autoDestroy: false`) destroys it at once with
 * that error, and is released with it: none of them is listened to. Such an
 * error is decided by the send (see `BindenResponse.#unreadable()`), which
 * rejects with it, or reports it once (also for the source, see `reportOnce()`)
 * when the response has ended meanwhile (e.g. by code of the source): no guard
 * reports it meanwhile (e.g. emitted at once by the destroy of the source, or
 * thrown again by its code while the guard is installed). The guard of a source
 * (see `guard()`) listens before the listeners of the send are removed, and
 * reports a later error of one that has ended (whose destroy, e.g. by
 * `autoDestroy`, may fail after the end), failed or closed, that it cancels
 * (also without `destroy()`), or that the application has destroyed (before the
 * send, or by an `end` or a `close` once destroyed, whose destroy may fail
 * after the turn that decides the send).
 *
 * Code of the source that throws while its listeners are added (its own `on()`,
 * e.g. by a listener of its `newListener`), or in its `pause()`, gives a
 * readable destroyed with what it has thrown (a falsy value, which Node.js
 * drops as an error, as a premature close, with which the source is destroyed,
 * decided), and releases the source as for a cancellation, with it. The
 * readable is destroyed once, with a value of the source (its error, or what
 * its code has thrown) only when Node.js reads its `stack` without running code
 * of the application, otherwise with its carrier, an `Error` whose `cause` it
 * is (see `safely()`, e.g. for a `stack` getter, which may return a string once
 * and throw then, or a `prepareStackTrace` of the application that throws), and
 * so is the source then: the send takes the carrier for the value (see
 * `uncarried()`), as the send of a Node.js `Readable` rejects with it, whatever
 * it destroys its source with. A source that refuses the listener of `error` of
 * its guard keeps the one of the send (see `forwarder()`), and is destroyed
 * without the error that decides the send; one that has neither is left
 * untouched (see `releaseStreamLike()`): `unreleased()` tells it. A refusal of
 * its guard, a `pause()` that throws once it is no longer read, and a removal
 * that throws are logged by `logs` (see `IStreamLikeLogs`), not as late errors.
 * A log that throws (also `unreleased()`, e.g. a logger of the application
 * whose own `debug()` throws) is ignored, and the release goes on (see
 * `quietly()`). Once destroyed, the readable holds none of them, nor `reason()`
 * (see `hooked()`).
 */
export function readStreamLike(
  source: object,
  methods: IStreamLikeMethods,
  reason: () => Error,
  report: ISourceReport,
  unreleased: () => void = unnoticed,
  logs: IStreamLikeLogs = logsOf(report),
): Readable {
  // What tells of its release never throws (see `quietly()`), also from its
  // destroy (see `destroy`), which then calls back all the same
  const released = quietly(logs.released);
  const removed = quietly(logs.removed);
  const untouched = quietly(unreleased);
  /**
   * The listeners added to the source, by event, recorded before its `on()`
   * runs (which may add one, then throw): each through a relay (see
   * `relay()`), dropped once it is removed, but the one of `error` (see
   * `forwarder()`)
   */
  const listeners = new Map<string, IRelay>();
  /** Whether the source has ended, failed or closed (or is cancelled) */
  let settled = false;
  /** Whether it has emitted an `end` or a `close` once destroyed */
  let destroyed = false;
  /** Whether its guard listens (see `protect()`), once installed */
  let guarded: boolean | null = null;
  /**
   * Whether the listener of `error` of the send is in place: its `on()` has
   * returned, or it has heard an error
   */
  let listened = false;
  /** The listener of `error` of the send (see `detach()`) */
  const errors = forwarder((error: unknown) => {
    listened = true;
    // One decision, until the source that it fails is released: code of the
    // source that emits that error again meanwhile (e.g. its own destroy())
    // is not reported (see `decide()`), whatever reaches the send first
    decide(source, error, () => {
      // eslint-disable-next-line @typescript-eslint/no-use-before-define -- only once it is added, below
      fail(error);
      // Only while it is read: once the send has settled, this listener is
      // detached (see `detach()`)
      // eslint-disable-next-line @typescript-eslint/no-use-before-define -- only once it is added, below
      dropFailed();
    });
  });
  /**
   * Calls a method of the source. Every call into code of the source throws
   * nothing out of the adapter once it is read: its `on()` (see `listen`) and
   * what its getters throw before (`hasEnded()`, `isDestroyed()` and
   * `erroredOf()`, before anything is added) reject the send, its `pause()`
   * (see its `data`) and its `resume()` (see `read`) destroy the readable
   * (see `destroyWith()`), the getters of its state that it reads afterwards
   * are caught (see `destroyedOnce()`, `dropFailed()`, `hasClosed()`), and
   * what its removals, its release and its guard throw is logged (see
   * `release()`, `releaseBy()`, `guard()`)
   */
  const call = (method: IMethod, ...args: unknown[]): void => {
    Reflect.apply(method, source, args);
  };
  const listen = (event: string, handler: IAdded): void => {
    if (settled) {
      // E.g. by an `error` that its `on()` has emitted at once
      return;
    }
    const added =
      event === "error"
        ? { listener: handler, drop: forwarded }
        : relay(handler);
    listeners.set(event, added);
    if (event === "error") {
      // Until it is removed (see `release()`)
      hear(source, 1);
    }
    call(methods.on, event, added.listener);
    if (event === "error") {
      listened = true;
    }
  };
  /** Removes the listeners of these events that the source still has */
  const release = (...names: readonly string[]): void => {
    for (const event of names) {
      const added = listeners.get(event);
      if (typeof added !== "undefined") {
        listeners.delete(event);
        // Also when its removal throws, and leaves it on the source
        added.drop();
        try {
          call(methods.remove, event, added.listener);
        } catch (error: unknown) {
          // Never thrown into the events of the source, nor out of a turn of
          // its own: once the send has settled, its listeners change nothing
          removed(error);
        } finally {
          if (event === "error") {
            // The send no longer hears it, also when the removal has thrown
            // (before or after it has removed the listener): a listener left
            // is detached (see `detach()`), and reports a later error itself
            // only when its guard does not (see `forwarder()`)
            hear(source, -1);
          }
        }
      }
    }
  };
  /**
   * Installs the guard of the source once (see `guard()`): whether it
   * listens (`closed`: by its `close`)
   */
  const protect = (closed = false): boolean => {
    guarded ??= guard(source, methods, report, closed, released);
    return guarded;
  };
  /**
   * The send no longer listens to the source: its listener of `error` no
   * longer fails it (see `forwarder()`), before the guard of the source is
   * installed, whose `on()` runs code of the source that may emit an error
   * (e.g. a listener of its `newListener`), reported once as a late error,
   * never by the settled send. That listener is kept when no guard listens
   * (`closed`: by its `close`): whether it is.
   */
  const detach = (closed = false): boolean => {
    errors.detach(source, report);
    const kept = !protect(closed) && listened;
    if (kept) {
      // Never removed (it holds nothing of the send): it reports a late
      // error itself, heard as long as it listens (see `hear()`)
      listeners.delete("error");
    }
    return kept;
  };
  /**
   * Removes every listener but the one of `error`, which is removed on the
   * next turn (see above), unless it is kept. Its guard listens before
   * (`closed`: by its `close`, see `guard()`), unless it has already, once
   * destroyed (see `stopped()`): its destroy may still fail (e.g. by
   * `autoDestroy` once it has ended).
   */
  const settle = (closed = false): void => {
    settled = true;
    detach(closed);
    release("data", "end", "close");
    setImmediate(() => {
      release("error");
    });
  };
  // Once destroyed, it holds nothing of the send (see `hooked()`)
  const readable = hooked({
    current: {
      // Reads more of the source: it flows again (never once it has settled:
      // the readable has ended or is destroyed)
      read: (): void => {
        try {
          call(methods.resume);
        } catch (error: unknown) {
          // Its own `resume()` (the first one, or once the readable has room
          // again): as its `pause()`, never thrown out of `read()` of
          // Node.js, which would destroy the readable with it as it is
          // eslint-disable-next-line @typescript-eslint/no-use-before-define -- only once it is read, below
          destroyWith(error);
        }
      },
      // Destroyed before the source has settled: it is cancelled, and its
      // own cleanup ends at once (the destroy of the source may emit nothing)
      destroy: (error, callback): void => {
        if (!settled) {
          settled = true;
          // The error that it is destroyed with decides the send (for a
          // carrier, the value that it carries, see `uncarried()`): pending
          // before its guard is installed, and while it is released, so that
          // its code that emits it or throws it meanwhile (e.g. a listener of
          // its `newListener`, or its destroy) is not reported (see `decide()`)
          decide(source, uncarried(error, readable), () => {
            // Its guard listens before its listeners are removed, and before
            // it is paused or destroyed, once the listener of `error` of the
            // send no longer fails it (see `detach()`)
            const kept = detach();
            const safe = protect();
            release("data", "end", "close", "error");
            const { destroy, pause } = methods;
            if (!safe && !kept) {
              // No listener of its `error` is in place: untouched (see
              // `releaseStreamLike()`)
              untouched();
            } else if (destroy === null) {
              releaseBy(source, pause, released);
            } else if (destroyed) {
              // By the application: not again
            } else if (kept) {
              // Only the listener of the send hears it: without the error that
              // decides the send, which the send has failed with already
              releaseBy(source, destroy, released);
            } else if (error !== null) {
              // The error that decides the send, as the readable has it (never
              // a value whose `stack` Node.js cannot read safely, but its
              // carrier, see `destroyWith()`): e.g. what a `pause()` of the
              // source has thrown, of a chunk that the readable cannot take,
              // or the error of a source that has failed before (see
              // `unreadable()`). Pending while it is released (see above), a
              // value of the application is decided for the source only once
              // the send rejects with it (see `decidedFor()`, by the send),
              // and is otherwise a late error (e.g. displaced by a
              // cancellation of the send, or once the response has ended),
              // reported once. An error of binden (e.g. of a chunk that is not
              // bytes, or a carrier) is decided for every source already (see
              // `own()`)
              releaseBy(source, destroy, released, error);
            } else if (resolutions.has(readable)) {
              // Its send has resolved (see `resolved()`): without an error, as
              // a Node.js `Readable` is, never with the reason of a
              // cancellation
              releaseBy(source, destroy, released);
            } else {
              // The reason of its cancellation (also for a falsy value that its
              // code has thrown, a premature close), an error of binden: no
              // guard reports it once the source emits it (see `decided()`).
              // Formatted before the source has it, which may keep it
              const failure = formatStack(reason());
              decided(failure);
              releaseBy(source, destroy, released, failure);
            }
          });
        }
        // With the error that decides the send, never one of its release
        callback(error);
      },
    },
  });
  // Its late errors are the ones of the source (see `reportOnce()`)
  links.set(readable, source);
  /**
   * Destroys the readable with an error of the source, or with what its code
   * has thrown, by one call of its `destroy()`: with that value itself only
   * when Node.js reads its `stack` (once before the readable is destroyed,
   * and again once `destroy` has called back) without running code of the
   * application, otherwise with its carrier (see `safely()`), which the send
   * takes for that value, so that the readable is destroyed in any case,
   * emits its `error` and its `close`, and releases the source (see
   * `destroy`) with that same value
   */
  const destroyWith = (error: unknown): void => {
    readable.destroy(safely(readable, error) as Error);
  };
  /**
   * Fails the readable with an error of the source (`closed`: by its
   * `close`), which decides the send before the guard of the source is
   * installed (see `settle()`): code of the source that emits it or throws it
   * meanwhile (e.g. a listener of its `newListener`) is not reported (see
   * `decide()`)
   */
  const fail = (error: unknown, closed = false): void => {
    decide(source, error, () => {
      settle(closed);
      destroyWith(error);
    });
  };
  /**
   * Releases a source that has failed (its `error`) while it was read,
   * without being destroyed (e.g. of `readable-stream` 4 with `autoDestroy:
   * false`), so that what it holds is freed, as for a cancellation (see
   * `destroy`), but without its error, which it has emitted already: under
   * its guard, or else the listener of `error` of the send, which has heard
   * it, and is kept (see `detach()`). That error is still pending (see
   * `errors`): a destroy of its own that emits it again is not reported.
   */
  const dropFailed = (): void => {
    try {
      if (destroyed || isDestroyed(source)) {
        // By itself (e.g. by `autoDestroy`), or by the application
        return;
      }
    } catch (error: unknown) {
      // Its state cannot be read (e.g. a getter of its own that throws)
      released(error);
      return;
    }
    releaseBy(source, methods.destroy ?? methods.pause, released);
  };
  /**
   * A readable that nothing is read into, destroyed at once with `error`
   * (see `BindenResponse.#unreadable()`), which the send rejects with, and
   * decides (see `decided()`), or reports once, as a late error, when the
   * response has ended (e.g. by code of the source that the send runs),
   * recorded for the source (see `links`): its guard never reports it, as if
   * a send heard it. The source is released with it, unless it has settled
   * (e.g. destroyed already, see `destroy`).
   */
  const unreadable = (error: unknown): Readable => {
    // Meanwhile, its guard does not report it, whatever reports it (e.g. a
    // refusal of the listener of its `close`, or its destroy)
    decide(source, error, () => {
      hear(readable, 1);
      destroyWith(error);
    });
    return readable;
  };
  /**
   * An `end` or a `close` of a source that has been destroyed, which is not
   * its end: the error of its destroy, which may follow, fails the readable,
   * or a premature close on the next turn (which changes nothing once the
   * readable is destroyed). Its destroy may fail later: its guard listens
   * before the listener of `error` of the send is removed (`closed`: by its
   * `close`).
   */
  const stopped = (closed: boolean): void => {
    if (!destroyed) {
      destroyed = true;
      protect(closed);
      release("data", "end", "close");
      setImmediate(() => {
        fail(premature());
      });
    }
  };
  /**
   * Whether the source has been destroyed (see `isDestroyed()`) once it has
   * ended or closed (`closed`): `null` when its code throws (e.g. a getter of
   * its own `destroyed`), which destroys the readable (see `destroyWith()`),
   * and releases the source, as for a cancellation, with what it has thrown,
   * under its guard (`closed`: by its `close`), never thrown into its events.
   * That value decides the send meanwhile (see `decide()`).
   */
  const destroyedOnce = (closed: boolean): boolean | null => {
    try {
      return isDestroyed(source);
    } catch (error: unknown) {
      decide(source, error, () => {
        protect(closed);
        destroyWith(error);
      });
      return null;
    }
  };
  if (hasEnded(source)) {
    // Its destroy may still fail (e.g. by `autoDestroy` once it has ended)
    settled = true;
    protect(hasClosed(source));
    readable.push(null);
    return readable;
  }
  if (isDestroyed(source)) {
    // Nothing more of it can be read (see `BindenResponse.#pipe()`), but its
    // destroy may still fail. Destroyed with an error (its `errored`), it
    // rejects with that error, as a Node.js `Readable` does, and is not
    // destroyed again
    settled = true;
    let failure: unknown = null;
    try {
      failure = erroredOf(source);
    } finally {
      // Read before its guard is installed, which the send decides
      // meanwhile (see `decide()`): its code that emits it or throws it then
      // (e.g. a listener of its `newListener`) is not reported. Its guard
      // listens also when its state cannot be read (e.g. a getter of its own
      // that throws), which the send rejects with
      decide(source, failure, () => protect(hasClosed(source)));
    }
    if (failure !== null) {
      return unreadable(failure);
    }
    readable.destroy();
    return readable;
  }
  const errored = erroredOf(source);
  if (errored !== null) {
    // Failed without being destroyed: nothing more of it can be read either,
    // and it is released with its error, as for a cancellation (see
    // `destroy`)
    return unreadable(errored);
  }
  try {
    listen("error", errors.listener);
    listen("close", () => {
      // Before its end (once it has ended, it is no longer listened to)
      const gone = destroyedOnce(true);
      if (gone === true) {
        stopped(true);
      } else if (gone === false) {
        fail(premature(), true);
      }
    });
    listen("end", () => {
      const gone = destroyedOnce(false);
      if (gone === true) {
        stopped(false);
      } else if (gone === false) {
        settle();
        readable.push(null);
      }
    });
    listen("data", (chunk: unknown) => {
      if (typeof chunk !== "string" && !ArrayBuffer.isView(chunk)) {
        // Never its end (`null`), nor dropped (`undefined`), as a `push()`
        // would take them: refused as any other value that is not bytes
        destroyWith(invalidChunk(chunk));
        return;
      }
      try {
        if (!readable.push(chunk)) {
          call(methods.pause);
        }
      } catch (error: unknown) {
        // A chunk that the readable cannot take (e.g. a view of an
        // `ArrayBuffer` that has been detached), or code of the source that
        // throws: as for a cancellation, with it, never thrown into the
        // `data` of the source
        destroyWith(error);
      }
    });
  } catch (error: unknown) {
    // Code of the source (e.g. its own `on()`, or a listener of its
    // `newListener`): released as for a cancellation, with what it has
    // thrown (see `destroy`), whatever it has added removed
    return unreadable(error);
  }
  return readable;
}
