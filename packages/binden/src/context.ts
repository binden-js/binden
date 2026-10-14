import type { ILogger } from "@binden/logger";
import { BindenError, type IBindenErrorOptions } from "./error.js";
import { Exchange, type IExchangeReport } from "./exchange.js";
import { defaultLogger, safe, snapshot } from "./logger.js";

import type { Readable } from "node:stream";
import type { IRedirectOptions, IRedirectStatus } from "./redirect.js";
import type { BindenRequest } from "./request.js";
import type {
  IClearCookie,
  IHeadersValue,
  BindenResponse,
} from "./response.js";
import type { ISendFileOptions } from "./send-file.js";

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
  /**
   * Reports a failure of a cleanup of the request (used by the first context
   * of the request only): logged by default (`error`)
   */
  readonly report?: IExchangeReport | undefined;
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
    logger,
    state,
    report,
  }: IContextOptions) {
    this.#request = request;
    this.#response = response;
    this.#parent = safe(logger ?? defaultLogger());
    this.#exchange = Exchange.for(request, response, {
      state,
      report:
        report ??
        ((message, error): void => {
          const options = { location: "cleanup", details: false } as const;
          this.log.error(message, { failure: snapshot(error, options) });
        }),
    });
  }

  /**
   * A child of the logger with the `trace_id` of the context, created when it
   * is first used. Its calls never fail (e.g. a custom logger that throws, or
   * whose `child()` throws, is ignored, and its rejected promises observed):
   * logging never prevents the request from being handled.
   */
  public get log(): ILogger {
    this.#logger ??= this.#parent.child({ trace_id: this.id });
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

  /**
   * Execute `response.json()` (a JSON value, with an optional `stringify`)
   * and set `done`
   */
  public async json<T = unknown>(
    data: T,
    stringify?: (data: T) => string,
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

  /** Execute `response.sendFile()` (see `ISendFileOptions`) and set `done` */
  public async sendFile(
    path: URL | string,
    options?: ISendFileOptions,
  ): Promise<void> {
    await this.#reply(async () => {
      await (typeof options === "undefined"
        ? this.response.sendFile(path)
        : this.response.sendFile(path, options));
    });
  }

  /**
   * Execute `response.redirect()` (`302 Found` by default, to the same
   * origin unless `allow_external`) and set `done`
   */
  public async redirect(
    location: URL | string,
    status?: IRedirectStatus,
    options?: IRedirectOptions,
  ): Promise<void> {
    await this.#reply(async () => {
      await (typeof options === "undefined"
        ? this.response.redirect(location, status)
        : this.response.redirect(location, status, options));
    });
  }

  /** Execute `response.attachment()`: the response is saved as a file */
  public attachment(filename?: string): this {
    this.response.attachment(filename);
    return this;
  }

  /** Execute `response.type()`: set the `Content-Type` */
  public type(media_type: string): this {
    this.response.type(media_type);
    return this;
  }

  /** Execute `response.vary()`: add request headers to `Vary` */
  public vary(...fields: string[]): this {
    this.response.vary(...fields);
    return this;
  }

  /** Execute `response.clearCookie()`: remove a cookie from the client */
  public clearCookie(name: string, attributes?: IClearCookie): this {
    this.response.clearCookie(name, attributes);
    return this;
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
    } else if (this.response.started) {
      // E.g. a second `send()`: the response is not sent again
      this.log.warn("The response has already been started");
    }
    await send();
    this.done = true;
  }
}
