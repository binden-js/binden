import { kListen, kRevoke, owners } from "./seal.js";
import type { BindenResponse } from "./response.js";
import type { IncomingMessage } from "node:http";

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

/**
 * The state of one request and its response, shared by every context created
 * for them (e.g. a middleware that returns a new context of the same request):
 * its abort signal, deadline, state, `done` flag and cleanup.
 */
export class Exchange {
  readonly #response: BindenResponse;
  readonly #controller: AbortController;
  readonly #state: object;
  readonly #cleanups: (() => unknown)[];
  readonly #finished: Promise<void>;
  readonly #report: IExchangeReport;
  readonly #aborted: Promise<void>;
  /** The tokens of the works that may mutate the response (see `token()`) */
  readonly #live = new Set<object>();
  /** The tokens of the works that may no longer mutate it */
  readonly #revoked = new WeakSet<object>();
  /** Settles once the revoked works have been told (see `kRevoke`) */
  #delivered: Promise<void> = Promise.resolve();
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
    response: BindenResponse,
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
    // response is complete: the real one (never the one of an abandoned work)
    this.#finished = new Promise<void>((resolve) => {
      response[kListen]("close", () => {
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
    response: BindenResponse,
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
   * `reply()`) may no longer reply, and are told so (see `kRevoke`)
   */
  public seal(): void {
    this.#sealed = true;
    this.#reply = null;
    const tokens = [...this.#live];
    this.#live.clear();
    for (const token of tokens) {
      this.#revoked.add(token);
    }
    if (tokens.length > 0) {
      const delivered = this.#response[kRevoke](tokens);
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
    return token;
  }

  /** Runs the reply of the framework: the work it starts may reply (see `may_reply`) */
  public reply<T>(fn: () => T): T {
    const reply = this.token();
    this.#reply = reply;
    return owners.run(reply, fn);
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
    }
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
