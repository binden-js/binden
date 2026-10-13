import http, { STATUS_CODES } from "node:http";
import https from "node:https";
import { isDeepStrictEqual } from "node:util";
import type { Logger } from "@binden/logger";
import { Context } from "./context.js";
import { BindenError } from "./error.js";
import defaultLogger from "./logger.js";
import { Middleware, type IMiddleware } from "./middleware.js";
import { BindenRequest } from "./request.js";
import { BindenResponse, ct_text, ct_json } from "./response.js";
import { Router } from "./router.js";

type IUseOptions = IStackItem | RegExp | string | null | undefined;

export type IStackItem = IMiddleware | Router;
export type IStack = [IStackItem[], RegExp | string | null];

export const DefaultErrorCode = 500;

type ILogLevel = "debug" | "error" | "trace" | "warn";

export interface IBindenOptions {
  auto_head?: boolean;
  /** Replaces the default reply to an error, unless it does not reply itself */
  error_handler?: (context: Context, error: unknown) => Promise<void> | void;
  /** The logger of the contexts (the default one is set up by `BINDEN_LOG_LEVEL`) */
  logger?: Logger;
}

export class Binden {
  readonly #stack: IStack[];
  readonly #auto_head: boolean;
  readonly #error_handler:
    ((context: Context, error: unknown) => Promise<void> | void) | null;
  readonly #logger: Logger;

  public constructor({
    error_handler,
    auto_head = true,
    logger = defaultLogger,
  }: IBindenOptions = {}) {
    this.#stack = [];
    this.#error_handler = error_handler ?? null;
    this.#auto_head = auto_head;
    this.#logger = logger;
  }

  public get stack(): IStack[] {
    return this.#stack.map(([r, p]) => [
      [...r],
      p instanceof RegExp ? new RegExp(p, "u") : p,
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
        IncomingMessage: BindenRequest,
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
        IncomingMessage: BindenRequest,
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
        ? new RegExp(_path, "u")
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
        ? new RegExp(_path, "u")
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
    this.#handle(context)
      .catch(async (error: unknown) => this.#errorHandler(context, error))
      .catch((error: unknown) => {
        // The error handler failed (e.g. a custom `error_handler` threw): the
        // response cannot be completed, but the process must not crash
        const extra = { context, error };
        Binden.#log(context, "error", "The error handler failed", extra);
        request.destroy();
      });
  }

  async #handle(context: Context): Promise<void> {
    let next = context;

    for (const [items, path] of this.#stack) {
      const regExp = path instanceof RegExp && path.test(next.url.pathname);
      const str = typeof path === "string" && path === next.url.pathname;

      if (path === null || regExp || str) {
        for (const item of items) {
          if (item instanceof Router) {
            const { guarded, middlewares, methods } = item;
            const { method = "GET" } = next.request;

            if (guarded && methods.size) {
              if (methods.has("GET") && this.#auto_head) {
                methods.add("HEAD");
              }

              if (!methods.has(method)) {
                next.response.set({ Allow: `${[...methods].join(", ")}` });

                throw new BindenError(405);
              }
            }

            const m = method === "HEAD" && this.#auto_head ? "GET" : method;
            const methodMiddlewares = middlewares(m);

            for (const mw of methodMiddlewares) {
              next = await Binden.#runMiddleware(mw, next);

              if (next.done) {
                await Binden.#complete(next);
                return;
              }
            }
          } else {
            next = await Binden.#runMiddleware(item, next);

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
    if (!next.response.started) {
      throw new BindenError(404);
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

  /** Error handler: the provided `error_handler` (awaited), then the default reply if needed */
  async #errorHandler(context: Context, error: unknown): Promise<void> {
    if (this.#error_handler) {
      const base = { context, error };
      const message = "Passing error to the provided `error_handler`";
      Binden.#log(context, "trace", message, base);

      await this.#error_handler(context, error);

      if (context.response.started) {
        return;
      }
      const ignored = "The provided `error_handler` has not replied";
      Binden.#log(context, "debug", ignored, base);
    }
    Binden.#defaultErrorHandler(context, error);
  }

  /** Default reply to an error */
  static #defaultErrorHandler(context: Context, error: unknown): void {
    const { response, request } = context;
    // Only the context and the error, whose serializers keep the input out of the logs
    const base = { context, error };
    const log = (level: ILogLevel, message: string): void => {
      Binden.#log(context, level, message, base);
    };
    if (response.writableEnded) {
      // Sent (or being sent): destroying the socket would cut it
      log("debug", "`.end()` has been called. Leaving the response");
    } else if (response.started) {
      // Part of the body may be sent (or compressed): ending the response would
      // make a truncated body look complete
      log("debug", "The response has been started. Destroying the socket");

      request.destroy();
    } else {
      // The framing and representation of the body that is not sent
      for (const name of Binden.#representation) {
        response.removeHeader(name);
      }

      const errorStatus = Number((error as { status?: unknown }).status);

      const status =
        typeof STATUS_CODES[errorStatus] === "undefined"
          ? DefaultErrorCode
          : errorStatus;

      response.status(status);

      const expose = Boolean((error as { expose?: unknown }).expose);

      if (!expose) {
        log("debug", "Error should not be exposed");
        response.end();
        return;
      }

      const { json } = error as { json?: Record<string, unknown> };

      if (json) {
        try {
          const message = JSON.stringify(json);
          response.setHeader("Content-Type", ct_json).end(message);
        } catch {
          log("warn", "`JSON.stringify` failed");
          response.end();
        }
        return;
      }

      const { message } = error as { message?: unknown };

      if (typeof message !== "string" || !message) {
        log("debug", "`message` is not a valid string");
        response.end();
        return;
      } else if (typeof response.getHeader("Content-Type") === "undefined") {
        response.setHeader("Content-Type", ct_text);
      }

      response.end(message);
    }
  }

  static async #runMiddleware(
    middleware: IMiddleware,
    context: Context,
  ): Promise<Context> {
    const { name } = middleware.constructor;

    if (middleware instanceof Middleware && middleware.disabled) {
      Binden.#log(context, "debug", "Middleware is disabled", { name });
      return context;
    }

    try {
      const next =
        typeof middleware === "function"
          ? await middleware(context)
          : await middleware.run(context);
      return next instanceof Context ? next : context;
    } catch (error: unknown) {
      if (middleware instanceof Middleware && middleware.ignore_errors) {
        const extra = { error, name };
        Binden.#log(context, "debug", "Middleware ignores errors", extra);
        return context;
      }

      throw error;
    }
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

  static #validateItem(item: unknown): item is IStackItem {
    return (
      item instanceof Middleware ||
      item instanceof Router ||
      typeof item === "function"
    );
  }
}

export default Binden;
