import { BindenAbortError, Exchange } from "./exchange.js";
import {
  BindenRequest,
  type IRequestOptions,
  type IRequestOptionsInput,
  validateRequestOptions,
} from "./request.js";
import {
  BindenResponse,
  type IResponseOptions,
  ct_json,
  ct_text,
  validateResponseOptions,
} from "./response.js";
import { type ILayer, Stack, layersOf, markRoot } from "./stack.js";
import {
  type ILocation,
  defaultLogger,
  isLogger,
  safe,
  snapshot,
} from "./logger.js";
import {
  type IMatchOptions,
  type IRoutingOptions,
  matchPrefix,
  matchRoute,
  split,
} from "./route.js";
import { type IMiddleware, Middleware } from "./middleware.js";
import {
  bodyHeaders,
  kCancel,
  kFramework,
  kListen,
  kOperation,
  kOwnership,
  kSeal,
  owners,
} from "./seal.js";
import { isClosing, register, track } from "./shutdown.js";
import { pathOf, property } from "./property.js";
import { BindenError } from "./error.js";
import { Context } from "./context.js";
import type { ILogger } from "@binden/logger";
import { Router } from "./router.js";
import http from "node:http";
import https from "node:https";
import { validateDelay } from "./delay.js";

/**
 * Creates the state of a request (see the `state` option of `Binden`),
 * synchronously: a promise (or any thenable) is not a state
 */
export type IStateFactory<State extends object> = () => State & {
  /** A state is not a promise: the factory is synchronous */
  readonly then?: never;
};

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
          state?: IStateFactory<State> | undefined;
        }
      : {
          /** Creates the state of every request: it has required fields */
          state: IStateFactory<State>;
        });

/** Thrown through the stack once the request has been aborted: the stack stops */
const ABORTED = new Error("The request has been aborted");

/** The route of the access log for the replies of the framework (e.g. `404`) */
const UNMATCHED = "<unmatched>";

/** The outcome of an `error_handler` that has not settled in time */
const EXPIRED = Symbol("expired");

/**
 * The outcome of an `error_handler` that was still running once the deadline
 * passed: the reply of the deadline has taken over (see `#deadline()`)
 */
const SUPERSEDED = Symbol("superseded");

/** The context of a request, which a middleware may replace */
interface IRun {
  context: Context;
}

/**
 * The works of a request that own its response (see `owners`): its
 * middleware stack, then the runs of its error handler
 */
interface IWorks {
  /** The token of the middleware stack */
  readonly stack: object;
  /** The tokens of the runs of the error handler */
  readonly handlers: Set<object>;
  /** What a failure of a pipe of a work does (see `IOwnership.fail()`), by its token */
  readonly failures: Map<object, (error: unknown) => void>;
  /** Whether the error handler has started: the outcome of the stack is decided */
  handled: boolean;
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
  /** The works of the requests (see `IWorks`), by their exchange */
  readonly #works = new WeakMap<Exchange, IWorks>();

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
    // Once the exchange is sealed (e.g. after the deadline), only the reply
    // of the framework mutates the response: the sends, writes, headers,
    // status and cookies of the abandoned work do nothing
    response[kSeal]((owner) => exchange.allows(owner));
    const works: IWorks = {
      stack: exchange.stack(),
      handlers: new Set(),
      failures: new Map(),
      handled: false,
    };
    this.#works.set(exchange, works);
    response[kOwnership]({
      fail: (owner, error): boolean => {
        const fail = works.failures.get(owner);
        if (typeof fail === "undefined") {
          // Not a work of this request
          return false;
        } else if (exchange.allows(owner)) {
          fail(error);
        }
        return true;
      },
      guards: (owner): boolean => works.handlers.has(owner),
      debug: (message, error): void => {
        context.log.debug(message, this.#failure(context, error, "send"));
      },
    });
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
      : this.#run(context, exchange, works, failure);
    handled.catch((error: unknown) => {
      // The process must not crash
      this.#unexpected(context, error);
    });
  }

  /**
   * Runs the stack, then the error handler on a failure or a deadline. A
   * deadline that passes later (e.g. while a stream is sent) cancels a send
   * whose headers are not committed and replies `503`, or closes the
   * connection of a response that has not finished.
   */
  async #run(
    first: Context,
    exchange: Exchange,
    works: IWorks,
    initial: { error: unknown } | null,
  ): Promise<void> {
    const run: IRun = { context: first };
    let failure = initial;
    // A pipe of the stack that fails (see `IOwnership.fail()`): the stack may
    // no longer mutate the response, and stops; its later result is ignored
    const outcome: { piped: { error: unknown } | null } = { piped: null };
    let running = true;
    const { promise: halted, resolve: halt } = Promise.withResolvers<null>();
    works.failures.set(works.stack, (error) => {
      if (works.handled) {
        // Its outcome is decided already: only its own work is abandoned
        exchange.revoke({ owner: works.stack, error });
        const message = "A pipe of the stack has failed once it had failed";
        const { context } = run;
        context.log.debug(message, this.#failure(context, error, "send"));
        return;
      }
      works.handled = true;
      exchange.seal({ owner: works.stack, error });
      exchange.halt();
      outcome.piped = { error };
      if (running) {
        halt(null);
      } else {
        const { context } = run;
        this.#pipeFailed(context, exchange, error).catch((unexpected) => {
          this.#unexpected(context, unexpected);
        });
      }
    });
    try {
      if (failure === null) {
        await Promise.race([
          owners.run(works.stack, () => this.#handle(run, exchange)),
          halted,
        ]);
      }
    } catch (error: unknown) {
      // Stopped (`ABORTED`): once aborted, or once a pipe has failed
      if (error !== ABORTED) {
        failure = { error };
      }
    }
    running = false;

    const { context } = run;
    const { signal } = exchange;
    const { piped } = outcome;
    if (signal.aborted) {
      // Stopped, or completed meanwhile: a failure once aborted is a
      // consequence (e.g. of the client going away), and a deadline that has
      // passed replies (its listener below would come too late)
      await this.#aborted(context, exchange);
      return;
    }

    // From now on, also while the error handler runs, a deadline replies by
    // itself (the error handler is then abandoned, see `#bounded()`)
    signal.addEventListener(
      "abort",
      () => {
        const { reason } = signal as { reason: BindenAbortError };
        if (reason.reason === "deadline") {
          this.#deadline(context, exchange).catch((error: unknown) => {
            this.#unexpected(context, error);
          });
        }
      },
      { once: true },
    );
    if (piped !== null) {
      await this.#pipeFailed(context, exchange, piped.error);
    } else if (failure) {
      const { error } = failure;
      await exchange.reply(() => this.#errorHandler(context, exchange, error));
    }
  }

  /**
   * A pipe of the stack has failed (see `IOwnership.fail()`), whose stack has
   * stopped (or had completed): once it has been told (see `kRevoke`), the
   * error handler replies to its error, or the connection is closed once the
   * headers have been sent. A deadline that passes meanwhile replies instead.
   */
  async #pipeFailed(
    context: Context,
    exchange: Exchange,
    error: unknown,
  ): Promise<void> {
    await exchange.delivered;
    const { response } = context;
    if (exchange.signal.aborted) {
      return;
    } else if (response.headersSent) {
      const message =
        "A pipe into the response has failed once its headers were sent. Destroying the socket";
      context.log.error(message, this.#failure(context, error, "send"));
      response[kFramework](() => response.destroy());
      return;
    }
    // The sends of the stack have written nothing
    response[kCancel](error);
    await exchange.reply(() => this.#errorHandler(context, exchange, error));
  }

  /** An unexpected failure (every failure is handled): the connection is closed */
  #unexpected(context: Context, error: unknown): void {
    const message = "The request has failed";
    context.log.error(message, this.#failure(context, error, "send"));
    context.response[kFramework](() => context.response.destroy());
  }

  /**
   * Routes the request through the stack: `404 Not Found` when nothing has
   * handled it, or `405 Method Not Allowed` when only guarded routers have
   * refused its method (or `204` with the allowed methods for `OPTIONS`)
   */
  async #handle(run: IRun, exchange: Exchange): Promise<void> {
    const { pathname } = run.context.url;
    const allow: IAllow = new Set<string>();
    const { request, response } = run.context;

    if (request.method === "OPTIONS" && request.url === "*") {
      // The server as a whole (RFC 9110, section 9.3.7): the stack does not run
      Binden.#unmatched(exchange);
      response.status(204).setHeader("Allow", this.#methods());
      await response.send();
      return;
    } else if (await this.#walk(this, run, exchange, pathname, [], allow)) {
      return;
    }

    // Nothing has handled the request, unless a middleware has started (or ended)
    // the response without setting `done`: it is left to finish
    if (response.started) {
      return;
    }
    Binden.#unmatched(exchange);
    if (allow.size) {
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

    // Split once for every layer of the stack
    const parts = split(path);
    for (const layer of layersOf(stack)) {
      const level = this.#match(layer, path, parts);
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
          if (!context.response.started) {
            // The route of the access log: the template of the layer that
            // runs a middleware, until the reply has started (`*` for a
            // `use()` without a path at the root)
            const route = exchange.mount_template + level.route;
            exchange.route = route === "" ? "*" : route;
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
  #match(layer: ILayer, path: string, parts: readonly string[]): ILevel | null {
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
      const params = matchRoute(layer.pattern, parts, this.#routing);
      return params === null
        ? null
        : { ...none, params, route: layer.pattern.source };
    }
    const { pattern } = layer;
    const match = matchPrefix(pattern, parts, this.#routing);
    return match === null
      ? null
      : { ...match, template: pattern.source, route: "" };
  }

  /**
   * The methods of the routers of the application, in any stack (`HEAD` with
   * `GET` and `auto_head`), and `OPTIONS`: the `Allow` of `OPTIONS *`
   */
  #methods(): string {
    const methods = new Set<string>();
    const seen = new Set<object>();
    const collect = (stack: object): void => {
      seen.add(stack);
      for (const { items } of layersOf(stack)) {
        for (const item of items) {
          if (item instanceof Router) {
            for (const method of item.methods) {
              methods.add(method);
            }
          } else if (item instanceof Stack && !seen.has(item)) {
            collect(item);
          }
        }
      }
    };
    collect(this);
    if (methods.has("GET") && this.#auto_head) {
      methods.add("HEAD");
    }
    methods.add("OPTIONS");
    return [...methods].join(", ");
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
   * after the deadline, see `#deadline()`; a client that has gone away (or a
   * shutdown) gets nothing
   */
  async #aborted(context: Context, exchange: Exchange): Promise<void> {
    const { reason } = exchange.signal as { reason: BindenAbortError };
    if (reason.reason === "deadline") {
      await this.#deadline(context, exchange);
      return;
    }
    const { response } = context;
    if (!response.writableFinished) {
      const message = "The request has been aborted. Destroying the socket";
      context.log.debug(message, { reason: reason.reason });
      response[kFramework](() => response.destroy());
    }
  }

  /**
   * The deadline has passed: the work of the middlewares may no longer
   * mutate the response, and a send whose headers are not committed is
   * cancelled (its file or stream released). A response that has not started
   * then gets a `503` error through the error handler; one that has not
   * finished is cut by closing the connection, unless it has ended while it
   * waits for the response before it on its connection (pipelined): its
   * reply is complete, and is sent once that one has been (destroying it
   * would cut that response too, on some versions of Node.js).
   */
  async #deadline(context: Context, exchange: Exchange): Promise<void> {
    const { response } = context;
    // Sealed already (see `Exchange.abort()`): only this reply is allowed
    exchange.seal();
    response[kCancel](exchange.signal.reason);
    // The abandoned works see their response closed first (see `kRevoke`)
    await exchange.delivered;
    if (!response.started) {
      const error = new BindenError(503, { code: "deadline" });
      await exchange.reply(async () => {
        Binden.#closeUnread(context);
        await this.#errorHandler(context, exchange, error);
      });
    } else if (!response.writableFinished) {
      if (response.writableEnded && response.socket === null) {
        // Waits for the response before it (see above)
        const message =
          "The deadline has passed once the response was complete. It is sent after the responses before it";
        context.log.debug(message);
        return;
      }
      const message = "The deadline has passed. Destroying the socket";
      context.log.debug(message);
      response[kFramework](() => response.destroy());
    }
  }

  /**
   * A reply of the framework to a request whose body has not been read in
   * full (e.g. abandoned at its deadline) closes the connection: the rest of
   * the body would be read as the next request of the connection
   */
  static #closeUnread({ request, response }: Context): void {
    if (!request.complete) {
      response.setHeader("Connection", "close");
    }
  }

  /** The access log names the replies of the framework (e.g. `404`) `<unmatched>` */
  static #unmatched(exchange: Exchange): void {
    exchange.route = UNMATCHED;
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
    // The outcome of the stack is decided (see `IWorks`)
    const works = this.#works.get(exchange) as IWorks;
    works.handled = true;
    if (this.#error_handler) {
      const message = "Passing error to the provided `error_handler`";
      context.log.trace(message, this.#failure(context, error, "middleware"));

      // Its run has its own token (see `Exchange.reply()`): a pipe of it that
      // fails (see `IOwnership.fail()`) fails it
      const token = owners.getStore() as object;
      const { promise: piped, resolve } = Promise.withResolvers<{
        error: unknown;
      }>();
      let running = true;
      const pipe: { failure: { error: unknown } | null } = { failure: null };
      works.handlers.add(token);
      works.failures.set(token, (failure) => {
        if (running) {
          exchange.seal({ owner: token, error: failure });
          pipe.failure = { error: failure };
          resolve(pipe.failure);
        } else {
          // Settled: only its own work is abandoned
          exchange.revoke({ owner: token, error: failure });
          const late = "A pipe of the provided `error_handler` has failed late";
          context.log.debug(late, this.#failure(context, failure, "send"));
        }
      });
      const outcome = await this.#bounded(
        this.#error_handler,
        context,
        exchange,
        error,
        piped,
      );
      running = false;

      const { response } = context;
      if (outcome === SUPERSEDED) {
        // The reply of the deadline has started: what this handler does from
        // now on (its reply, failure or time out) changes nothing
        const abandoned =
          "The provided `error_handler` has been abandoned at the deadline";
        context.log.debug(
          abandoned,
          this.#failure(context, error, "error_handler"),
        );
        return;
      } else if (outcome !== null) {
        // The handler has failed, or has not settled in time: it may no
        // longer mutate the response, and the request gets an opaque error
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
        // It sees its response closed first (see `kRevoke`)
        await exchange.delivered;
        if (outcome === pipe.failure && !response.headersSent) {
          // Its pipe has failed before the headers: its sends have written
          // nothing
          response[kCancel](pipe.failure.error);
        }
        if (response.writableEnded) {
          // Its reply is complete: what is left of it (e.g. under
          // backpressure) is still sent
          return;
        } else if (response.started) {
          response[kFramework](() => response.destroy());
        } else {
          await exchange.reply(async () => {
            Binden.#closeUnread(context);
            await this.#opaque(context);
          });
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
   * once it has settled, `EXPIRED` once the time has passed, `SUPERSEDED` once
   * a deadline has passed while it ran (unless it replies to the deadline
   * itself), and its error once it has failed. The result of a handler that
   * has expired or been superseded is ignored, and a later failure logged.
   */
  async #bounded(
    handler: (context: Context, error: unknown) => Promise<void> | void,
    context: Context,
    exchange: Exchange,
    error: unknown,
    piped: Promise<{ error: unknown }>,
  ): Promise<typeof EXPIRED | typeof SUPERSEDED | { error: unknown } | null> {
    // Once the handler is abandoned (or has failed by its pipe), a failure of
    // its own (then or later) is only logged
    const state: { abandoned: boolean; failure: { error: unknown } | null } = {
      abandoned: false,
      failure: null,
    };
    const late = (failure: unknown): void => {
      const message = "The provided `error_handler` has failed late";
      context.log.debug(
        message,
        this.#failure(context, failure, "error_handler"),
      );
    };
    const settled = (async (): Promise<void> => {
      await handler(context, error);
    })().then(
      () => null,
      (failure: unknown) => {
        state.failure = { error: failure };
        if (state.abandoned) {
          late(failure);
        }
        return state.failure;
      },
    );
    const { promise: timeout, resolve } =
      Promise.withResolvers<typeof EXPIRED>();
    const timer = setTimeout(resolve, this.#error_handler_timeout, EXPIRED);
    timer.unref();
    const outcomes: Promise<
      typeof EXPIRED | typeof SUPERSEDED | { error: unknown } | null
    >[] = [settled, timeout, piped];
    const { signal } = exchange;
    const superseded = (): boolean =>
      signal.aborted &&
      (signal.reason as BindenAbortError).reason === "deadline";
    const { aborted } = signal;
    if (!aborted) {
      // A deadline that passes while it runs takes the reply over (but for the
      // reply of the deadline itself, which runs once the signal is aborted)
      outcomes.push(
        exchange.aborted.then(
          async (): Promise<typeof EXPIRED | typeof SUPERSEDED> => {
            if (superseded()) {
              return SUPERSEDED;
            }
            // Not by another reason: e.g. a client that goes away leaves it
            // to complete, or to expire
            return timeout;
          },
        ),
      );
    }
    let outcome = await Promise.race(outcomes);
    clearTimeout(timer);
    // Whatever has won (e.g. its rejection from a listener of the abort): a
    // deadline that has passed while it ran has taken the reply over
    if (!aborted && superseded()) {
      outcome = SUPERSEDED;
    }
    state.abandoned = outcome !== null && outcome !== state.failure;
    if (state.abandoned && state.failure !== null) {
      // It had failed already (e.g. as the deadline passed)
      late(state.failure.error);
    }
    return outcome;
  }

  /**
   * An empty `500 Internal Server Error`, without the headers of the body that
   * a failed handler may have set
   */
  async #opaque(context: Context): Promise<void> {
    const { response } = context;
    // Once (`#representation` may list `Content-Type` as well)
    for (const name of Binden.#representation) {
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
    // With the reason phrase of its status (see `#defaultErrorHandler()`)
    context.response.statusMessage = "";
    context.response.status(status);
    try {
      await context.response.send();
    } catch (error: unknown) {
      const message = "The error reply has not been sent";
      context.log.debug(message, this.#failure(context, error, "send"));
      Binden.#unsent(context);
    }
  }

  /**
   * A reply of the framework has failed without ending the response (e.g.
   * its `end()` has thrown once its head was committed): the connection is
   * closed, rather than left open without a reply
   */
  static #unsent({ response }: Context): void {
    if (!response.writableEnded) {
      response[kFramework](() => response.destroy());
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

    // The framing and representation of the body that is not sent. Only
    // when set: Node.js remembers the removal of a header that is not, and
    // once `Transfer-Encoding` and `Content-Length` (e.g. by a compression)
    // have both been removed, it closes the connection to end the body.
    for (const name of Binden.#representation) {
      if (response.hasHeader(name)) {
        response.removeHeader(name);
      }
    }
    // With the reason phrase of its status, not one set for the reply that it
    // replaces (which may even be one that Node.js refuses)
    response.statusMessage = "";
    response.status(status);
    if (error instanceof BindenError) {
      response.set(error.headers);
    }
    // E.g. a middleware that has read a part of the body, then failed: Node.js
    // does not read the rest of it, which would stall the connection
    Binden.#closeUnread(context);

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
      // Never the type of the body that it replaces (e.g. `text/html`)
      return response
        .setHeader("Content-Type", `${ct_text}; charset=utf-8`)
        .send(message);
    };

    try {
      await reply();
    } catch (failure: unknown) {
      // E.g. the client went away
      const message = "The error reply has not been sent";
      context.log.debug(message, this.#failure(context, failure, "send"));
      Binden.#unsent(context);
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
        if (exchange.has_halted) {
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
      exchange.halted.then(() => null),
    ]);
    // Whatever has won (e.g. its result settled from a listener of the
    // abort): once the stack has stopped, its result is ignored
    if (outcome === null || exchange.has_halted) {
      throw ABORTED;
    } else if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.value;
  }

  /**
   * The headers of a body (its framing, representation and validators), which
   * do not apply to an error that replaces it: the list that the libraries
   * share (e.g. for the `406` of `@binden/compression`)
   */
  static readonly #representation = bodyHeaders;

  /**
   * The state of a request, from the `state` option: a factory that fails (or
   * that does not return an object, or returns a promise) fails the request
   */
  #createState(): { state: object; failure: { error: unknown } | null } {
    if (!this.#state) {
      return { state: {}, failure: null };
    }
    try {
      const state: unknown = this.#state();
      if (typeof property(state, "then") === "function") {
        // E.g. of an `async` factory: its rejection is observed
        Promise.resolve(state).catch(() => null);
        throw new TypeError("The state of the request is a promise");
      } else if (typeof state !== "object" || state === null) {
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
   * templates of the matched mounts and of the layer that has started the
   * reply, or `<unmatched>` for a reply of the framework), status
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
    /**
     * Whether Node.js accepts a write of the work that writes (whatever the
     * backpressure): not once the response is ended (also when a compression
     * reports it ended while its compressor writes) or destroyed, nor from the
     * work that no longer owns the response (e.g. after its deadline), whose
     * writes are ignored
     */
    const accepts = (): boolean =>
      !Reflect.get(http.OutgoingMessage.prototype, "writableEnded", response) &&
      !response.destroyed &&
      response[kOperation]() !== null;
    /** Counts the bytes of a chunk that Node.js has accepted */
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
    response.write = (...args: unknown[]): boolean => {
      const accepted = accepts();
      // Counted once it has not thrown (e.g. for a chunk that is not one)
      const result = Reflect.apply(write, response, args) as boolean;
      if (accepted) {
        count(args[0], args[1]);
      }
      return result;
    };
    response.end = (...args: unknown[]): typeof response => {
      const accepted = accepts();
      const result = Reflect.apply(end, response, args) as typeof response;
      if (accepted) {
        count(args[0], args[1]);
      }
      return result;
    };

    response[kListen]("close", () => {
      const duration = performance.now() - start;
      context.log[level]("The request has completed", {
        method: request.method,
        route: exchange.route ?? UNMATCHED,
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
