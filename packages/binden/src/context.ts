import { BindenError, type IBindenErrorOptions } from "./error.js";
import type {
  BindenResponse,
  IClearCookie,
  IHeadersValue,
} from "./response.js";
import { Exchange, type IExchangeReport, formatStack } from "./exchange.js";
import type { IRedirectOptions, IRedirectStatus } from "./redirect.js";
import { brandContexts, isRequest, isResponse } from "./brands.js";
import { childLogger, defaultLogger, logTo, safe, snapshot } from "./logger.js";
import { described, formatting, objectOf } from "./formatting.js";
import type { BindenRequest } from "./request.js";
import type { ILogger } from "@binden/logger";
import type { ISendFileOptions } from "./send-file.js";
import type { IStreamLike } from "./stream-like.js";
import type { Readable } from "node:stream";

/** The request and the response that a context handles */
export interface IBaseContext {
  /** The request being handled */
  readonly request: BindenRequest;
  /** The response to the request */
  readonly response: BindenResponse<BindenRequest>;
}

/**
 * The options of a `Context`: its request and response, and what the
 * application sets up for them
 */
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

/** The parameters of the matched patterns, by name (see `context.params`) */
export type IParams = Record<string, string>;

/**
 * What a middleware handles: a request and its response, with the state, the
 * parameters, the logger, the abort signal and the deadline of the request, and
 * helpers to reply. Every context of a request shares them (a middleware may
 * return a new one).
 */
export class Context<
  State extends object = Record<string, unknown>,
  Params extends IParams = IParams,
> implements IBaseContext {
  readonly #request: BindenRequest;
  readonly #response: BindenResponse<BindenRequest>;
  readonly #parent: ILogger;
  readonly #exchange: Exchange;
  #logger?: ILogger;

  static {
    // A context made by the constructor (see `isContext()`)
    brandContexts((value) => #request in value);
  }

  /**
   * A context of a request and its response: the first one of the request
   * creates what the contexts share (a `TypeError` for a response that is not
   * the one of the request, and for options that are not an object). Its
   * request is a `BindenRequest` and its response a `BindenResponse`, each an
   * instance made by its constructor (or the one of a subclass), told by its
   * private brand: never a proxy of one (whose traps would run later, e.g.
   * once the response is closed), an object of another realm or one made with
   * `Object.create()` of its prototype. Its `report` is a function: anything
   * else throws a `TypeError` that describes it. What reading the options
   * throws (e.g. a revoked proxy) is formatted (see `formatting()`).
   */
  public constructor(options: IContextOptions) {
    // Each option is read once (e.g. by a getter)
    const given = formatting(() => {
      const read = objectOf(options, "options") as IContextOptions;
      return {
        request: read.request,
        response: read.response,
        logger: read.logger,
        state: read.state,
        report: read.report,
      };
    });
    this.#request = given.request;
    this.#response = given.response;
    // Wrapped unless it is a logger of binden, told by its brand (see
    // `safe()`): no code of the logger runs
    this.#parent = formatting(() => safe(given.logger ?? defaultLogger()));
    Context.#check(given);
    this.#exchange = formatting(() =>
      Exchange.for(given.request, given.response, {
        state: given.state,
        report:
          given.report ??
          ((message, error): void => {
            const logged = { location: "cleanup", details: false } as const;
            logTo(this, "error", message, { failure: snapshot(error, logged) });
          }),
      }),
    );
  }

  /**
   * Checks the request, the response and `report` of the options, by their
   * brands and types, without running code of the application (see
   * `isRequest()`)
   */
  static #check({ request, response, report }: IContextOptions): void {
    let refusal: string | null = null;
    if (!isRequest(request)) {
      refusal = `\`request\` is not a BindenRequest: ${described(request)}`;
    } else if (!isResponse(response)) {
      refusal = `\`response\` is not a BindenResponse: ${described(response)}`;
    } else if (typeof report !== "undefined" && typeof report !== "function") {
      refusal = `\`report\` is not a function: ${described(report)}`;
    }
    if (refusal !== null) {
      throw formatStack(new TypeError(refusal));
    }
  }

  /**
   * A child of the logger with the `trace_id` of the context, created when it
   * is first used: a new logger of binden. Its calls never fail (e.g. a
   * custom logger that throws, or whose `child()` throws, is ignored, and its
   * rejected promises observed): logging never prevents the request from
   * being handled. The framework writes its own records by its private path,
   * never through the methods that the application may replace on it.
   */
  public get log(): ILogger {
    // By the private path of its parent (see `childLogger()`): never a
    // `child()` that the application has replaced on it
    this.#logger ??= childLogger(this.#parent, { trace_id: this.id });
    return this.#logger;
  }

  /** Execute `response.setHeader()`: set a header of the response */
  public setHeader(name: string, value: IHeadersValue): this {
    this.response.setHeader(name, value);
    return this;
  }

  /** Execute `response.status()`: set the status code of the response */
  public status(code: number): this {
    this.response.status(code);
    return this;
  }

  /** The request being handled */
  public get request(): BindenRequest {
    return this.#request;
  }

  /** The response to the request */
  public get response(): BindenResponse<BindenRequest> {
    return this.#response;
  }

  /** The id of the request (see `request.id`): the `trace_id` of `log` */
  public get id(): string {
    return this.request.id;
  }

  /** Set once the request is handled: shared by every context of the request */
  public get done(): boolean {
    return this.#exchange.done;
  }

  /** Marks the request as handled (it cannot be unset): the stack stops then */
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
   * has passed, `signal` is aborted with the `deadline` reason. A work that
   * may no longer reply (e.g. an abandoned middleware) changes nothing.
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

  /**
   * The URL of the request (see `request.URL`): a `BindenError` (400) when the
   * request-target or its host is invalid
   */
  public get url(): URL {
    return this.request.URL;
  }

  /** Execute `response.send()` (see `IStreamLike`) and set `done` */
  public async send(
    data?:
      Buffer | IStreamLike | Readable | Uint8Array | bigint | number | string,
  ): Promise<void> {
    // Also once it is late: the response ignores it then, but releases a
    // Node.js `Readable` (e.g. a stream of a file, which would stay open)
    await this.#reply(() => this.response.send(data), true);
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

  /** Execute `response.text()` (`text/plain; charset=utf-8`) and set `done` */
  public async text(data: string): Promise<void> {
    await this.#reply(() => this.response.text(data));
  }

  /** Execute `response.html()` (`text/html; charset=utf-8`) and set `done` */
  public async html(data: string): Promise<void> {
    await this.#reply(() => this.response.html(data));
  }

  /**
   * Execute `response.form()` (`application/x-www-form-urlencoded`) and set
   * `done`
   */
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

  /**
   * Throws a `BindenError` of the status and the options, which the error
   * handler replies with
   *
   * @throws {BindenError} always (or the `TypeError`/`RangeError` of an invalid
   * status)
   */
  // eslint-disable-next-line class-methods-use-this
  public throw(status: number, opts?: IBindenErrorOptions): never {
    throw new BindenError(status, opts);
  }

  /**
   * Sends a reply and sets `done`, unless the framework has taken over the
   * reply (e.g. the deadline has passed): a late reply is then ignored, and
   * `send` runs only when it is `late` too (the response ignores it as well)
   */
  async #reply(send: () => Promise<void>, late = false): Promise<void> {
    if (!this.#exchange.may_reply) {
      logTo(this, "debug", "A late reply has been ignored");
      if (late) {
        await send();
      }
      return;
    } else if (this.response.started) {
      // E.g. a second `send()`: the response is not sent again
      logTo(this, "warn", "The response has already been started");
    }
    await send();
    this.done = true;
  }
}
