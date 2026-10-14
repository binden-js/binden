import http from "node:http";
import https from "node:https";
import { isDeepStrictEqual } from "node:util";
import type { ILogger } from "@binden/logger";
import { Context } from "./context.js";
import { BindenError } from "./error.js";
import { BindenAbortError, Exchange } from "./exchange.js";
import defaultLogger from "./logger.js";
import { Middleware, type IMiddleware } from "./middleware.js";
import { property } from "./property.js";
import { BindenRequest, type ITrustProxy } from "./request.js";
import { BindenResponse, ct_json } from "./response.js";
import { Router } from "./router.js";
import { isStatus } from "./status.js";

type IUseOptions = IStackItem | RegExp | string | null | undefined;

export type IStackItem = IMiddleware | Router;
export type IStack = [IStackItem[], RegExp | string | null];

export const DefaultErrorCode = 500;

type ILogLevel = "debug" | "error" | "trace" | "warn";

export interface IBindenOptions {
  auto_head?: boolean;
  /** Replaces the default reply to an error, unless it does not reply itself */
  error_handler?: (context: Context, error: unknown) => Promise<void> | void;
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
  logger?: ILogger;
  /**
   * The proxies whose `Forwarded` elements `request.protocol` trusts: none
   * (`false`, the default), all of them (`true`) or the given number of the
   * nearest ones
   */
  trust_proxy?: ITrustProxy;
}

/** The greatest delay of a Node.js timer */
const MAX_DELAY = 2 ** 31 - 1;

/** Thrown through the stack once the request has been aborted: the stack stops */
const ABORTED = new Error("The request has been aborted");

/** The outcome of an `error_handler` that has not settled in time */
const EXPIRED = Symbol("expired");

export class Binden {
  readonly #stack: IStack[];
  readonly #auto_head: boolean;
  readonly #error_handler:
    ((context: Context, error: unknown) => Promise<void> | void) | null;
  readonly #error_handler_timeout: number;
  readonly #timeout: number;
  readonly #logger: ILogger;
  readonly #Request: typeof BindenRequest;

  public constructor({
    error_handler,
    error_handler_timeout = 5000,
    auto_head = true,
    logger = defaultLogger,
    timeout = 0,
    trust_proxy = false,
  }: IBindenOptions = {}) {
    if (
      typeof trust_proxy === "number" &&
      !(Number.isSafeInteger(trust_proxy) && trust_proxy >= 0)
    ) {
      throw new RangeError("`trust_proxy` is not a non-negative integer");
    }
    Binden.#delay("timeout", timeout, 0);
    Binden.#delay("error_handler_timeout", error_handler_timeout, 1);
    this.#stack = [];
    this.#error_handler = error_handler ?? null;
    this.#error_handler_timeout = error_handler_timeout;
    this.#timeout = timeout;
    this.#auto_head = auto_head;
    this.#logger = logger;
    // The requests of this application trust its proxies
    this.#Request = class extends BindenRequest {
      // eslint-disable-next-line class-methods-use-this -- the option of the app
      protected override get trust_proxy(): ITrustProxy {
        return trust_proxy;
      }
    };
  }

  public get stack(): IStack[] {
    return this.#stack.map(([r, p]) => [
      [...r],
      p instanceof RegExp ? new RegExp(p.source, p.flags) : p,
    ]);
  }

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

  public use(...items: IStackItem[]): this;
  public use(path: RegExp | string, ...items: IStackItem[]): this;
  public use(_path: IUseOptions, ...items: IStackItem[]): this {
    if (Binden.#validateItem(_path)) {
      items.unshift(_path);
    } else if (!items.length) {
      return this;
    }

    const path =
      _path instanceof RegExp
        ? Binden.#pattern(_path)
        : typeof _path === "string" && _path
          ? _path
          : null;

    for (const item of items) {
      if (!Binden.#validateItem(item)) {
        throw new TypeError("Unsupported Middleware/Router");
      }
    }

    if (this.#stack.length) {
      const [arr, previous_path] = this.#stack[this.#stack.length - 1];

      if (isDeepStrictEqual(previous_path, path)) {
        arr.push(...items);
        return this;
      }
    }

    this.#stack.push([[...items], path]);
    return this;
  }

  public off(...items: IStackItem[]): IStackItem[];
  public off(path: RegExp | string, ...items: IStackItem[]): IStackItem[];
  public off(_path: IUseOptions, ...items: IStackItem[]): IStackItem[] {
    if (Binden.#validateItem(_path)) {
      items.unshift(_path);
    } else if (!items.length || !this.#stack.length) {
      return [];
    }

    const path =
      _path instanceof RegExp
        ? Binden.#pattern(_path)
        : typeof _path === "string" && _path
          ? _path
          : null;

    const removed: IStackItem[] = [];

    for (const item of items) {
      const { length } = this.#stack;

      for (let i = length - 1; i >= 0; i -= 1) {
        const [arr, p] = this.#stack[i];

        if (isDeepStrictEqual(p, path)) {
          const index = arr.lastIndexOf(item);

          if (index !== -1) {
            const found = arr.splice(index, 1);
            removed.push(...found);

            if (!arr.length) {
              if (i > 0 && i < length - 1) {
                const [p_arr, p_path] = this.#stack[i - 1];
                const [n_arr, n_path] = this.#stack[i + 1];

                if (isDeepStrictEqual(p_path, n_path)) {
                  p_arr.push(...n_arr);
                  this.#stack.splice(i, 2);
                } else {
                  this.#stack.splice(i, 1);
                }
              } else {
                this.#stack.splice(i, 1);
              }
            }

            break;
          }
        }
      }
    }

    return removed;
  }

  #requestListener(
    request: BindenRequest,
    response: BindenResponse<BindenRequest>,
  ): void {
    const context = new Context({ request, response, logger: this.#logger });
    const exchange = Exchange.for(request, response);
    if (this.#timeout > 0) {
      exchange.setTimeout(this.#timeout);
    }
    this.#run(context, exchange).catch((error: unknown) => {
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
  async #run(first: Context, exchange: Exchange): Promise<void> {
    const run = { context: first };
    let failure: { error: unknown } | null = null;
    let stopped = false;
    try {
      await this.#handle(run, exchange);
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

  async #handle(run: { context: Context }, exchange: Exchange): Promise<void> {
    let next = run.context;
    // The methods of the guarded routers that have refused the request
    const allow = new Set<string>();

    for (const [items, path] of this.#stack) {
      const regExp = path instanceof RegExp && path.test(next.url.pathname);
      const str = typeof path === "string" && path === next.url.pathname;

      if (path === null || regExp || str) {
        for (const item of items) {
          if (item instanceof Router) {
            const { guarded, middlewares, methods } = item;
            const { method = "GET" } = next.request;
            // `HEAD` is handled by the `GET` middlewares, unless it has its own
            const head = methods.has("HEAD");

            if (
              guarded &&
              methods.size &&
              methods.has("GET") &&
              this.#auto_head
            ) {
              methods.add("HEAD");
            }

            // A guarded router that does not allow the method: another one may
            // (405 when none does)
            const refused = guarded && methods.size > 0 && !methods.has(method);
            if (refused) {
              for (const allowed of methods) {
                allow.add(allowed);
              }
            }

            const m =
              method === "HEAD" && this.#auto_head && !head ? "GET" : method;
            const methodMiddlewares = refused ? [] : middlewares(m);

            for (const mw of methodMiddlewares) {
              next = await Binden.#runMiddleware(mw, next, exchange);
              run.context = next;

              if (next.done) {
                await Binden.#complete(next);
                return;
              }
            }
          } else {
            next = await Binden.#runMiddleware(item, next, exchange);
            run.context = next;

            if (next.done) {
              await Binden.#complete(next);
              return;
            }
          }
        }
      }
    }

    // Nothing has handled the request, unless a middleware has started (or ended)
    // the response without setting `done`: it is left to finish
    if (next.response.started) {
      return;
    } else if (allow.size) {
      next.response.set({ Allow: [...allow].join(", ") });
      throw new BindenError(405);
    }
    throw new BindenError(404);
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

  /**
   * A RegExp path with its flags (e.g. `i`), except those that make `test()`
   * stateful (`g` and `y`)
   */
  static #pattern(path: RegExp): RegExp {
    return new RegExp(path.source, path.flags.replaceAll(/[gy]/gu, ""));
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

  static #validateItem(item: unknown): item is IStackItem {
    return (
      item instanceof Middleware ||
      item instanceof Router ||
      typeof item === "function"
    );
  }
}

export default Binden;
