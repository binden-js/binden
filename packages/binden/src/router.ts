import { METHODS } from "node:http";
import { Middleware, IMiddleware } from "./middleware.js";

export interface IRouterOptions {
  guarded?: boolean;
}

export class Router {
  readonly #middlewares: Map<string, IMiddleware[]>;
  #guarded: boolean;

  public constructor({ guarded = false }: IRouterOptions = {}) {
    this.#guarded = Boolean(guarded);
    this.#middlewares = new Map<string, IMiddleware[]>();
  }

  public get guarded(): boolean {
    return this.#guarded;
  }

  public set guarded(guarded: unknown) {
    this.#guarded = Boolean(guarded);
  }

  /** Get all supported methods by the router */
  public get methods(): Set<string> {
    const methods = new Set<string>();

    for (const [method, middlewares] of this.#middlewares) {
      if (middlewares.find((m) => typeof m === "function" || !m.disabled)) {
        methods.add(method);
      }
    }

    return methods;
  }

  public get middlewares(): (method: string) => IMiddleware[] {
    return (method: string): IMiddleware[] => [
      ...(this.#middlewares.get(method.toUpperCase()) ?? []),
    ];
  }

  public on(method: string, ..._middlewares: IMiddleware[]): this {
    if (!METHODS.includes(method)) {
      throw new TypeError(`Method ${method} is not supported`);
    } else if (!_middlewares.length) {
      return this;
    }

    for (const middleware of _middlewares) {
      if (
        !(middleware instanceof Middleware || typeof middleware === "function")
      ) {
        throw new TypeError("Middleware is not supported");
      }
    }

    const middlewares = this.#middlewares.get(method);

    if (middlewares) {
      middlewares.push(..._middlewares);
    } else {
      this.#middlewares.set(method.toUpperCase(), [..._middlewares]);
    }

    return this;
  }

  public off(method: string, ..._middlewares: IMiddleware[]): IMiddleware[] {
    if (!METHODS.includes(method)) {
      throw new TypeError(`Method ${method} is not supported`);
    }

    const middlewares = this.#middlewares.get(method) ?? [];
    const removed: IMiddleware[] = [];

    if (!middlewares.length) {
      return removed;
    }

    for (const middleware of _middlewares) {
      const index = middlewares.lastIndexOf(middleware);

      if (index !== -1) {
        removed.push(...middlewares.splice(index, 1));

        if (!middlewares.length) {
          this.#middlewares.delete(method);
          return removed;
        }
      }
    }

    return removed;
  }

  public delete(...middlewares: IMiddleware[]): this {
    return this.on("DELETE", ...middlewares);
  }

  public get(...middlewares: IMiddleware[]): this {
    return this.on("GET", ...middlewares);
  }

  public head(...middlewares: IMiddleware[]): this {
    return this.on("HEAD", ...middlewares);
  }

  public options(...middlewares: IMiddleware[]): this {
    return this.on("OPTIONS", ...middlewares);
  }

  public patch(...middlewares: IMiddleware[]): this {
    return this.on("PATCH", ...middlewares);
  }

  public post(...middlewares: IMiddleware[]): this {
    return this.on("POST", ...middlewares);
  }

  public put(...middlewares: IMiddleware[]): this {
    return this.on("PUT", ...middlewares);
  }

  public trace(...middlewares: IMiddleware[]): this {
    return this.on("TRACE", ...middlewares);
  }
}
