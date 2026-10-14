import http from "node:http";
import https from "node:https";
import type { ILogger } from "@binden/logger";
import { Context } from "./context.js";
import { BindenError } from "./error.js";
import { validateDelay } from "./delay.js";
import { BindenAbortError, Exchange } from "./exchange.js";
import {
  defaultLogger,
  type ILocation,
  isLogger,
  safe,
  snapshot,
} from "./logger.js";
import { Middleware, type IMiddleware } from "./middleware.js";
import { pathOf, property } from "./property.js";
import {
  BindenRequest,
  type IRequestOptions,
  type IRequestOptionsInput,
  validateRequestOptions,
} from "./request.js";
import {
  BindenResponse,
  ct_json,
  type IResponseOptions,
  validateResponseOptions,
} from "./response.js";
import {
  type IMatchOptions,
  matchPrefix,
  matchRoute,
  type IRoutingOptions,
} from "./route.js";
import { Router } from "./router.js";
import { kSeal } from "./seal.js";
import { isClosing, register, track } from "./shutdown.js";
import { type ILayer, layersOf, markRoot, Stack } from "./stack.js";

/**
 * The status of the reply to an error without a valid status of its own (and
 * to a failed or late error handler): `500 Internal Server Error`
 */
export const DefaultErrorCode = 500;

/** Replaces the default reply to an error (see `IBindenOptions.error_handler`) */
export type IErrorHandler<State extends object = Record<string, unknown>> = (
  context: Context<State>,
  error: unknown,
) => Promise<void> | void;

/** The options of the access log (see `IBindenBaseOptions.access_log`) */
export interface IAccessLogOptions {
  /** The level of its records (`info`) */
  level?: "debug" | "info" | undefined;
  /**
   * `template` (the default) logs the route only; `path` adds the path of the
   * request (without its query), which may name a user or a resource
   */
  path?: "path" | "template" | undefined;
}

/** The options of the access log, with their defaults */
interface IAccessLog {
  readonly level: "debug" | "info";
  readonly path: "path" | "template";
}

/**
 * The options of `Binden`, but its `state`: with the options of its requests
 * (`trust_proxy`, `allowed_hosts`, `request_id`, `encoded_slashes` and
 * `query`, see `IRequestOptionsInput`) and of its responses (`etag`)
 */
export interface IBindenBaseOptions<
  State extends object = Record<string, unknown>,
> extends IRequestOptionsInput {
  /**
   * Whether a router without `HEAD` middlewares handles `HEAD` with its `GET`
   * middlewares (`true`)
   */
  auto_head?: boolean | undefined;
  /** Replaces the default reply to an error, unless it does not reply itself */
  error_handler?: IErrorHandler<State> | undefined;
  /**
   * The time in milliseconds that the `error_handler` has to settle (`5000`):
   * a handler that takes longer, throws or rejects gets an empty
   * `500 Internal Server Error` instead (or the connection is closed, once
   * the reply has started)
   */
  error_handler_timeout?: number | undefined;
  /**
   * The deadline of every request in milliseconds (`0`, the default, for
   * none): once it has passed, `context.signal` is aborted, the stack stops
   * and a `503 Service Unavailable` error (`code: "deadline"`) is replied (or
   * the connection is closed, once the reply has started). A middleware may
   * change it with `context.setTimeout()`.
   */
  timeout?: number | undefined;
  /** The logger of the contexts (the default one is set up by `BINDEN_LOG_LEVEL`) */
  logger?: ILogger | undefined;
  /**
   * Whether the errors that the framework logs include their message, stack,
   * cause and any `code` (`false`): they may quote the input of a request
   */
  log_error_details?: boolean | undefined;
  /** The matching of the patterns of `route()` and `mount()` */
  routing?: IRoutingOptions | undefined;
  /**
   * Whether every request is logged once its response is closed (`false`):
   * `true` or the options of the access log
   */
  access_log?: IAccessLogOptions | boolean | undefined;
  /**
   * A strong `ETag` (the SHA-256 of the body) for the `200` responses to `GET`
   * and `HEAD` sent from a `Buffer` or a string, and `304 Not Modified` when
   * `If-None-Match` matches it (`false`, see `IResponseOptions`)
   */
  etag?: boolean | undefined;
}

/**
 * The options of `Binden`: `state` creates the state of every request (an
 * empty object by default), and is required when the state has required fields
 */
export type IBindenOptions<State extends object = Record<string, unknown>> =
  IBindenBaseOptions<State> &
    (Record<never, never> extends State
      ? {
          /** Creates the state of every request (an empty object by default) */
          state?: (() => State) | undefined;
        }
      : {
          /** Creates the state of every request: it has required fields */
          state: () => State;
        });

/** Thrown through the stack once the request has been aborted: the stack stops */
const ABORTED = new Error("The request has been aborted");

/** The outcome of an `error_handler` that has not settled in time */
const EXPIRED = Symbol("expired");

/** The context of a request, which a middleware may replace */
interface IRun {
  context: Context;
}

/** The methods of the guarded routers that have refused a request */
type IAllow = Set<string>;

/** A level of the routing that a matching layer enters */
interface ILevel {
  readonly params: Readonly<Record<string, string>>;
  /** The matched prefix of a mount, as received */
  readonly prefix: string;
  /** The matched prefix of a mount, as registered */
  readonly template: string;
  /** The rest of the path, which the items of a mount see */
  readonly rest: string;
  /** The template of the layer that the access log names (`""` for none) */
  readonly route: string;
}

/**
 * An application: the root stack, with the options that apply to every stack
 * mounted in it
 */
export class Binden<
  State extends object = Record<string, unknown>,
> extends Stack<State> {
  readonly #auto_head: boolean;
  readonly #error_handler: IErrorHandler | null;
  readonly #error_handler_timeout: number;
  readonly #timeout: number;
  readonly #logger: ILogger;
  readonly #details: boolean;
  readonly #access: IAccessLog | null;
  readonly #routing: Required<IMatchOptions>;
  readonly #state: (() => object) | null;
  readonly #Request: typeof BindenRequest;
  readonly #Response: typeof BindenResponse;
  readonly #request_id: IRequestOptions["request_id"];

  /**
   * An application with its options (see `IBindenOptions`), checked: an
   * invalid one throws a `TypeError` (or a `RangeError` for a value out of
   * its range, e.g. a negative `timeout`)
   */
  public constructor(
    ...[options = {} as IBindenOptions<State>]: Record<
      never,
      never
    > extends State
      ? [options?: IBindenOptions<State>]
      : [options: IBindenOptions<State>]
  ) {
    super();
    const {
      error_handler,
      error_handler_timeout = 5000,
      auto_head = true,
      logger,
      log_error_details = false,
      access_log = false,
      routing = {},
      state,
      timeout = 0,
      trust_proxy,
      encoded_slashes,
      allowed_hosts,
      request_id,
      query,
      etag,
    } = options;
    // Checked once: the requests and the responses of the application share them
    const requests = validateRequestOptions({
      trust_proxy,
      encoded_slashes,
      allowed_hosts,
      request_id,
      query,
    });
    const responses = validateResponseOptions({ etag });
    validateDelay("timeout", timeout, 0);
    validateDelay("error_handler_timeout", error_handler_timeout, 1);
    Binden.#boolean("auto_head", auto_head);
    Binden.#boolean("log_error_details", log_error_details);
    if (typeof logger !== "undefined" && !isLogger(logger)) {
      throw new TypeError("`logger` is not a logger");
    }
    if (
      typeof error_handler !== "undefined" &&
      typeof error_handler !== "function"
    ) {
      throw new TypeError("`error_handler` is not a function");
    } else if (typeof state !== "undefined" && typeof state !== "function") {
      throw new TypeError("`state` is not a function");
    } else if (typeof routing !== "object" || (routing as unknown) === null) {
      throw new TypeError("`routing` is not an object");
    }
    const { case_sensitive = true, strict = true } = routing;
    this.#access = Binden.#accessOptions(access_log);
    Binden.#boolean("routing.case_sensitive", case_sensitive);
    Binden.#boolean("routing.strict", strict);
    markRoot(this);
    this.#error_handler =
      (error_handler as unknown as IErrorHandler | undefined) ?? null;
    this.#error_handler_timeout = error_handler_timeout;
    this.#timeout = timeout;
    this.#auto_head = auto_head;
    this.#logger = safe(logger ?? defaultLogger());
    this.#details = log_error_details;
    this.#routing = {
      case_sensitive,
      strict,
      encoded_slashes: requests.encoded_slashes,
    };
    this.#state = state ?? null;
    this.#request_id = requests.request_id;
    // The requests and the responses of this application, with its options
    this.#Request = class extends BindenRequest {
      // eslint-disable-next-line class-methods-use-this -- the options of the app
      protected override get options(): IRequestOptions {
        return requests;
      }
    };
    this.#Response = class<
      Request extends http.IncomingMessage = http.IncomingMessage,
    > extends BindenResponse<Request> {
      // eslint-disable-next-line class-methods-use-this -- the options of the app
      protected override get options(): IResponseOptions {
        return responses;
      }
    };
  }

  /**
   * Creates an HTTP server that handles its requests with the application
   * (registered for `shutdown()`)
   */
  public createServer(
    options: Omit<
      http.ServerOptions,
      "IncomingMessage" | "ServerResponse"
    > = {},
  ): http.Server<typeof BindenRequest, typeof BindenResponse> {
    const server = http.createServer({ ...options, ...this.serverOptions() });
    server.on("request", this.callback(server));
    return server;
  }

  /**
   * Creates an HTTPS server that handles its requests with the application
   * (registered for `shutdown()`)
   */
  public createSecureServer(
    options: Omit<
      https.ServerOptions,
      "IncomingMessage" | "ServerResponse"
    > = {},
  ): https.Server<typeof BindenRequest, typeof BindenResponse> {
    const server = https.createServer({ ...options, ...this.serverOptions() });
    server.on("request", this.callback(server));
    return server;
  }

  /**
   * The request and response classes of the application, for a server that
   * `callback()` handles the requests of (e.g. `http2` is not supported)
   */
  public serverOptions(): {
    /** The request class of the application (with its request options) */
    IncomingMessage: typeof BindenRequest;
    /** The response class of the application (with its response options) */
    ServerResponse: typeof BindenResponse;
  } {
    return { IncomingMessage: this.#Request, ServerResponse: this.#Response };
  }

  /**
   * The request listener of a server created with `serverOptions()`, which
   * is registered for `shutdown()` at once. A request of another kind (e.g. of
   * a server created without them) is logged, and its connection closed.
   */
  public callback(
    server: http.Server | https.Server,
  ): (request: http.IncomingMessage, response: http.ServerResponse) => void {
    register(server, (message, error) => {
      this.#logger.error(message, {
        failure: snapshot(error, {
          location: "shutdown",
          details: this.#details,
        }),
      });
    });
    return (request, response): void => {
      if (
        !(request instanceof this.#Request) ||
        !(response instanceof this.#Response)
      ) {
        const message =
          "The request and the response are not those of the application (`serverOptions()`)";
        this.#logger.error(message);
        request.socket.destroy();
        return;
      }
      this.#requestListener(
        server,
        request,
        response as BindenResponse<BindenRequest>,
      );
    };
  }

  #requestListener(
    server: http.Server | https.Server,
    request: BindenRequest,
    response: BindenResponse<BindenRequest>,
  ): void {
    const { state, failure } = this.#createState();
    const context = new Context({
      request,
      response,
      state,
      logger: this.#logger,
      report: (message, error): void => {
        context.log.error(message, this.#failure(context, error, "cleanup"));
      },
    });
    const exchange = Exchange.for(request, response);
    track(server, exchange, response);
    // Once the exchange is sealed (e.g. after the deadline), the sends of
    // the response (`send()`, `json()`, `redirect()`, `sendFile()`, …) do
    // nothing, but those of the reply of the framework
    response[kSeal](() => !exchange.may_reply);
    if (this.#request_id?.echo === true) {
      // Every reply sends it back, also the error replies of the framework
      response.setHeader(this.#request_id.header, request.id);
    }
    if (this.#access) {
      Binden.#accessLog(context, exchange, this.#access);
    }
    if (this.#timeout > 0) {
      exchange.setTimeout(this.#timeout);
    }
    // A request on a connection that was open once the server is closing
    // gets 503: the stack does not run
    const handled = isClosing(server)
      ? this.#closing(context)
      : this.#run(context, exchange, failure);
    handled.catch((error: unknown) => {
      // Unexpected (every failure is handled): the process must not crash
      const message = "The request has failed";
      context.log.error(message, this.#failure(context, error, "send"));
      response.destroy();
    });
  }

  /**
   * Runs the stack, then the error handler on a failure or a deadline. A
   * deadline that passes later (e.g. while a stream is sent) closes the
   * connection of a response that has not finished.
   */
  async #run(
    first: Context,
    exchange: Exchange,
    initial: { error: unknown } | null,
  ): Promise<void> {
    const run: IRun = { context: first };
    let failure = initial;
    let stopped = false;
    try {
      if (failure === null) {
        await this.#handle(run, exchange);
      }
    } catch (error: unknown) {
      if (error === ABORTED) {
        stopped = true;
      } else {
        failure = { error };
      }
    }

    const { context } = run;
    const { signal } = exchange;
    if (stopped || (failure && signal.aborted)) {
      // A failure once aborted is a consequence (e.g. of the client going away)
      await this.#aborted(context, exchange);
      return;
    } else if (failure) {
      await this.#errorHandler(context, exchange, failure.error);
    }

    if (!signal.aborted) {
      signal.addEventListener(
        "abort",
        () => {
          const { reason } = signal as { reason: BindenAbortError };
          if (
            reason.reason === "deadline" &&
            !context.response.writableFinished
          ) {
            const message = "The deadline has passed. Destroying the socket";
            context.log.debug(message);
            context.response.destroy();
          }
        },
        { once: true },
      );
    }
  }

  /**
   * Routes the request through the stack: `404 Not Found` when nothing has
   * handled it, or `405 Method Not Allowed` when only guarded routers have
   * refused its method (or `204` with the allowed methods for `OPTIONS`)
   */
  async #handle(run: IRun, exchange: Exchange): Promise<void> {
    const { pathname } = run.context.url;
    const allow: IAllow = new Set<string>();

    if (await this.#walk(this, run, exchange, pathname, [], allow)) {
      return;
    }

    // Nothing has handled the request, unless a middleware has started (or ended)
    // the response without setting `done`: it is left to finish
    const { request, response } = run.context;
    if (response.started) {
      return;
    } else if (allow.size) {
      allow.add("OPTIONS");
      const methods = [...allow].join(", ");
      if (request.method === "OPTIONS") {
        response.status(204).setHeader("Allow", methods);
        await response.send();
        return;
      }
      throw new BindenError(405, { headers: { Allow: methods } });
    }
    throw new BindenError(404);
  }

  /**
   * Runs the layers of a stack that match the path (the rest of the path
   * at a mounted level): `true` once a middleware has set `done`. A stack that
   * is already being run (mounted in itself) fails the request.
   */
  async #walk(
    stack: object,
    run: IRun,
    exchange: Exchange,
    path: string,
    chain: object[],
    allow: IAllow,
  ): Promise<boolean> {
    if (chain.includes(stack)) {
      throw new Error("A stack is mounted in itself");
    }
    chain.push(stack);

    for (const layer of layersOf(stack)) {
      const level = this.#match(layer, path);
      if (
        level !== null &&
        (await this.#layer(layer, level, run, exchange, chain, allow))
      ) {
        return true;
      }
    }

    chain.pop();
    return false;
  }

  /** Runs the items of a layer that matches: `true` once one has set `done` */
  async #layer(
    layer: ILayer,
    level: ILevel,
    run: IRun,
    exchange: Exchange,
    chain: object[],
    allow: IAllow,
  ): Promise<boolean> {
    const leave = exchange.enter(level);
    let { context } = run;
    for (const item of layer.items) {
      if (item instanceof Stack) {
        if (await this.#walk(item, run, exchange, level.rest, chain, allow)) {
          return true;
        }
        // A middleware of the mounted stack may have replaced the context
        ({ context } = run);
      } else {
        const middlewares =
          item instanceof Router ? this.#methodOf(item, run, allow) : [item];
        for (const middleware of middlewares) {
          // The route of the access log: the template of the latest layer
          // that has run a middleware
          const route = exchange.mount_template + level.route;
          if (route !== "") {
            exchange.route = route;
          }
          context = await this.#runMiddleware(middleware, context, exchange);
          run.context = context;
          if (context.done) {
            await Binden.#complete(context);
            return true;
          }
        }
      }
    }
    // Back to the level of the stack
    leave();
    return false;
  }

  /**
   * The level that a layer of the stack enters for a path (its parameters,
   * and the prefix and the rest of the path of a mount), or `null`
   */
  #match(layer: ILayer, path: string): ILevel | null {
    const none = {
      params: {},
      prefix: "",
      template: "",
      rest: path,
      route: "",
    };
    if (layer.kind === "use") {
      const { path: match } = layer;
      return match === null ||
        (match instanceof RegExp ? match.test(path) : match === path)
        ? { ...none, route: match === null ? "" : String(match) }
        : null;
    } else if (layer.kind === "route") {
      const params = matchRoute(layer.pattern, path, this.#routing);
      return params === null
        ? null
        : { ...none, params, route: layer.pattern.source };
    }
    const { pattern } = layer;
    const match = matchPrefix(pattern, path, this.#routing);
    return match === null
      ? null
      : { ...match, template: pattern.source, route: "" };
  }

  /**
   * The middlewares of a router for the method of the request: `HEAD` is
   * handled by the `GET` middlewares, unless it has its own, and a guarded
   * router that does not allow the method (an `OPTIONS` that it has no
   * middlewares for among them) refuses the request, which another one may
   * handle
   */
  #methodOf(router: Router, run: IRun, allow: IAllow): IMiddleware[] {
    const { guarded, middlewares, methods } = router;
    const { method = "GET" } = run.context.request;
    const head = methods.has("HEAD");

    if (guarded && methods.size) {
      if (methods.has("GET") && this.#auto_head) {
        methods.add("HEAD");
      }
      if (!methods.has(method)) {
        for (const allowed of methods) {
          allow.add(allowed);
        }
        return [];
      }
    }

    return middlewares(
      method === "HEAD" && this.#auto_head && !head ? "GET" : method,
    );
  }

  /**
   * The request has been aborted while the stack ran (the stack has stopped):
   * after the deadline, a `503` error is replied through the error handler
   * when nothing has started, and the connection is closed otherwise; a client
   * that has gone away (or a shutdown) gets nothing
   */
  async #aborted(context: Context, exchange: Exchange): Promise<void> {
    const { response } = context;
    const { reason } = exchange.signal as { reason: BindenAbortError };
    if (reason.reason === "deadline" && !response.started) {
      // The middlewares that still run may no longer reply
      exchange.seal();
      const error = new BindenError(503, { code: "deadline" });
      await exchange.reply(async () => {
        await this.#errorHandler(context, exchange, error);
      });
      return;
    }
    if (!response.writableFinished) {
      const message = "The request has been aborted. Destroying the socket";
      context.log.debug(message, { reason: reason.reason });
      response.destroy();
    }
  }

  /** A middleware has set `done`: a response that nothing has started is sent empty */
  static async #complete(context: Context): Promise<void> {
    if (!context.response.started) {
      context.log.warn("`done` without a response");
      await context.response.send();
    }
  }

  /** What the framework logs of an error (see `log_error_details`) */
  #failure(
    context: Context,
    error: unknown,
    location: ILocation,
    status?: number,
  ): { failure: Record<string, unknown> } {
    return {
      failure: snapshot(error, {
        location,
        request_id: context.id,
        details: this.#details,
        status,
      }),
    };
  }

  /**
   * Error handler: the provided `error_handler` (awaited within
   * `error_handler_timeout`), then the default reply if needed
   */
  async #errorHandler(
    context: Context,
    exchange: Exchange,
    error: unknown,
  ): Promise<void> {
    if (this.#error_handler) {
      const message = "Passing error to the provided `error_handler`";
      context.log.trace(message, this.#failure(context, error, "middleware"));

      const outcome = await this.#bounded(this.#error_handler, context, error);

      const { response } = context;
      if (outcome !== null) {
        // The handler has failed, or has not settled in time: it may no
        // longer reply, and the request gets an opaque error
        exchange.seal();
        if (outcome === EXPIRED) {
          const late = "The provided `error_handler` has not settled in time";
          context.log.error(
            late,
            this.#failure(context, error, "error_handler"),
          );
        } else {
          const failed = "The provided `error_handler` has failed";
          const extra = this.#failure(context, outcome.error, "error_handler");
          context.log.error(failed, extra);
        }
        if (response.started) {
          response.destroy();
        } else {
          await exchange.reply(async () => this.#opaque(context));
        }
        return;
      } else if (response.writableEnded) {
        return;
      } else if (response.started) {
        // A reply that is not ended once the handler has settled (e.g. a
        // `write()` without `end()`) would leave the client waiting
        const unfinished =
          "The provided `error_handler` has not ended its reply. Destroying the socket";
        context.log.warn(
          unfinished,
          this.#failure(context, error, "error_handler"),
        );
        response.destroy();
        return;
      }
      const ignored = "The provided `error_handler` has not replied";
      context.log.debug(
        ignored,
        this.#failure(context, error, "error_handler"),
      );
    }
    await this.#defaultErrorHandler(context, error);
  }

  /**
   * Awaits the `error_handler` for `error_handler_timeout` at most: `null`
   * once it has settled, `EXPIRED` once the time has passed (its result is
   * then ignored, and a later failure logged) and its error once it has failed
   */
  async #bounded(
    handler: (context: Context, error: unknown) => Promise<void> | void,
    context: Context,
    error: unknown,
  ): Promise<typeof EXPIRED | { error: unknown } | null> {
    let expired = false;
    const settled = (async (): Promise<void> => {
      await handler(context, error);
    })().then(
      () => null,
      (failure: unknown) => {
        if (expired) {
          const late = "The provided `error_handler` has failed late";
          context.log.debug(
            late,
            this.#failure(context, failure, "error_handler"),
          );
        }
        return { error: failure };
      },
    );
    const { promise: timeout, resolve } =
      Promise.withResolvers<typeof EXPIRED>();
    const timer = setTimeout(resolve, this.#error_handler_timeout, EXPIRED);
    timer.unref();
    const outcome = await Promise.race([settled, timeout]);
    clearTimeout(timer);
    expired = outcome === EXPIRED;
    return outcome;
  }

  /**
   * An empty `500 Internal Server Error`, without the headers of the body that
   * a failed handler may have set
   */
  async #opaque(context: Context): Promise<void> {
    const { response } = context;
    for (const name of [...Binden.#representation, "Content-Type"]) {
      response.removeHeader(name);
    }
    await this.#empty(context, DefaultErrorCode);
  }

  /** `503 Service Unavailable` to a request that arrives once closing */
  async #closing(context: Context): Promise<void> {
    context.response.setHeader("Connection", "close");
    await this.#empty(context, 503);
  }

  /** An empty reply of the framework (a failure to send it is logged) */
  async #empty(context: Context, status: number): Promise<void> {
    context.response.status(status);
    try {
      await context.response.send();
    } catch (error: unknown) {
      const message = "The error reply has not been sent";
      context.log.debug(message, this.#failure(context, error, "send"));
    }
  }

  /**
   * Default reply to an error, which may be any thrown value: its properties
   * are read without trusting them (e.g. `throw null`, or a throwing getter).
   * Its status is the `status` of the error (an integer from 400 to 599, or
   * `500`), with the `headers` of a `BindenError`; a server error (5xx) is
   * logged at `error`, a client one at `debug`.
   */
  async #defaultErrorHandler(context: Context, error: unknown): Promise<void> {
    const { response } = context;
    const raw = property(error, "status");
    const status =
      Number.isInteger(raw) && Number(raw) >= 400 && Number(raw) <= 599
        ? Number(raw)
        : DefaultErrorCode;
    const extra = this.#failure(context, error, "middleware", status);
    const level = status >= 500 ? "error" : "debug";
    if (response.writableEnded) {
      // Sent (or being sent): destroying the socket would cut it
      const ended = "The request has failed once its response was ended";
      context.log[level](ended, extra);
      return;
    } else if (response.started) {
      // Part of the body may be sent (or compressed): ending the response would
      // make a truncated body look complete
      const started =
        "The request has failed once its response was started. Destroying the socket";
      context.log[level](started, extra);
      response.destroy();
      return;
    }
    context.log[level]("The request has failed", extra);

    // The framing and representation of the body that is not sent
    for (const name of Binden.#representation) {
      response.removeHeader(name);
    }
    response.status(status);
    if (error instanceof BindenError) {
      response.set(error.headers);
    }

    // Sent like any other response: with its cookies, framed by its status
    const reply = (): Promise<void> => {
      const expose = Boolean(property(error, "expose"));
      const json = property(error, "json");
      const message = property(error, "message");
      if (!expose) {
        return response.send();
      } else if (typeof json === "object" && json !== null) {
        try {
          const body = JSON.stringify(json);
          return response.setHeader("Content-Type", ct_json).send(body);
        } catch {
          context.log.warn("`JSON.stringify` failed", extra);
          return response.send();
        }
      } else if (typeof message !== "string" || !message) {
        context.log.debug("`message` is not a valid string", extra);
        return response.send();
      }
      return response.send(message);
    };

    try {
      await reply();
    } catch (failure: unknown) {
      // E.g. the client went away
      const message = "The error reply has not been sent";
      context.log.debug(message, this.#failure(context, failure, "send"));
    }
  }

  async #runMiddleware(
    middleware: IMiddleware,
    context: Context,
    exchange: Exchange,
  ): Promise<Context> {
    const { name } = middleware.constructor;

    if (middleware instanceof Middleware && middleware.disabled) {
      context.log.debug("Middleware is disabled", { middleware: name });
      return context;
    }

    try {
      const result =
        typeof middleware === "function"
          ? middleware(context)
          : middleware.run(context);
      const next =
        typeof property(result, "then") === "function"
          ? await this.#race(result, context, exchange)
          : result;
      if (!(next instanceof Context)) {
        return context;
      } else if (
        next.request !== context.request ||
        next.response !== context.response
      ) {
        // E.g. a context kept from a previous request: its response is not
        // the one to reply with
        throw new TypeError(
          "A middleware returned the context of another request",
        );
      }
      return next;
    } catch (error: unknown) {
      if (error === ABORTED) {
        throw error;
      } else if (middleware instanceof Middleware && middleware.ignore_errors) {
        context.log.debug("Middleware ignores errors", {
          middleware: name,
          ...this.#failure(context, error, "middleware"),
        });
        return context;
      }

      throw error;
    }
  }

  /**
   * The result of a middleware, unless the request is aborted first: its late
   * result is then ignored (and a late failure logged)
   */
  async #race(
    result: unknown,
    context: Context,
    exchange: Exchange,
  ): Promise<unknown> {
    const settled = Promise.resolve(result).then(
      (value: unknown) => ({ ok: true, value }) as const,
      (error: unknown) => {
        if (exchange.signal.aborted) {
          const message =
            "A middleware has failed after the request was aborted";
          context.log.debug(
            message,
            this.#failure(context, error, "middleware"),
          );
        }
        return { ok: false, error } as const;
      },
    );
    const outcome = await Promise.race([
      settled,
      exchange.aborted.then(() => null),
    ]);
    if (outcome === null) {
      throw ABORTED;
    } else if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.value;
  }

  /** The headers of a body, which do not apply to an error that replaces it */
  static readonly #representation = [
    "Content-Disposition",
    "Content-Encoding",
    "Content-Length",
    "Content-Range",
    "ETag",
    "Last-Modified",
    "Transfer-Encoding",
  ];

  /**
   * The state of a request, from the `state` option: a factory that fails (or
   * that does not return an object) fails the request
   */
  #createState(): { state: object; failure: { error: unknown } | null } {
    if (!this.#state) {
      return { state: {}, failure: null };
    }
    try {
      const state: unknown = this.#state();
      if (typeof state !== "object" || state === null) {
        throw new TypeError("The state of the request is not an object");
      }
      return { state, failure: null };
    } catch (error: unknown) {
      return { state: {}, failure: { error } };
    }
  }

  /** The options of the access log, or `null` when it is off */
  static #accessOptions(option: unknown): IAccessLog | null {
    if (option === false) {
      return null;
    } else if (option === true) {
      return { level: "info", path: "template" };
    } else if (typeof option !== "object" || option === null) {
      throw new TypeError("`access_log` is not a boolean or an object");
    }
    const { level = "info", path = "template" } = option as Record<
      string,
      unknown
    >;
    if (level !== "info" && level !== "debug") {
      throw new TypeError("`access_log.level` is not `info` or `debug`");
    } else if (path !== "template" && path !== "path") {
      throw new TypeError("`access_log.path` is not `template` or `path`");
    }
    return { level, path };
  }

  /**
   * Logs a request once its response is closed: its method, route (the
   * templates of the matched mounts and layer, or `<unmatched>`), status
   * (`null` when the headers have not been sent), duration, the bytes of the
   * body (as written, e.g. compressed), id and whether it has been aborted
   */
  static #accessLog(
    context: Context,
    exchange: Exchange,
    { level, path }: IAccessLog,
  ): void {
    const { request, response } = context;
    const start = performance.now();
    let bytes = 0;
    const count = (chunk: unknown, encoding: unknown): void => {
      const { statusCode } = response;
      if (
        request.method === "HEAD" ||
        statusCode < 200 ||
        statusCode === 204 ||
        statusCode === 304
      ) {
        // Node.js does not send a body
        return;
      } else if (typeof chunk === "string") {
        const coding = typeof encoding === "string" ? encoding : "utf8";
        bytes += Buffer.byteLength(chunk, coding as BufferEncoding);
      } else if (ArrayBuffer.isView(chunk)) {
        bytes += chunk.byteLength;
      }
    };
    // Replaced on the response itself, before any middleware (e.g. a
    // compression that writes the encoded body with them)
    const write = response.write.bind(response);
    const end = response.end.bind(response);
    response.write = ((...args: unknown[]): boolean => {
      count(args[0], args[1]);
      return Reflect.apply(write, response, args) as boolean;
    }) as typeof response.write;
    response.end = ((...args: unknown[]): typeof response => {
      count(args[0], args[1]);
      return Reflect.apply(end, response, args) as typeof response;
    }) as typeof response.end;

    response.once("close", () => {
      const duration = performance.now() - start;
      context.log[level]("The request has completed", {
        method: request.method,
        route: exchange.route ?? "<unmatched>",
        // A request of a server always has its request-target
        ...(path === "path" ? { path: pathOf(request.url as string) } : {}),
        status: response.headersSent ? response.statusCode : null,
        duration_ms: Math.round(duration * 1000) / 1000,
        body_bytes: bytes,
        id: context.id,
        aborted: exchange.signal.aborted,
      });
    });
  }

  /** A boolean option */
  static #boolean(name: string, value: unknown): void {
    if (typeof value !== "boolean") {
      throw new TypeError(`\`${name}\` is not a boolean`);
    }
  }
}

export default Binden;
