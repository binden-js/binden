import http, { STATUS_CODES } from "http";
import https from "https";
import { isDeepStrictEqual } from "util";
import Context, { IKauaiResponse } from "./context.js";
import KauaiError from "./error.js";
import Middleware from "./middleware.js";
import KauaiRequest from "./request.js";
import KauaiResponse, { ct_text, ct_json } from "./response.js";
import Router from "./router.js";

type KauaiRequestListener = (
  request: KauaiRequest,
  response: IKauaiResponse
) => void;

interface IKauaiServerOptions extends http.ServerOptions {
  IncomingMessage: typeof KauaiRequest;
  ServerResponse: typeof KauaiResponse;
}

interface IKauaiSecureServerOptions extends https.ServerOptions {
  IncomingMessage: typeof KauaiRequest;
  ServerResponse: typeof KauaiResponse;
}

declare module "http" {
  export function createServer(
    options: IKauaiServerOptions,
    requestListener?: KauaiRequestListener
  ): Server;
}

declare module "https" {
  function createServer(
    options: IKauaiSecureServerOptions,
    requestListener?: KauaiRequestListener
  ): Server;
}

export type IStackItem = Middleware | Router;
export type IStack = [IStackItem[], string | RegExp | null];

export const DefaultErrorCode = 500;

export interface IKauaiOptions {
  auto_head?: boolean;
  error_handler?: (context: Context, error: unknown) => void;
}

export class Kauai {
  readonly #stack: IStack[];
  readonly #auto_head: boolean;
  readonly #error_handler?: (context: Context, error: unknown) => void;

  public constructor({ error_handler, auto_head = true }: IKauaiOptions = {}) {
    this.#stack = [];
    this.#error_handler = error_handler;
    this.#auto_head = auto_head ? true : false;
  }

  public get stack(): IStack[] {
    return this.#stack.map(([r, p]) => [
      [...r],
      p instanceof RegExp ? new RegExp(p) : p,
    ]);
  }

  public createServer(options: http.ServerOptions = {}): http.Server {
    return http.createServer(
      {
        ...options,
        IncomingMessage: KauaiRequest,
        ServerResponse: KauaiResponse,
      },
      (request: KauaiRequest, response: IKauaiResponse) =>
        this.requestListener(request, response)
    );
  }

  public createSecureServer(options: https.ServerOptions = {}): https.Server {
    return https.createServer(
      {
        ...options,
        IncomingMessage: KauaiRequest,
        ServerResponse: KauaiResponse,
      },
      (request, response) => this.requestListener(request, response)
    );
  }

  public use(...items: IStackItem[]): this;
  public use(path: string | RegExp, ...items: IStackItem[]): this;
  public use(
    _path: null | undefined | string | RegExp | IStackItem,
    ...items: IStackItem[]
  ): this {
    if (_path instanceof Middleware || _path instanceof Router) {
      items.unshift(_path);
    } else if (!items.length) {
      return this;
    }

    const path =
      _path instanceof RegExp
        ? new RegExp(_path)
        : _path && typeof _path === "string"
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
  public off(path: string | RegExp, ...items: IStackItem[]): IStackItem[];
  public off(
    _path: null | undefined | string | RegExp | IStackItem,
    ...items: IStackItem[]
  ): IStackItem[] {
    if (_path instanceof Middleware || _path instanceof Router) {
      items.unshift(_path);
    } else if (!items.length || !this.#stack.length) {
      return [];
    }

    const path =
      _path instanceof RegExp
        ? new RegExp(_path)
        : _path && typeof _path === "string"
        ? _path
        : null;

    const removed: IStackItem[] = [];

    for (const item of items) {
      const { length } = this.#stack;

      for (let i = length - 1; i >= 0; i--) {
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

  public requestListener(
    request: KauaiRequest,
    response: IKauaiResponse
  ): void {
    const context = new Context({ request, response });
    this.#handle(context).catch((error: unknown) => {
      this.#errorHandler(context, error);
    });
  }

  async #handle(context: Context): Promise<void> {
    for (const [items, path] of this.#stack) {
      const regExp = path instanceof RegExp && path.test(context.url.pathname);
      const str = typeof path === "string" && path === context.url.pathname;

      if (path === null || regExp || str) {
        for (const item of items) {
          if (item instanceof Router) {
            const { guarded, middlewares, methods } = item;
            const { method = "GET" } = context.request;

            if (guarded && methods.size) {
              if (methods.has("GET") && this.#auto_head) {
                methods.add("HEAD");
              }

              if (!methods.has(method)) {
                context.response.set({ Allow: `${[...methods].join(", ")}` });

                throw new KauaiError(405);
              }
            }

            const m = method === "HEAD" && this.#auto_head ? "GET" : method;
            const methodMiddlewares = middlewares(m);

            for (const mw of methodMiddlewares) {
              context = await Kauai.#runMiddleware(mw, context);

              if (context.done) {
                return;
              }
            }
          } else {
            context = await Kauai.#runMiddleware(item, context);

            if (context.done) {
              return;
            }
          }
        }
      }
    }

    throw new KauaiError(404);
  }

  /** Default error hanlder (uses the provided `error_handler`, if any) */
  #errorHandler(context: Context, error: unknown): void {
    const { response, request, log } = context;
    const base = { error, response, request };
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
      const errorStatus = Number((error as { status?: unknown })?.status);

      const status = STATUS_CODES[errorStatus] ? errorStatus : DefaultErrorCode;

      response.status(status);

      if (!(error as { expose?: unknown })?.expose) {
        log.debug("Error should not be exposed", base);
        response.end();
        return;
      }

      const json = (error as { json?: Record<string, unknown> })?.json;

      if (json) {
        try {
          const message = JSON.stringify(json);
          response.setHeader("Content-Type", ct_json).end(message);
        } catch (err: unknown) {
          log.warn("KauaiError: `JSON.stringify` failed", { json, error: err });
          response.end();
        }
        return;
      }

      const message = (error as { message?: unknown })?.message;

      if (!message || typeof message !== "string") {
        log.debug("`message` is not a string", { ...base, message });
        response.end();
        return;
      } else if (!response.getHeader("Content-Type")) {
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

export default Kauai;
