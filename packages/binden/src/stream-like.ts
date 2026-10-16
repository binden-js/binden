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

/** The error of a close before the end */
function premature(): Error {
  return Object.assign(new Error("Premature close"), {
    code: "ERR_STREAM_PREMATURE_CLOSE",
  });
}

/**
 * Releases a stream-like source that is not sent (e.g. to `HEAD`): it is
 * destroyed (without an error), or paused, and never read
 */
export function releaseStreamLike(
  source: object,
  { destroy, pause }: IStreamLikeMethods,
): void {
  if (destroy === null) {
    Reflect.apply(pause, source, []);
  } else {
    Reflect.apply(destroy, source, []);
  }
}

/**
 * A stream-like source (see `IStreamLike`) read as a Node.js `Readable`, which
 * `send()` sends as such. Its `data` is pushed with backpressure: the source
 * is paused once the readable is full (e.g. while the response is), and
 * resumed once it is read. Its `end` ends the readable, and its `error`, or a
 * `close` before its end, destroys it with that error (or
 * `ERR_STREAM_PREMATURE_CLOSE`). Destroyed before (a cancellation: the
 * deadline, the client gone away, another reply), the readable destroys the
 * source with the reason of the cancellation (`reason()`), or pauses a source
 * that cannot be destroyed.
 *
 * Every listener that it adds is removed through the source (by its
 * `removeListener()` or `off()`) once the source has ended, failed or closed,
 * or is paused for a cancellation. Its `error` listener stays a little longer
 * where the source may still emit an error, which would otherwise crash the
 * process without a listener of the application: until the next turn after
 * its `end`, `error` or `close`, or a pause (e.g. `readable-stream` 2 emits
 * `end` and `close` before the `error` of its `destroy()`), and until the
 * `error` or the `close` that the destroy of a cancellation emits (with its
 * `close` listener, also once the destroy has completed asynchronously). A
 * source that has ended already is an empty body, and one destroyed before
 * its end closes the readable at once: neither is listened to.
 */
export function readStreamLike(
  source: object,
  methods: IStreamLikeMethods,
  reason: () => Error,
): Readable {
  /** The listeners added to the source, by event */
  const listeners = new Map<string, (...args: never[]) => void>();
  /** Whether the source has ended, failed or closed (or is cancelled) */
  let settled = false;
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
    settled = true;
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
    // Destroyed before the source has settled: it is cancelled
    destroy: (error, callback): void => {
      if (!settled) {
        const { destroy, pause } = methods;
        if (destroy === null) {
          call(pause);
          settle();
        } else {
          // Its `error` and `close` listeners stay until the destroy emits
          // one of them
          release("data", "end");
          call(destroy, error ?? reason());
        }
      }
      callback(error);
    },
  });
  if (hasEnded(source)) {
    settled = true;
    readable.push(null);
    return readable;
  } else if (
    Reflect.get(source, "destroyed") === true ||
    // Of `through2` 2, whose `destroy()` sets only that
    Reflect.get(source, "_destroyed") === true
  ) {
    // Nothing more of it can be read (see `BindenResponse.#pipe()`)
    settled = true;
    readable.destroy();
    return readable;
  }
  listen("error", (error: Error) => {
    settle();
    readable.destroy(error);
  });
  listen("close", () => {
    // Before its end (once it has ended, it is no longer listened to)
    settle();
    readable.destroy(premature());
  });
  listen("end", () => {
    settle();
    readable.push(null);
  });
  listen("data", (chunk: unknown) => {
    if (!readable.push(chunk)) {
      call(methods.pause);
    }
  });
  return readable;
}
