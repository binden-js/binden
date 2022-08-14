import { METHODS } from "node:http";
import Middleware from "./middleware.js";

export interface IRouterOptions {
  guarded?: boolean;
}

export class Router {
  readonly #middlewares: Map<string, Middleware[]>;
  #guarded: boolean;

  public constructor({ guarded = false }: IRouterOptions = {}) {
    this.#guarded = Boolean(guarded);
    this.#middlewares = new Map<string, Middleware[]>();
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
      if (middlewares.find((m) => !m.disabled)) {
        methods.add(method);
      }
    }

    return methods;
  }

  public get middlewares(): (method: string) => Middleware[] {
    return (method: string): Middleware[] => [
      ...(this.#middlewares.get(method.toUpperCase()) ?? []),
    ];
  }

  public on(method: string, ..._middlewares: Middleware[]): this {
    if (!METHODS.includes(method)) {
      throw new TypeError(`Method ${method} is not supported`);
    }

    for (const middleware of _middlewares) {
      if (!(middleware instanceof Middleware)) {
        throw new TypeError("Middleware is not supported");
      }
    }

    const middlewares = this.#middlewares.get(method);

    if (middlewares) {
      middlewares.push(..._middlewares);
    } else {
      this.#middlewares.set(method, [..._middlewares]);
    }

    return this;
  }

  public off(method: string, ..._middlewares: Middleware[]): Middleware[] {
    if (!METHODS.includes(method)) {
      throw new TypeError(`Method ${method} is not supported`);
    }

    const middlewares = this.#middlewares.get(method) ?? [];
    const removed: Middleware[] = [];

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

  public delete(...middlewares: Middleware[]): this {
    return this.on("DELETE", ...middlewares);
  }

  public get(...middlewares: Middleware[]): this {
    return this.on("GET", ...middlewares);
  }

  public head(...middlewares: Middleware[]): this {
    return this.on("HEAD", ...middlewares);
  }

  public options(...middlewares: Middleware[]): this {
    return this.on("OPTIONS", ...middlewares);
  }

  public patch(...middlewares: Middleware[]): this {
    return this.on("PATCH", ...middlewares);
  }

  public post(...middlewares: Middleware[]): this {
    return this.on("POST", ...middlewares);
  }

  public put(...middlewares: Middleware[]): this {
    return this.on("PUT", ...middlewares);
  }

  public trace(...middlewares: Middleware[]): this {
    return this.on("TRACE", ...middlewares);
  }
}

export default Router;
