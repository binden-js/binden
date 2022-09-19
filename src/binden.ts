import http, { STATUS_CODES } from "node:http";
import https from "node:https";
import { isDeepStrictEqual } from "node:util";
import { Context } from "./context.js";
import { BindenError } from "./error.js";
import { Middleware } from "./middleware.js";
import { BindenRequest } from "./request.js";
import { BindenResponse, ct_text, ct_json } from "./response.js";
import { Router } from "./router.js";

type IUseOptions = IStackItem | RegExp | string | null | undefined;

export type IStackItem = Middleware | Router;
export type IStack = [IStackItem[], RegExp | string | null];

export const DefaultErrorCode = 500;

export interface IBindenOptions {
  auto_head?: boolean;
  error_handler?: (context: Context, error: unknown) => void;
}

export class Binden {
  readonly #stack: IStack[];
  readonly #auto_head: boolean;
  readonly #error_handler: ((context: Context, error: unknown) => void) | null;

  public constructor({ error_handler, auto_head = true }: IBindenOptions = {}) {
    this.#stack = [];
    this.#error_handler = error_handler ?? null;
    this.#auto_head = auto_head;
  }

  public get stack(): IStack[] {
    return this.#stack.map(([r, p]) => [
      [...r],
      p instanceof RegExp ? new RegExp(p, "u") : p,
    ]);
  }

  public createServer(
    options: http.ServerOptions = {}
  ): http.Server<typeof BindenRequest, typeof BindenResponse> {
    return http.createServer(
      {
        ...options,
        IncomingMessage: BindenRequest,
        ServerResponse: BindenResponse,
      },
      (request, response) => {
        this.#requestListener(request, response);
      }
    );
  }

  public createSecureServer(
    options: https.ServerOptions = {}
  ): https.Server<typeof BindenRequest, typeof BindenResponse> {
    return https.createServer(
      {
        ...options,
        IncomingMessage: BindenRequest,
        ServerResponse: BindenResponse,
      },
      (request, response) => {
        this.#requestListener(request, response);
      }
    );
  }

  public use(...items: IStackItem[]): this;
  public use(path: RegExp | string, ...items: IStackItem[]): this;
  public use(_path: IUseOptions, ...items: IStackItem[]): this {
    if (_path instanceof Middleware || _path instanceof Router) {
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
      if (!(item instanceof Middleware || item instanceof Router)) {
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
    if (_path instanceof Middleware || _path instanceof Router) {
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
    response: BindenResponse<BindenRequest>
  ): void {
    const context = new Context({ request, response });
    this.#handle(context).catch((error: unknown) => {
      this.#errorHandler(context, error);
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
                return;
              }
            }
          } else {
            next = await Binden.#runMiddleware(item, next);

            if (next.done) {
              return;
            }
          }
        }
      }
    }

    throw new BindenError(404);
  }

  /** Default error hanlder (uses the provided `error_handler`, if any) */
  #errorHandler(context: Context, error: unknown): void {
    const { response, request, log } = context;
    const base = { context, error };
    if (this.#error_handler) {
      log.trace("Passing error to the provided `error_handler`", base);

      this.#error_handler(context, error);
    } else if (response.writableEnded) {
      log.debug("`.end()` has been called. Destroying the socket", base);

      request.destroy();
    } else if (response.headersSent) {
      log.debug("Headers has been sent. Ending the response", base);

      response.end();
    } else {
      const errorStatus = Number((error as { status?: unknown }).status);

      const status =
        typeof STATUS_CODES[errorStatus] === "undefined"
          ? DefaultErrorCode
          : errorStatus;

      response.status(status);

      const expose = Boolean((error as { expose?: unknown }).expose);

      if (!expose) {
        log.debug("Error should not be exposed", base);
        response.end();
        return;
      }

      const { json } = error as { json?: Record<string, unknown> };

      if (json) {
        try {
          const message = JSON.stringify(json);
          response.setHeader("Content-Type", ct_json).end(message);
        } catch {
          log.warn("`JSON.stringify` failed", { ...base, json });
          response.end();
        }
        return;
      }

      const { message } = error as { message?: unknown };

      if (typeof message !== "string" || !message) {
        log.debug("`message` is not a valid string", { ...base, message });
        response.end();
        return;
      } else if (typeof response.getHeader("Content-Type") === "undefined") {
        response.setHeader("Content-Type", ct_text);
      }

      response.end(message);
    }
  }

  static async #runMiddleware(
    middleware: Middleware,
    context: Context
  ): Promise<Context> {
    const { name } = middleware.constructor;

    if (middleware.disabled) {
      context.log.debug("Middleware is disabled", { name });
      return context;
    }

    try {
      const next = await middleware.run(context);
      return next instanceof Context ? next : context;
    } catch (error: unknown) {
      if (middleware.ignore_errors) {
        context.log.debug("Middleware ignores errors", { error, name });
        return context;
      }

      throw error;
    }
  }
}

export default Binden;
