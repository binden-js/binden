import http from "node:http";
import https from "node:https";
import type { ILogger } from "@binden/logger";
import { Context } from "./context.js";
import { BindenError } from "./error.js";
import { BindenAbortError, Exchange } from "./exchange.js";
import defaultLogger from "./logger.js";
import { Middleware, type IMiddleware } from "./middleware.js";
import { property } from "./property.js";
import { BindenRequest, type ITrustProxy } from "./request.js";
import { BindenResponse, ct_json } from "./response.js";
import { matchPrefix, matchRoute, type IRoutingOptions } from "./route.js";
import { Router } from "./router.js";
import { type ILayer, layersOf, markRoot, Stack } from "./stack.js";
import { isStatus } from "./status.js";

export const DefaultErrorCode = 500;

type ILogLevel = "debug" | "error" | "trace" | "warn";

/** Replaces the default reply to an error (see `IBindenOptions.error_handler`) */
export type IErrorHandler<State extends object = Record<string, unknown>> = (
  context: Context<State>,
  error: unknown,
) => Promise<void> | void;

/** The options of `Binden`, but its `state` */
export interface IBindenBaseOptions<
  State extends object = Record<string, unknown>,
> {
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
  /** The matching of the patterns of `route()` and `mount()` */
  routing?: IRoutingOptions | undefined;
  /**
   * The proxies whose `Forwarded` elements `request.protocol` trusts: none
   * (`false`, the default), all of them (`true`) or the given number of the
   * nearest ones
   */
  trust_proxy?: ITrustProxy | undefined;
}

/**
 * The options of `Binden`: `state` creates the state of every request (an
 * empty object by default), and is required when the state has required fields
 */
export type IBindenOptions<State extends object = Record<string, unknown>> =
  IBindenBaseOptions<State> &
    (Record<never, never> extends State
      ? { state?: (() => State) | undefined }
      : { state: () => State });

/** The greatest delay of a Node.js timer */
const MAX_DELAY = 2 ** 31 - 1;

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
  readonly #routing: Required<IRoutingOptions>;
  readonly #state: (() => object) | null;
  readonly #Request: typeof BindenRequest;

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
      logger = defaultLogger,
      routing = {},
      state,
      timeout = 0,
      trust_proxy = false,
    } = options;
    if (
      typeof trust_proxy === "number" &&
      !(Number.isSafeInteger(trust_proxy) && trust_proxy >= 0)
    ) {
      throw new RangeError("`trust_proxy` is not a non-negative integer");
    }
    Binden.#delay("timeout", timeout, 0);
    Binden.#delay("error_handler_timeout", error_handler_timeout, 1);
    Binden.#boolean("auto_head", auto_head);
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
    Binden.#boolean("routing.case_sensitive", case_sensitive);
    Binden.#boolean("routing.strict", strict);
    markRoot(this);
    this.#error_handler =
      (error_handler as unknown as IErrorHandler | undefined) ?? null;
    this.#error_handler_timeout = error_handler_timeout;
    this.#timeout = timeout;
    this.#auto_head = auto_head;
    this.#logger = logger;
    this.#routing = { case_sensitive, strict };
    this.#state = state ?? null;
    // The requests of this application trust its proxies
    this.#Request = class extends BindenRequest {
      // eslint-disable-next-line class-methods-use-this -- the option of the app
      protected override get trust_proxy(): ITrustProxy {
        return trust_proxy;
      }
    };
  }

  /** Creates an HTTP server that handles its requests with the application */
  public createServer(
    options: Omit<
      http.ServerOptions,
      "IncomingMessage" | "ServerResponse"
    > = {},
  ): http.Server<typeof BindenRequest, typeof BindenResponse> {
    return http.createServer(
      {
        ...options,
        IncomingMessage: this.#Request,
        ServerResponse: BindenResponse,
      },
      (request, response) => {
        this.#requestListener(request, response);
      },
    );
  }

  /** Creates an HTTPS server that handles its requests with the application */
  public createSecureServer(
    options: Omit<
      https.ServerOptions,
      "IncomingMessage" | "ServerResponse"
    > = {},
  ): https.Server<typeof BindenRequest, typeof BindenResponse> {
    return https.createServer(
      {
        ...options,
        IncomingMessage: this.#Request,
        ServerResponse: BindenResponse,
      },
      (request, response) => {
        this.#requestListener(request, response);
      },
    );
  }

  #requestListener(
    request: BindenRequest,
    response: BindenResponse<BindenRequest>,
  ): void {
    const { state, failure } = this.#createState();
    const exchange = Exchange.for(request, response, { state });
    const context = new Context({ request, response, logger: this.#logger });
    if (this.#timeout > 0) {
      exchange.setTimeout(this.#timeout);
    }
    this.#run(context, exchange, failure).catch((error: unknown) => {
      // Unexpected (every failure is handled): the process must not crash
      Binden.#log(context, "error", "The request has failed", { error });
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
            Binden.#log(context, "debug", message, {});
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
      response.setHeader("Allow", methods);
      throw new BindenError(405);
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
          context = await Binden.#runMiddleware(middleware, context, exchange);
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
    const none = { params: {}, prefix: "", template: "", rest: path };
    if (layer.kind === "use") {
      const { path: match } = layer;
      return match === null ||
        (match instanceof RegExp ? match.test(path) : match === path)
        ? none
        : null;
    } else if (layer.kind === "route") {
      const params = matchRoute(layer.pattern, path, this.#routing);
      return params === null ? null : { ...none, params };
    }
    const { pattern } = layer;
    const match = matchPrefix(pattern, path, this.#routing);
    return match === null ? null : { ...match, template: pattern.source };
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
      Binden.#log(context, "debug", message, { reason: reason.reason });
      response.destroy();
    }
  }

  /** A middleware has set `done`: a response that nothing has started is sent empty */
  static async #complete(context: Context): Promise<void> {
    if (!context.response.started) {
      const extra = { context };
      Binden.#log(context, "warn", "`done` without a response", extra);
      await context.response.send();
    }
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
      const base = { context, error };
      const message = "Passing error to the provided `error_handler`";
      Binden.#log(context, "trace", message, base);

      const outcome = await this.#bounded(this.#error_handler, context, error);

      const { response } = context;
      if (outcome !== null) {
        // The handler has failed, or has not settled in time: it may no
        // longer reply, and the request gets an opaque error
        exchange.seal();
        const failed =
          outcome === EXPIRED
            ? "The provided `error_handler` has not settled in time"
            : "The provided `error_handler` has failed";
        const extra =
          outcome === EXPIRED ? { context } : { context, error: outcome.error };
        Binden.#log(context, "error", failed, extra);
        if (response.started) {
          response.destroy();
        } else {
          await exchange.reply(async () => Binden.#opaque(context));
        }
        return;
      } else if (response.writableEnded) {
        return;
      } else if (response.started) {
        // A reply that is not ended once the handler has settled (e.g. a
        // `write()` without `end()`) would leave the client waiting
        const unfinished =
          "The provided `error_handler` has not ended its reply";
        Binden.#log(
          context,
          "warn",
          `${unfinished}. Destroying the socket`,
          base,
        );
        response.destroy();
        return;
      }
      const ignored = "The provided `error_handler` has not replied";
      Binden.#log(context, "debug", ignored, base);
    }
    await Binden.#defaultErrorHandler(context, error);
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
          Binden.#log(context, "debug", late, { context, error: failure });
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
  static async #opaque(context: Context): Promise<void> {
    const { response } = context;
    for (const name of [...Binden.#representation, "Content-Type"]) {
      response.removeHeader(name);
    }
    response.status(DefaultErrorCode);
    try {
      await response.send();
    } catch {
      Binden.#log(context, "debug", "The error reply has not been sent", {
        context,
      });
    }
  }

  /**
   * Default reply to an error, which may be any thrown value: its properties
   * are read without trusting them (e.g. `throw null`, or a throwing getter)
   */
  static async #defaultErrorHandler(
    context: Context,
    error: unknown,
  ): Promise<void> {
    const { response, request } = context;
    // Only the context and the error, whose serializers keep the input out of the logs
    const base = { context, error };
    const log = (level: ILogLevel, message: string): void => {
      Binden.#log(context, level, message, base);
    };
    if (response.writableEnded) {
      // Sent (or being sent): destroying the socket would cut it
      log("debug", "`.end()` has been called. Leaving the response");
      return;
    } else if (response.started) {
      // Part of the body may be sent (or compressed): ending the response would
      // make a truncated body look complete
      log("debug", "The response has been started. Destroying the socket");
      request.destroy();
      return;
    }

    // The framing and representation of the body that is not sent
    for (const name of Binden.#representation) {
      response.removeHeader(name);
    }

    const raw = property(error, "status");
    const errorStatus =
      typeof raw === "number" || typeof raw === "string" ? Number(raw) : NaN;
    response.status(isStatus(errorStatus) ? errorStatus : DefaultErrorCode);

    // Sent like any other response: with its cookies, framed by its status
    const reply = (): Promise<void> => {
      const expose = Boolean(property(error, "expose"));
      const json = property(error, "json");
      const message = property(error, "message");
      if (!expose) {
        log("debug", "Error should not be exposed");
        return response.send();
      } else if (typeof json === "object" && json !== null) {
        try {
          const body = JSON.stringify(json);
          return response.setHeader("Content-Type", ct_json).send(body);
        } catch {
          log("warn", "`JSON.stringify` failed");
          return response.send();
        }
      } else if (typeof message !== "string" || !message) {
        log("debug", "`message` is not a valid string");
        return response.send();
      }
      return response.send(message);
    };

    try {
      await reply();
    } catch {
      // E.g. the client went away
      log("debug", "The error reply has not been sent");
    }
  }

  static async #runMiddleware(
    middleware: IMiddleware,
    context: Context,
    exchange: Exchange,
  ): Promise<Context> {
    const { name } = middleware.constructor;

    if (middleware instanceof Middleware && middleware.disabled) {
      Binden.#log(context, "debug", "Middleware is disabled", { name });
      return context;
    }

    try {
      const result =
        typeof middleware === "function"
          ? middleware(context)
          : middleware.run(context);
      const next =
        typeof property(result, "then") === "function"
          ? await Binden.#race(result, context, exchange)
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
        const extra = { error, name };
        Binden.#log(context, "debug", "Middleware ignores errors", extra);
        return context;
      }

      throw error;
    }
  }

  /**
   * The result of a middleware, unless the request is aborted first: its late
   * result is then ignored (and a late failure logged)
   */
  static async #race(
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
          Binden.#log(context, "debug", message, { context, error });
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

  /** Framework logs never break the handling of a request (e.g. a failing serializer) */
  static #log(
    context: Context,
    level: ILogLevel,
    message: string,
    extra: Record<string, unknown>,
  ): void {
    try {
      context.log[level](message, extra);
    } catch {
      // Nothing else to report it to
    }
  }

  /** A delay of a timer: an integer from `min` to the greatest delay of Node.js */
  static #delay(name: string, value: unknown, min: number): void {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new TypeError(`\`${name}\` is not an integer`);
    } else if (value < min || value > MAX_DELAY) {
      throw new RangeError(
        `\`${name}\` is not between ${min} and ${MAX_DELAY}`,
      );
    }
  }

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

  /** A boolean option */
  static #boolean(name: string, value: unknown): void {
    if (typeof value !== "boolean") {
      throw new TypeError(`\`${name}\` is not a boolean`);
    }
  }
}

export default Binden;
