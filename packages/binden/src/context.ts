import type { ILogger } from "@binden/logger";
import { BindenError, type IBindenErrorOptions } from "./error.js";
import { Exchange } from "./exchange.js";
import defaultLogger from "./logger.js";

import type { Readable } from "node:stream";
import type { BindenRequest } from "./request.js";
import type { IHeadersValue, BindenResponse } from "./response.js";

export interface IBaseContext {
  readonly request: BindenRequest;
  readonly response: BindenResponse<BindenRequest>;
}

export interface IContextOptions extends IBaseContext {
  /** The logger whose child (with the `trace_id` of the context) is `context.log` */
  readonly logger?: ILogger | undefined;
  /**
   * The state of the request: used by the first context of the request only
   * (the others share it)
   */
  readonly state?: object | undefined;
}

export type IParams = Record<string, string>;

export class Context<
  State extends object = Record<string, unknown>,
  Params extends IParams = IParams,
> implements IBaseContext {
  readonly #request: BindenRequest;
  readonly #response: BindenResponse<BindenRequest>;
  readonly #parent: ILogger;
  readonly #exchange: Exchange;
  #logger?: ILogger;

  public constructor({
    request,
    response,
    logger = defaultLogger,
    state,
  }: IContextOptions) {
    this.#request = request;
    this.#response = response;
    this.#parent = logger;
    this.#exchange = Exchange.for(request, response, {
      state,
      report: (message, error) => this.log.error(message, { error }),
    });
  }

  /**
   * A child of the logger with the `trace_id` of the context, created when it
   * is first used. A logger that fails to create one (e.g. a custom logger
   * whose `child()` throws) is used itself: logging never prevents the context
   * from being created.
   */
  public get log(): ILogger {
    if (!this.#logger) {
      try {
        this.#logger = this.#parent.child({ trace_id: this.id });
      } catch {
        this.#logger = this.#parent;
      }
    }
    return this.#logger;
  }

  public setHeader(name: string, value: IHeadersValue): this {
    this.response.setHeader(name, value);
    return this;
  }

  public status(code: number): this {
    this.response.status(code);
    return this;
  }

  public get request(): BindenRequest {
    return this.#request;
  }

  public get response(): BindenResponse<BindenRequest> {
    return this.#response;
  }

  public get id(): string {
    return this.request.id;
  }

  /** Set once the request is handled: shared by every context of the request */
  public get done(): boolean {
    return this.#exchange.done;
  }

  public set done(done: unknown) {
    this.#exchange.done = Boolean(done);
  }

  /**
   * Aborted once the work for the request should stop: the client has gone
   * away (`client_closed`), the deadline has passed (`deadline`) or the server
   * is shutting down (`shutdown`); its reason is a `BindenAbortError`
   */
  public get signal(): AbortSignal {
    return this.#exchange.signal;
  }

  /** The state of the request, shared by every context of the request */
  public get state(): State {
    return this.#exchange.state as State;
  }

  /** The parameters of the matched route */
  public get params(): Readonly<Params> {
    return this.#exchange.params as Readonly<Params>;
  }

  /** The matched mount prefixes, with their values (`""` at the root) */
  public get mount_path(): string {
    return this.#exchange.mount_path;
  }

  /**
   * (Re)starts the deadline of the request from now (`0` removes it): once it
   * has passed, `signal` is aborted with the `deadline` reason
   */
  public setTimeout(ms: number): void {
    this.#exchange.setTimeout(ms);
  }

  /**
   * Runs `cleanup` once the response is closed (finished, or its connection
   * closed), after the cleanups registered later; a failure is logged
   */
  public onCleanup(cleanup: () => unknown): void {
    this.#exchange.onCleanup(cleanup);
  }

  public get url(): URL {
    return this.request.URL;
  }

  public async send(
    data?: Buffer | Readable | bigint | number | string,
  ): Promise<void> {
    await this.#reply(() => this.response.send(data));
  }

  public async json(
    data: Record<string, unknown> | unknown[],
    stringify?: (input: Record<string, unknown> | unknown[]) => string,
  ): Promise<void> {
    await this.#reply(async () => {
      await (typeof stringify === "undefined"
        ? this.response.json(data)
        : this.response.json(data, stringify));
    });
  }

  public async text(data: string): Promise<void> {
    await this.#reply(() => this.response.text(data));
  }

  public async html(data: string): Promise<void> {
    await this.#reply(() => this.response.html(data));
  }

  public async form(data: URLSearchParams): Promise<void> {
    await this.#reply(() => this.response.form(data));
  }

  /** Send a file */
  public async sendFile(url: URL | string): Promise<void> {
    await this.#reply(() => this.response.sendFile(url));
  }

  // eslint-disable-next-line class-methods-use-this
  public throw(status: number, opts?: IBindenErrorOptions): never {
    throw new BindenError(status, opts);
  }

  /**
   * Sends a reply and sets `done`, unless the framework has taken over the
   * reply (e.g. the deadline has passed): a late reply is then ignored
   */
  async #reply(send: () => Promise<void>): Promise<void> {
    if (!this.#exchange.may_reply) {
      this.log.debug("A late reply has been ignored");
      return;
    }
    await send();
    this.done = true;
  }
}
