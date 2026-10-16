import { EventEmitter } from "node:events";
import { owners } from "./seal.js";

/** A listener of an event, or a callback (e.g. of `write()`) */
export type IListener = (...args: unknown[]) => unknown;

/**
 * Who has added a bound listener: the work of an application to a response
 * (`user`, which an abandoned work sees closed early, see `kRevoke`), the
 * framework or a library of binden to a response (`service`), a work to a
 * source piped into a response (`source`), or a callback (e.g. of `write()`)
 */
export type IKind = "callback" | "service" | "source" | "user";

/** A listener bound to the work that has added it (see `bind()`) */
export interface IBinding {
  /** The work that has added it (`undefined` for a work of no request) */
  readonly owner: object | undefined;
  readonly kind: IKind;
  /** The listener as it has been added */
  readonly listener: IListener;
  /** Whether it runs once (its wrapper is the one that `rawListeners()` has) */
  readonly once: boolean;
}

/** Removes a listener that has run once (see `bind()`) */
export interface IOnce {
  readonly emitter: EventEmitter;
  readonly event: string | symbol;
}

/** Runs a call of a bound listener (e.g. to catch what it throws) */
export type IAround = (call: () => unknown) => unknown;

const bindings = new WeakMap<IListener, IBinding>();

/** The objects that the framework mutates now, with its rights (see `force()`) */
interface IFrame {
  readonly target: object;
  readonly parent: IFrame | null;
}

let frame: IFrame | null = null;

/** Runs a function with the rights of the framework on `target` */
export function force<T>(target: object, fn: () => T): T {
  const previous = frame;
  frame = { target, parent: previous };
  try {
    return fn();
  } finally {
    frame = previous;
  }
}

/** Whether the framework mutates `target` now, with its rights (see `force()`) */
export function forced(target: object): boolean {
  for (let current = frame; current !== null; current = current.parent) {
    if (current.target === target) {
      return true;
    }
  }
  return false;
}

/**
 * Runs a function as the work of `owner` (`undefined` for a work of no
 * request), without the rights of the framework on any object
 */
export function as<T>(owner: object | undefined, fn: () => T): T {
  const previous = frame;
  frame = null;
  try {
    return typeof owner === "undefined"
      ? owners.exit(fn)
      : owners.run(owner, fn);
  } finally {
    frame = previous;
  }
}

/**
 * The name of the wrappers of `once()` of Node.js (e.g. `wrapper`), which
 * the wrappers of `bind()` have as well
 */
const onceName = ((): string => {
  const probe = new EventEmitter();
  probe.once("probe", () => null);
  return (probe.rawListeners("probe")[0] as IListener).name;
})();

/** A wrapper that runs with the receiver of its call (see `bind()`) */
function wrap(run: (receiver: unknown, args: unknown[]) => unknown): IListener {
  return function wrapper(this: unknown, ...args: unknown[]): unknown {
    return run(this, args);
  };
}

/**
 * A wrapper that removes itself from its emitter, then runs once with the
 * emitter as its receiver (see `bind()`)
 */
function wrapOnce(
  run: (receiver: unknown, args: unknown[]) => unknown,
  once: IOnce,
): IListener {
  let fired = false;
  function wrapper(...args: unknown[]): unknown {
    if (fired) {
      return null;
    }
    fired = true;
    once.emitter.removeListener(once.event, wrapper);
    return run(once.emitter, args);
  }
  Object.defineProperty(wrapper, "name", { value: onceName });
  return wrapper;
}

/**
 * A listener (or a callback) that runs as the work of `owner`, whose rights
 * it keeps (and only those: never the rights of the framework, which may emit
 * its event), with its arguments and the receiver that its emitter (or
 * Node.js) gives it. Its `listener` is the original, which `removeListener()`
 * and `listeners()` find. With `once`, it removes itself from its emitter
 * before it runs once, with the emitter as its receiver (as the wrapper of
 * `once()` of Node.js, whose name it has).
 */
export function bind(
  listener: IListener,
  owner: object | undefined,
  kind: IKind,
  once: IOnce | null,
  around: IAround | null = null,
): IListener {
  if (typeof listener !== "function") {
    // Refused by Node.js as it is
    return listener;
  }
  const run = (receiver: unknown, args: unknown[]): unknown => {
    const call = (): unknown => Reflect.apply(listener, receiver, args);
    return as(owner, around === null ? call : (): unknown => around(call));
  };
  const bound = once === null ? wrap(run) : wrapOnce(run, once);
  Object.assign(bound, { listener });
  bindings.set(bound, { owner, kind, listener, once: once !== null });
  return bound;
}

/** How a listener has been bound (`undefined` for one that has not been) */
export function bindingOf(raw: unknown): IBinding | undefined {
  return bindings.get(raw as IListener);
}

/**
 * What a work does when a listener that it has added to a piped source in
 * its window (see `openWindow()`) throws at its `end` (e.g. the `end()` of
 * `pipeline()` into a head that Node.js refuses): `true` once its pipe has
 * failed (see `onPipeFailure()`)
 */
export type IPipeFailureHandler = (
  error: unknown,
  source: EventEmitter,
) => boolean;

/** What issues the tokens of the works (an exchange, see `Exchange.token()`) */
export interface ITokenIssuer {
  /** Whether it has issued a token */
  issued(token: object): boolean;
}

/** The failure handler of a work, with the exchange that has set it */
interface IFailureRoute {
  readonly issuer: ITokenIssuer;
  readonly fail: IPipeFailureHandler;
}

/**
 * The failure handlers of the works, by their token: set once by the
 * exchange that has issued the token (with the response of that exchange),
 * never replaced (e.g. by a pipe of the work into the response of another
 * request, which does not know it)
 */
const failures = new WeakMap<object, IFailureRoute>();

/**
 * Sets what a pipe failure of a work does (see `IPipeFailureHandler`): once,
 * by the exchange that has issued its token (ignored otherwise)
 */
export function onPipeFailure(
  token: object,
  issuer: ITokenIssuer,
  fail: IPipeFailureHandler,
): void {
  if (!failures.has(token) && issuer.issued(token)) {
    failures.set(token, Object.freeze({ issuer, fail }));
  }
}

/**
 * The failure handler of a work, while the exchange that has set it has
 * issued its token (`null` without one, e.g. for a work of no request)
 */
function failureOf(owner: object | undefined): IPipeFailureHandler | null {
  if (typeof owner === "undefined") {
    return null;
  }
  const route = failures.get(owner);
  return route?.issuer.issued(owner) === true ? route.fail : null;
}

/**
 * The listener-adding methods of a source, patched while its window is open
 * (see `openWindow()`): by the method of its class that each calls, and
 * whether it adds a listener that runs once
 */
const adders = [
  ["on", "on", false],
  ["addListener", "addListener", false],
  ["once", "on", true],
  ["prependListener", "prependListener", false],
  ["prependOnceListener", "prependListener", true],
] as const;

/** The names of the listener-adding methods of a source (see `adders`) */
export const adderNames: readonly string[] = adders.map(([name]) => name);

/** The patches of a source whose window is open, and how many windows share them */
interface IWindow {
  count: number;
  readonly patches: ReadonlyMap<string, IListener>;
}

const windows = new WeakMap<object, IWindow>();

/**
 * Whether a method of a source is the patch of its open window (see
 * `openWindow()`): not a method that has been set on the source since
 */
export function isPatch(source: object, name: string): boolean {
  const patched = windows.get(source)?.patches.get(name);
  return (
    typeof patched !== "undefined" &&
    Object.getOwnPropertyDescriptor(source, name)?.value === patched
  );
}

/**
 * A patched listener-adding method of a source: it binds every listener to
 * the work that adds it, then adds it by the method of its class. What a
 * listener of `end` throws fails the pipe of that work, by the failure
 * handler of the work as it is when the listener is added (see
 * `failures`), whatever response has opened the window and whatever work
 * emits the event.
 */
function patch(inherited: string, once: boolean): IListener {
  return function patched(
    this: EventEmitter,
    event: unknown,
    listener: unknown,
  ): unknown {
    const owner = owners.getStore();
    const fail = event === "end" ? failureOf(owner) : null;
    const around: IAround | null =
      fail === null
        ? null
        : (call): unknown => {
            try {
              return call();
            } catch (error: unknown) {
              if (fail(error, this)) {
                return null;
              }
              throw error;
            }
          };
    const bound = bind(
      listener as IListener,
      owner,
      "source",
      once ? { emitter: this, event: event as string | symbol } : null,
      around,
    );
    const method = Reflect.get(
      Object.getPrototypeOf(this) as object,
      inherited,
    ) as IListener;
    return Reflect.apply(method, this, [event, bound]);
  };
}

/** Removes the patches of a source that are still its own methods */
function restore(
  source: object,
  patches: ReadonlyMap<string, IListener>,
): void {
  for (const [name, value] of patches) {
    if (Object.getOwnPropertyDescriptor(source, name)?.value === value) {
      Reflect.deleteProperty(source, name);
    }
  }
}

/** Closes a window of a source (see `openWindow()`) */
function closeWindow(source: EventEmitter, window: IWindow): void {
  window.count -= 1;
  if (window.count === 0) {
    windows.delete(source);
    restore(source, window.patches);
  }
}

/**
 * Opens the window of a source that is piped now: until the end of the
 * current turn (a `process.nextTick()` queued now), its listener-adding
 * methods bind every listener added to it to the work that adds it (e.g. the
 * `end` of `pipeline()`, or a listener of another work). Patched on the
 * source itself, never on a prototype; the windows of one source share the
 * patches, removed by the last one (unless replaced meanwhile). `false` when
 * the source cannot be patched (e.g. it is not extensible).
 */
export function openWindow(source: EventEmitter): boolean {
  let window = windows.get(source);
  if (typeof window === "undefined") {
    const patches = new Map<string, IListener>();
    for (const [name, inherited, once] of adders) {
      const value = patch(inherited, once);
      if (
        !Reflect.defineProperty(source, name, {
          configurable: true,
          writable: true,
          value,
        })
      ) {
        restore(source, patches);
        return false;
      }
      patches.set(name, value);
    }
    window = { count: 0, patches };
    windows.set(source, window);
  }
  window.count += 1;
  process.nextTick(closeWindow, source, window);
  return true;
}
