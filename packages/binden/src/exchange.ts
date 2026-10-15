import type { IncomingMessage, ServerResponse } from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";

/** Why the work of a request has been abandoned */
export type IAbortReason = "client_closed" | "deadline" | "shutdown";

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

/** The reply (see `Exchange.reply()`) that the current asynchronous work belongs to */
const replies = new AsyncLocalStorage<object>();

/**
 * The state of one request and its response, shared by every context created
 * for them (e.g. a middleware that returns a new context of the same request):
 * its abort signal, deadline, state, `done` flag and cleanup.
 */
export class Exchange {
  readonly #response: ServerResponse;
  readonly #controller: AbortController;
  readonly #state: object;
  readonly #cleanups: (() => unknown)[];
  readonly #finished: Promise<void>;
  readonly #report: IExchangeReport;
  readonly #aborted: Promise<void>;
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
    response: ServerResponse,
    { state = {}, report }: IExchangeOptions,
  ) {
    this.#response = response;
    this.#controller = new AbortController();
    this.#state = state;
    this.#cleanups = [];
    this.#report = report ?? Exchange.#ignore;
    this.#aborted = new Promise<void>((resolve) => {
      this.#controller.signal.addEventListener(
        "abort",
        () => {
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
    // response is complete
    this.#finished = new Promise<void>((resolve) => {
      response.once("close", () => {
        if (!response.writableFinished) {
          this.abort("client_closed");
        }
        resolve(this.#finish());
      });
    });
  }

  /**
   * The exchange of a request, created on first use (the options apply only
   * then). A response other than the one of the exchange is refused.
   */
  public static for(
    request: IncomingMessage,
    response: ServerResponse,
    options: IExchangeOptions = {},
  ): Exchange {
    const found = exchanges.get(request);
    if (typeof found === "undefined") {
      const exchange = new Exchange(response, options);
      exchanges.set(request, exchange);
      return exchange;
    } else if (found.#response !== response) {
      throw new TypeError("The response is not the one of the request");
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
   * and of the latest layer that has run a middleware (`null` for none)
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
    return (
      !this.#sealed ||
      (this.#reply !== null && replies.getStore() === this.#reply)
    );
  }

  /**
   * From now on only the framework replies (e.g. once the deadline has
   * passed): the work of the middlewares, and of any earlier `reply()`, may
   * no longer reply
   */
  public seal(): void {
    this.#sealed = true;
    this.#reply = null;
  }

  /** Runs the reply of the framework: the work it starts may reply (see `may_reply`) */
  public reply<T>(fn: () => T): T {
    const reply = {};
    this.#reply = reply;
    return replies.run(reply, fn);
  }

  /** Settles once the response is closed and every cleanup has run */
  public get finished(): Promise<void> {
    return this.#finished;
  }

  /** Aborts the signal, once: `false` when it has already been aborted */
  public abort(reason: IAbortReason): boolean {
    if (this.#controller.signal.aborted) {
      return false;
    }
    this.#clearTimer();
    this.#controller.abort(new BindenAbortError(reason));
    return true;
  }

  /**
   * (Re)starts the deadline of the request from now: the signal is aborted
   * (`deadline`) once `ms` milliseconds have passed. `0` removes the deadline.
   */
  public setTimeout(ms: number): void {
    if (!Number.isInteger(ms)) {
      throw new TypeError("The timeout is not an integer");
    } else if (ms < 0 || ms > MAX_DELAY) {
      throw new RangeError(`The timeout is not between 0 and ${MAX_DELAY}`);
    } else if (this.#phase !== "running") {
      throw new TypeError("The request has been completed");
    }
    this.#clearTimer();
    if (ms > 0 && !this.#controller.signal.aborted) {
      this.#timer = setTimeout(() => {
        this.#timer = null;
        this.abort("deadline");
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
      throw new TypeError("The cleanup is not a function");
    } else if (this.#phase !== "running") {
      throw new TypeError("The request has been completed");
    }
    this.#cleanups.push(cleanup);
  }

  async #finish(): Promise<void> {
    this.#phase = "finalizing";
    this.#clearTimer();
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
