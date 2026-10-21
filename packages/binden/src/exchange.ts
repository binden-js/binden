import {
  type IFailureRoute,
  type ILateFailures,
  type ITokenIssuer,
  onPipeFailure,
} from "./listeners.js";
import {
  type IPipeFailure,
  kCancelling,
  kFramework,
  kListen,
  kPipeFailure,
  kRevoke,
  owners,
} from "./seal.js";
import type { BindenResponse } from "./response.js";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { decided } from "./stream-like.js";
import { isProxy } from "node:util/types";

/** Why the work of a request has been abandoned */
export type IAbortReason = "client_closed" | "deadline" | "shutdown";

/**
 * Formats the stack of an error that binden, or one of its packages, has just
 * created, before it throws it, rejects with it or hands it over (each one:
 * e.g. the `TypeError` of an argument, the reason of an aborted signal, or
 * the error that a send rejects with, or destroys its source with): V8
 * formats it once it is first read, and until then its frames hold their
 * objects (e.g. the response, as the receiver of its methods), which an
 * error kept by the application, or by a source (e.g. minipass, which keeps
 * the one it is destroyed with), would retain as long as it lives. A plain
 * `BindenError` formats itself. For the packages of binden only.
 *
 * @internal
 */
export function formatStack<T extends Error>(error: T): T {
  try {
    Reflect.get(error, "stack");
  } catch {
    // A `prepareStackTrace` of the application that throws: the stack is
    // left to it
  }
  return error;
}

/**
 * The getter of `stack` of the engine: on the versions of Node.js that
 * binden supports, every native error (also an instance of a subclass, a
 * `DOMException` or an object of `Error.captureStackTrace()`) has it as an
 * accessor of its own. It formats the stack once it is first read (by
 * `Error.prepareStackTrace`, which may be of the application, and may throw:
 * the stack is not formatted then), and returns it as formatted afterwards.
 */
function engineStack(): unknown {
  const probe = {};
  Error.captureStackTrace(probe);
  // An object in any case (none would be `{}`)
  const descriptor = Object(
    Reflect.getOwnPropertyDescriptor(probe, "stack"),
  ) as object;
  return Reflect.get(descriptor, "get");
}

/** The getter of `stack` of the engine (see `engineStack()`) */
const nativeStack = engineStack();

/**
 * Formats the stack of a value by the getter of the engine (see
 * `engineStack()`): whether it is formatted. A `prepareStackTrace` of the
 * application may throw: the stack is not formatted then, and Node.js would
 * run it again.
 */
function formats(value: unknown): boolean {
  try {
    Reflect.get(Object(value) as object, "stack", value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where the `stack` of a value is found (see `readsSafely()`): its own, or of
 * the nearest prototype that has one, as its descriptor and the object that
 * holds it, `null` without one, or `false` through a proxy, whose traps are
 * code of the application (never run here)
 */
function stackOf(
  value: object,
): false | { holder: object; descriptor: PropertyDescriptor } | null {
  for (
    let link: object | null = value;
    link !== null;
    link = Reflect.getPrototypeOf(link)
  ) {
    if (isProxy(link)) {
      return false;
    }
    const descriptor = Reflect.getOwnPropertyDescriptor(link, "stack");
    if (typeof descriptor !== "undefined") {
      return { holder: link, descriptor };
    }
  }
  return null;
}

/**
 * Whether Node.js reads the `stack` of a value without running code of the
 * application, as it does to destroy a `Readable` with it (before the
 * stream is destroyed, and again once its `_destroy()` has called back): a
 * value whose `stack` (its own, or of the nearest prototype that has one) is
 * a value, a value without a `stack`, or one whose `stack` is the getter of
 * the engine (see `engineStack()`), read here first: once formatted, its
 * stack is kept, and Node.js reads it as it is. Never through a proxy (its
 * traps are code of the application), nor by a getter of the application,
 * which is not called (it may return a string here, and throw once Node.js
 * reads it). Formatting runs code of the application (e.g. a getter of its
 * `name` that V8 reads, or a `prepareStackTrace`), which may change where
 * the stack is found (e.g. define a getter of its own): the prototype chain
 * and the descriptor are checked again afterwards, without formatting (the
 * stack is kept by then), so that the verdict is the one of the value that
 * Node.js reads. For the packages of binden only.
 *
 * @internal
 */
export function readsSafely(value: unknown): boolean {
  const object = Object(value) as object;
  const found = stackOf(object);
  if (found === null || found === false) {
    return found === null;
  } else if ("value" in found.descriptor) {
    return true;
  } else if (
    Reflect.get(found.descriptor, "get") !== nativeStack ||
    !formats(value)
  ) {
    return false;
  }
  // Again, once formatted: its own value (e.g. of a getter that has replaced
  // it), or the getter of the engine on the same object, which has kept it
  const again = stackOf(object);
  return (
    again === null ||
    (again !== false &&
      ("value" in again.descriptor ||
        (again.holder === found.holder &&
          Reflect.get(again.descriptor, "get") === nativeStack)))
  );
}

/** The message of a carrier (see `carrierOf()`) */
const carried = "A stream has failed";

/** `Error.prototype` of the engine (a property that cannot be changed) */
const errorPrototype = Error.prototype;

/**
 * What a `Readable` is destroyed with in place of a value whose `stack`
 * Node.js cannot read safely (see `readsSafely()`): an `Error` (an object of
 * `Error.prototype`) that carries it as its `cause`, decided as well (see
 * `decided()`), made with its `stack` as a value of its own that can be
 * neither written nor redefined, its header: no `prepareStackTrace` of the
 * application ever runs for it (one that redefines or freezes the `stack` of
 * what it formats would leave a carrier that Node.js cannot read, or that
 * binden cannot fix), it holds no frames (nothing of the request or of the
 * response, whoever keeps it), and Node.js reads its `stack` as it is. For
 * the packages of binden only.
 *
 * @internal
 */
export function carrierOf(cause: unknown): Error {
  const carrier = Object.create(errorPrototype, {
    message: { configurable: true, value: carried, writable: true },
    cause: { configurable: true, value: cause, writable: true },
    stack: { value: `Error: ${carried}` },
  }) as Error;
  decided(carrier);
  return carrier;
}

/** The reason of `context.signal` once the request is aborted */
export class BindenAbortError extends Error {
  readonly #reason: IAbortReason;

  /** The abort of a request, for the reason */
  public constructor(reason: IAbortReason) {
    super(`The request has been aborted (${reason})`);
    this.name = "BindenAbortError";
    this.#reason = reason;
  }

  /**
   * Why the request has been aborted: the client has gone away
   * (`client_closed`), the deadline has passed (`deadline`) or the server is
   * shutting down (`shutdown`)
   */
  public get reason(): IAbortReason {
    return this.#reason;
  }
}

/** Reports a failure that nothing else can handle (e.g. a cleanup that throws) */
export type IExchangeReport = (message: string, error: unknown) => void;

/** The options of an exchange, used when it is created */
export interface IExchangeOptions {
  /** The state of the request, created once for the exchange */
  readonly state?: object | undefined;
  /** Reports a failure of a cleanup (ignored by default) */
  readonly report?: IExchangeReport | undefined;
}

type IPhase = "finalizing" | "finished" | "running";

/** The greatest delay of a Node.js timer */
const MAX_DELAY = 2 ** 31 - 1;

const exchanges = new WeakMap<IncomingMessage, Exchange>();

/** The methods of `EventEmitter` of every emitter (e.g. of a connection) */
const intrinsic = EventEmitter.prototype;

/**
 * A connection whose termination its exchanges observe (see
 * `Exchange.#observe()`): the exchanges whose responses are not closed yet,
 * and its one `close` listener
 */
interface ITransport {
  readonly exchanges: Set<Exchange>;
  readonly closed: IClosed;
}

/** The `close` listener of a connection (see `ITransport`) */
type IClosed = () => void;

const transports = new WeakMap<Socket, ITransport>();

/**
 * The state of one request and its response, shared by every context created
 * for them (e.g. a middleware that returns a new context of the same request):
 * its abort signal, deadline, state, `done` flag and cleanup.
 */
export class Exchange implements ITokenIssuer {
  readonly #response: BindenResponse;
  readonly #controller: AbortController;
  readonly #state: object;
  readonly #cleanups: (() => unknown)[];
  readonly #finished: Promise<void>;
  readonly #report: IExchangeReport;
  readonly #aborted: Promise<void>;
  readonly #halted = Promise.withResolvers<never>();
  /** The tokens of the works that may mutate the response (see `token()`) */
  readonly #live = new Set<object>();
  /** The tokens of the works that may no longer mutate it */
  readonly #revoked = new WeakSet<object>();
  /**
   * The failure routes of the tokens that it has issued (see `token()`):
   * cleared once it finishes, so that what keeps a token (e.g. a timer
   * created in the context of its work) no longer keeps the exchange
   */
  readonly #routes: IFailureRoute[] = [];
  /** What a late failure of a pipe of its works does (see `onLateFailure()`) */
  readonly #late: ILateFailures = { report: null };
  /** Settles once the revoked works have been told (see `kRevoke`) */
  #delivered: Promise<void> = Promise.resolve();
  /** The token of the middleware stack (see `stack()`), once created */
  #stack: object | null = null;
  #halting = false;
  /** Whether its connection terminates (see `terminating`) */
  #terminating = false;
  /** The connection of the request, whose termination it observes */
  readonly #connection: Socket | null;
  #phase: IPhase;
  #sealed: boolean;
  #reply: object | null;
  #done: boolean;
  #timer: NodeJS.Timeout | null;
  #params: Readonly<Record<string, string>>;
  #mount_path: string;
  #mount_template: string;
  #route: string | null;

  private constructor(
    request: IncomingMessage,
    response: BindenResponse,
    { state = {}, report }: IExchangeOptions,
  ) {
    this.#response = response;
    const { socket } = request as { socket: Socket | null };
    // E.g. a request without a socket has no connection to observe
    this.#connection = socket instanceof EventEmitter ? socket : null;
    this.#controller = new AbortController();
    this.#state = state;
    this.#cleanups = [];
    this.#report = report ?? Exchange.#ignore;
    this.#aborted = new Promise<void>((resolve) => {
      this.#controller.signal.addEventListener(
        "abort",
        () => {
          this.halt();
          resolve();
        },
        { once: true },
      );
    });
    this.#phase = "running";
    this.#sealed = false;
    this.#reply = null;
    this.#done = false;
    this.#timer = null;
    this.#params = Object.freeze({});
    this.#mount_path = "";
    this.#mount_template = "";
    this.#route = null;

    // `close` follows `finish`, unless the connection is closed before the
    // response is complete: the real one (never the one of an abandoned work)
    this.#finished = new Promise<void>((resolve) => {
      response[kListen]("close", () => {
        this.#unobserve();
        if (!response.writableFinished) {
          this.abort("client_closed");
        }
        resolve(this.#finish());
      });
    });
    this.#observe();
  }

  /**
   * Observes the termination of the connection of the request (the `close`
   * of its socket: the client has gone away, Node.js has aborted the
   * responses that it still had, or a shutdown has destroyed it) until the
   * response is closed: by one listener of the connection, for every exchange
   * of its requests (e.g. pipelined) whose response is not closed yet. Never
   * the `close` of the request itself, which comes once its body has been
   * read, while the connection lives on.
   */
  #observe(): void {
    const connection = this.#connection;
    if (connection === null) {
      return;
    }
    let transport = transports.get(connection);
    if (typeof transport === "undefined") {
      const observed = new Set<Exchange>();
      const closed = (): void => {
        transports.delete(connection);
        intrinsic.removeListener.call(connection, "close", closed);
        for (const exchange of observed) {
          exchange.#terminate();
        }
      };
      transport = { exchanges: observed, closed };
      transports.set(connection, transport);
      intrinsic.on.call(connection, "close", closed);
    }
    transport.exchanges.add(this);
  }

  /**
   * The response is closed: its connection is no longer observed for it (nor
   * at all, once no other response of the connection is open)
   */
  #unobserve(): void {
    const connection = this.#connection as Socket;
    const transport = transports.get(connection);
    if (transport?.exchanges.delete(this) === true) {
      if (transport.exchanges.size === 0) {
        transports.delete(connection);
        intrinsic.removeListener.call(connection, "close", transport.closed);
      }
    }
  }

  /**
   * The connection of the request has closed: a response that is not closed
   * yet is destroyed with the rights of the framework (also once it is
   * sealed, e.g. a complete reply that waits for the response before it, or
   * the reply of a deadline, which Node.js would destroy without an owner), so
   * that it is finalized once, on every version of Node.js: one that has no
   * socket (it waits for another response of the connection) is closed on
   * the next tick, by Node.js or else (Node.js 24.14) by the framework
   */
  #terminate(): void {
    this.#terminating = true;
    const response = this.#response;
    response[kFramework](() => response.destroy());
    process.nextTick(() => {
      if (!response.closed) {
        Reflect.set(response, "_closed", true);
        response.emit("close");
      }
    });
  }

  /**
   * The token of the work of the latest `reply()` (see `reply()`), until
   * the exchange is sealed again: `null` otherwise
   */
  public get current_reply(): object | null {
    return this.#reply;
  }

  /**
   * Whether the connection of the request terminates: it has closed (see
   * `#terminate()`), or the server shuts down (see `abort()`), also while
   * the abort listeners run, before its socket is destroyed
   */
  public get terminating(): boolean {
    return this.#terminating;
  }

  /**
   * The exchange of a request, created on first use (the options apply only
   * then). A response other than the one of the exchange is refused.
   */
  public static for(
    request: IncomingMessage,
    response: BindenResponse,
    options: IExchangeOptions = {},
  ): Exchange {
    const found = exchanges.get(request);
    if (typeof found === "undefined") {
      const exchange = new Exchange(request, response, options);
      exchanges.set(request, exchange);
      return exchange;
    } else if (found.#response !== response) {
      throw formatStack(
        new TypeError("The response is not the one of the request"),
      );
    }
    return found;
  }

  /** The exchange of a request, if it has one */
  public static find(request: IncomingMessage): Exchange | null {
    return exchanges.get(request) ?? null;
  }

  /**
   * Aborted once, with a `BindenAbortError`, when the work for the request
   * should stop
   */
  public get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** The state of the request */
  public get state(): object {
    return this.#state;
  }

  /** Whether a middleware has handled the request */
  public get done(): boolean {
    return this.#done;
  }

  /** `done` cannot be unset */
  public set done(done: boolean) {
    this.#done ||= done;
  }

  /** The parameters of the current match (set by the routing) */
  public get params(): Readonly<Record<string, string>> {
    return this.#params;
  }

  /** Sets the parameters of the current match (a frozen copy) */
  public set params(params: Readonly<Record<string, string>>) {
    this.#params = Object.freeze({ ...params });
  }

  /** The matched mount prefixes, with their values (`""` at the root) */
  public get mount_path(): string {
    return this.#mount_path;
  }

  /** Sets the matched mount prefixes, with their values */
  public set mount_path(path: string) {
    this.#mount_path = path;
  }

  /** The matched mount prefixes, as registered (e.g. `/users/:id`) */
  public get mount_template(): string {
    return this.#mount_template;
  }

  /** Sets the matched mount prefixes, as registered */
  public set mount_template(template: string) {
    this.#mount_template = template;
  }

  /**
   * Enters a level of the routing: its parameters are merged with the
   * current ones, and its prefix (as matched and as registered) appended to
   * the current ones. The returned function goes back to the current level.
   */
  public enter({
    params,
    prefix,
    template,
  }: {
    params: Readonly<Record<string, string>>;
    prefix: string;
    template: string;
  }): () => void {
    const current = {
      params: this.#params,
      mount_path: this.#mount_path,
      mount_template: this.#mount_template,
    };
    this.params = { ...current.params, ...params };
    this.#mount_path += prefix;
    this.#mount_template += template;
    return (): void => {
      this.#params = current.params;
      this.#mount_path = current.mount_path;
      this.#mount_template = current.mount_template;
    };
  }

  /**
   * The route that the access log names: the templates of the matched mounts
   * and of the layer that has started the reply (`null` for none: the access
   * log names `<unmatched>` for a reply of the framework)
   */
  public get route(): string | null {
    return this.#route;
  }

  /** Sets the route that the access log names */
  public set route(route: string) {
    this.#route = route;
  }

  /**
   * Where the exchange is: `running`, then `finalizing` (its cleanups run) once
   * the response is closed, then `finished`
   */
  public get phase(): IPhase {
    return this.#phase;
  }

  /** Settles once the signal is aborted (never rejects) */
  public get aborted(): Promise<void> {
    return this.#aborted;
  }

  /**
   * Whether the current asynchronous work may reply: anything before the
   * exchange is sealed, then only the work run by the latest `reply()`
   */
  public get may_reply(): boolean {
    return this.allows(owners.getStore());
  }

  /**
   * Whether the work of an owner (see `owners`: a token of the exchange, or
   * `undefined` for a work of no request) may reply: anything but a revoked
   * token before the exchange is sealed, then only the latest `reply()`
   */
  public allows(owner: object | undefined): boolean {
    if (typeof owner !== "undefined" && this.#revoked.has(owner)) {
      return false;
    }
    return !this.#sealed || (this.#reply !== null && owner === this.#reply);
  }

  /**
   * From now on only the framework replies (e.g. once the deadline has
   * passed): the works of the exchange (its stack, and any earlier
   * `reply()`) may no longer reply, and are told so (see `kRevoke`), with the
   * failure of a pipe of one of them, if any. The pending sends are then
   * cancelled at once with its error (see `kCancelling`): the framework
   * carries the cancellation out once they have been told (see `delivered`),
   * and a send that settles in between rejects with that error, never as a
   * send that is ignored.
   */
  public seal(failure: IPipeFailure | null = null): void {
    this.#sealed = true;
    this.#reply = null;
    if (failure !== null) {
      this.#response[kCancelling](failure.error);
    }
    this.#revoke([...this.#live], failure);
  }

  /**
   * One work of the exchange may no longer reply (e.g. a pipe of the stack
   * that fails once the error handler runs), and is told so (see `kRevoke`):
   * the others keep their rights
   */
  public revoke(failure: IPipeFailure): void {
    if (this.#live.has(failure.owner)) {
      this.#revoke([failure.owner], failure);
    }
  }

  /** Revokes works of the exchange: they are told so on the next tick */
  #revoke(tokens: object[], failure: IPipeFailure | null): void {
    for (const token of tokens) {
      this.#live.delete(token);
      this.#revoked.add(token);
    }
    if (tokens.length > 0) {
      const delivered = this.#response[kRevoke](tokens, failure);
      this.#delivered = this.#delivered.then(() => delivered);
    }
  }

  /**
   * Settles once the works revoked so far have been told so (see
   * `kRevoke`): the work that replaces them starts afterwards (never rejects)
   */
  public get delivered(): Promise<void> {
    return this.#delivered;
  }

  /**
   * A token of a work of the exchange (e.g. its middleware stack): the work
   * run with it (see `owners`) may reply until it is revoked
   */
  public token(): object {
    const token = {};
    this.#live.add(token);
    // A pipe of the work that fails (e.g. the end of its `pipeline()`)
    // fails it on this response, whatever response it pipes into (a new
    // token always gets its route)
    const route = onPipeFailure(
      token,
      this,
      (error, source) => this.#response[kPipeFailure](token, error, source),
      this.#late,
    ) as IFailureRoute;
    if (this.#phase === "running") {
      this.#routes.push(route);
    } else {
      // Its exchange has finished already: a failure of its pipes is late
      route.fail = null;
    }
    return token;
  }

  /**
   * Sets how a late failure of a pipe of a work of the exchange (once it has
   * finished, see `finished`) is reported (e.g. logged at `debug`): the
   * report must not hold the request (e.g. its context), which would then be
   * kept as long as anything keeps a token of its works
   */
  public onLateFailure(report: (error: unknown) => void): void {
    this.#late.report = report;
  }

  /** Whether a token is of a work of the exchange (see `token()`), also once revoked */
  public issued(token: object): boolean {
    return this.#live.has(token) || this.#revoked.has(token);
  }

  /**
   * The token of the middleware stack (see `token()`), created once: the
   * deadline is dispatched as its work (see `setTimeout()`)
   */
  public stack(): object {
    this.#stack ??= this.token();
    return this.#stack;
  }

  /** Runs the reply of the framework: the work it starts may reply (see `may_reply`) */
  public reply<T>(fn: () => T): T {
    const reply = this.token();
    this.#reply = reply;
    return owners.run(reply, fn);
  }

  /**
   * The middleware stack stops (e.g. a pipe of it has failed), although the
   * signal is not aborted (the deadline still applies)
   */
  public halt(): void {
    this.#halting = true;
    (this.#halted.resolve as () => void)();
  }

  /** Settles once the stack stops: the signal is aborted, or `halt()` (never rejects) */
  public get halted(): Promise<void> {
    return this.#halted.promise;
  }

  /** Whether the stack stops (see `halted`) */
  public get has_halted(): boolean {
    return this.#halting;
  }

  /** Settles once the response is closed and every cleanup has run */
  public get finished(): Promise<void> {
    return this.#finished;
  }

  /**
   * Aborts the signal, once: `false` when it has already been aborted. The
   * exchange is sealed before a `deadline` is dispatched (see `seal()`): the
   * abort listeners and the continuations of the work that is abandoned (e.g.
   * a `catch` that replies) then see a response that they may no longer change.
   */
  public abort(reason: IAbortReason): boolean {
    if (this.#controller.signal.aborted) {
      return false;
    }
    this.#clearTimer();
    if (reason === "deadline") {
      this.seal();
    } else if (reason === "shutdown") {
      // Before its listeners run (see `terminating`)
      this.#terminating = true;
    }
    // Formatted at once: a source destroyed with it (e.g. a send cancelled at
    // the deadline) may keep it, and must not retain the exchange
    this.#controller.abort(formatStack(new BindenAbortError(reason)));
    return true;
  }

  /**
   * (Re)starts the deadline of the request from now: the signal is aborted
   * (`deadline`) once `ms` milliseconds have passed. `0` removes the deadline.
   * Ignored, without checking `ms`, for a work that may no longer reply
   * (e.g. a stack that has failed): the deadline is of the work that replaces
   * it. Its abort runs as the work of the stack (see `stack()`), whatever
   * work has started the deadline: the abort listeners of the stack, and
   * what they start, are of the abandoned work (see `kRevoke`).
   */
  public setTimeout(ms: number): void {
    if (!this.may_reply) {
      return;
    } else if (!Number.isInteger(ms)) {
      throw formatStack(new TypeError("The timeout is not an integer"));
    } else if (ms < 0 || ms > MAX_DELAY) {
      throw formatStack(
        new RangeError(`The timeout is not between 0 and ${MAX_DELAY}`),
      );
    } else if (this.#phase !== "running") {
      throw formatStack(new TypeError("The request has been completed"));
    }
    this.#clearTimer();
    if (ms > 0 && !this.#controller.signal.aborted) {
      this.#timer = setTimeout(() => {
        this.#timer = null;
        const stack = this.#stack;
        if (stack === null) {
          this.abort("deadline");
        } else {
          owners.run(stack, () => this.abort("deadline"));
        }
      }, ms);
      this.#timer.unref();
    }
  }

  /**
   * Registers a function to run once the response is closed (finished, or its
   * connection closed): the functions run one at a time, the last registered
   * first, and their failures are reported
   */
  public onCleanup(cleanup: () => unknown): void {
    if (typeof cleanup !== "function") {
      throw formatStack(new TypeError("The cleanup is not a function"));
    } else if (this.#phase !== "running") {
      throw formatStack(new TypeError("The request has been completed"));
    }
    this.#cleanups.push(cleanup);
  }

  async #finish(): Promise<void> {
    this.#phase = "finalizing";
    this.#clearTimer();
    // Its works may no longer fail it: a later failure of their pipes is late
    for (const route of this.#routes.splice(0)) {
      route.fail = null;
    }
    for (let cleanup = this.#cleanups.pop(); cleanup;) {
      try {
        await cleanup();
      } catch (error: unknown) {
        this.#safeReport("A cleanup of the request has failed", error);
      }
      cleanup = this.#cleanups.pop();
    }
    this.#phase = "finished";
  }

  #clearTimer(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #safeReport(message: string, error: unknown): void {
    try {
      this.#report(message, error);
    } catch {
      // Nothing else to report it to
    }
  }

  static #ignore(): void {
    // No reporter
  }
}
