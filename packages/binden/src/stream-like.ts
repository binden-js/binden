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
 * (see `guard()`): a function that holds neither the request nor the
 * response, since a source may keep it as long as it lives
 */
export type ISourceReport = (error: unknown) => void;

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

/** The error of a close before the end */
function premature(): Error {
  return Object.assign(new Error("Premature close"), {
    code: "ERR_STREAM_PREMATURE_CLOSE",
  });
}

/** The listener of `error` of the guard of each source (see `guard()`) */
const guards = new WeakMap<object, (error: unknown) => void>();

/**
 * Keeps a late `error` of a source that is not sent, or no longer (released,
 * or cancelled), from crashing the process without a listener of the
 * application: its `destroy()` may fail asynchronously, at any time. A guard
 * of its own reports it (see `ISourceReport`), and holds nothing else (never
 * the response, nor the send), so that it may stay on a source that never
 * emits anything: it is never removed by a timer, only on the turn after the
 * `close` of the source (some sources emit their `error` after it, e.g.
 * `readable-stream` 2). One guard per source, however many sends release it.
 */
function guard(
  source: object,
  { on, remove }: IStreamLikeMethods,
  report: ISourceReport,
): void {
  if (guards.has(source)) {
    return;
  }
  const failed = (error: unknown): void => {
    report(error);
  };
  const close = (): void => {
    setImmediate(() => {
      // Once (e.g. not for a second `close`)
      if (guards.get(source) === failed) {
        guards.delete(source);
        try {
          Reflect.apply(remove, source, ["error", failed]);
          Reflect.apply(remove, source, ["close", close]);
        } catch (error: unknown) {
          // Never thrown out of a turn of its own
          report(error);
        }
      }
    });
  };
  guards.set(source, failed);
  Reflect.apply(on, source, ["error", failed]);
  Reflect.apply(on, source, ["close", close]);
}

/**
 * Releases a stream-like source that is not sent (e.g. to `HEAD`): it is
 * destroyed (without an error), or paused, and never read. A late error of
 * its destroy is reported (see `guard()`).
 */
export function releaseStreamLike(
  source: object,
  methods: IStreamLikeMethods,
  report: ISourceReport,
): void {
  const { destroy, pause } = methods;
  if (destroy === null) {
    Reflect.apply(pause, source, []);
  } else {
    guard(source, methods, report);
    Reflect.apply(destroy, source, []);
  }
}

/**
 * A stream-like source (see `IStreamLike`) read as a Node.js `Readable`, which
 * `send()` sends as such. Its `data` is pushed with backpressure: the source
 * is paused once the readable is full (e.g. while the response is), and
 * resumed once it is read. Its `end` ends the readable, and its `error`, or a
 * `close` before its end, destroys it with that error (or
 * `ERR_STREAM_PREMATURE_CLOSE`). An `end` or a `close` of a source that has
 * been destroyed (e.g. `readable-stream` 2 emits both before the `error` of
 * its `destroy()`) is not its end: the error that follows within a turn
 * destroys the readable, or else `ERR_STREAM_PREMATURE_CLOSE`. Destroyed
 * before (a cancellation: the deadline, the client gone away, another
 * reply), the readable destroys the source with the reason of the
 * cancellation (`reason()`), or pauses a source that cannot be destroyed.
 *
 * Every listener that it adds is removed through the source (by its
 * `removeListener()` or `off()`): at once for a cancellation, whatever the
 * source emits then (a late error of a destroyed source is reported by its
 * guard, see `guard()`), and once the source has ended, failed or closed,
 * but the one of `error` on the next turn (which an error emitted after the
 * end or the close would otherwise crash the process without a listener of
 * the application). A source that has ended already is an empty body, and
 * one destroyed before its end closes the readable at once: neither is
 * listened to.
 */
export function readStreamLike(
  source: object,
  methods: IStreamLikeMethods,
  reason: () => Error,
  report: ISourceReport,
): Readable {
  /** The listeners added to the source, by event */
  const listeners = new Map<string, (...args: never[]) => void>();
  /** Whether the source has ended, failed or closed (or is cancelled) */
  let settled = false;
  /** Whether it has emitted an `end` or a `close` once destroyed */
  let destroyed = false;
  const call = (method: IMethod, ...args: unknown[]): void => {
    Reflect.apply(method, source, args);
  };
  const listen = (
    event: string,
    listener: (...args: never[]) => void,
  ): void => {
    call(methods.on, event, listener);
    listeners.set(event, listener);
  };
  /** Removes the listeners of these events that the source still has */
  const release = (...names: readonly string[]): void => {
    for (const event of names) {
      const listener = listeners.get(event);
      if (typeof listener !== "undefined") {
        listeners.delete(event);
        call(methods.remove, event, listener);
      }
    }
  };
  /**
   * Removes every listener but the one of `error`, which is removed on the
   * next turn (see above)
   */
  const settle = (): void => {
    settled = true;
    release("data", "end", "close");
    setImmediate(() => {
      release("error");
    });
  };
  const readable = new Readable({
    // Reads more of the source: it flows again (never once it has settled:
    // the readable has ended or is destroyed)
    read: (): void => {
      call(methods.resume);
    },
    // Destroyed before the source has settled: it is cancelled, and its own
    // cleanup ends at once (the destroy of the source may emit nothing)
    destroy: (error, callback): void => {
      if (!settled) {
        settled = true;
        const { destroy, pause } = methods;
        if (destroy === null) {
          release("data", "end", "close", "error");
          call(pause);
        } else {
          // Its guard listens before its listeners are removed
          guard(source, methods, report);
          release("data", "end", "close", "error");
          if (!destroyed) {
            call(destroy, error ?? reason());
          }
        }
      }
      callback(error);
    },
  });
  /** Fails the readable with an error of the source */
  const fail = (error: Error): void => {
    settle();
    readable.destroy(error);
  };
  /**
   * An `end` or a `close` of a source that has been destroyed, which is not
   * its end: the error of its destroy, which may follow, fails the readable,
   * or a premature close on the next turn (which changes nothing once the
   * readable is destroyed)
   */
  const stopped = (): void => {
    if (!destroyed) {
      destroyed = true;
      release("data", "end", "close");
      setImmediate(() => {
        fail(premature());
      });
    }
  };
  if (hasEnded(source)) {
    settled = true;
    readable.push(null);
    return readable;
  } else if (isDestroyed(source)) {
    // Nothing more of it can be read (see `BindenResponse.#pipe()`)
    settled = true;
    readable.destroy();
    return readable;
  }
  listen("error", (error: Error) => {
    fail(error);
  });
  listen("close", () => {
    // Before its end (once it has ended, it is no longer listened to)
    if (isDestroyed(source)) {
      stopped();
    } else {
      fail(premature());
    }
  });
  listen("end", () => {
    if (isDestroyed(source)) {
      stopped();
    } else {
      settle();
      readable.push(null);
    }
  });
  listen("data", (chunk: unknown) => {
    if (!readable.push(chunk)) {
      call(methods.pause);
    }
  });
  return readable;
}
