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
): IListener {
  if (typeof listener !== "function") {
    // Refused by Node.js as it is
    return listener;
  }
  const run = (receiver: unknown, args: unknown[]): unknown =>
    as(owner, () => Reflect.apply(listener, receiver, args));
  const bound = once === null ? wrap(run) : wrapOnce(run, once);
  Object.assign(bound, { listener });
  bindings.set(bound, { owner, kind, listener, once: once !== null });
  return bound;
}

/** How a listener has been bound (`undefined` for one that has not been) */
export function bindingOf(raw: unknown): IBinding | undefined {
  return bindings.get(raw as IListener);
}
