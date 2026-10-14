import type { IParams } from "./context.js";
import { Middleware, type IMiddleware } from "./middleware.js";

/** The options of a `Router` */
export interface IRouterOptions {
  /**
   * Whether a request with a method that the router has no middlewares for
   * is refused (`false`): `405 Method Not Allowed` (or, for `OPTIONS`, `204`
   * with the allowed methods) when nothing else handles it
   */
  guarded?: boolean | undefined;
}

/** A method: an HTTP token (RFC 9110, section 9.1) */
const token = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

/** Middlewares by method, for a path of the stack */
export class Router<
  State extends object = Record<string, unknown>,
  Params extends IParams = IParams,
> {
  readonly #middlewares: Map<string, IMiddleware<State, Params>[]>;
  #guarded: boolean;

  /**
   * A router without middlewares: a `guarded` that is not a boolean throws a
   * `TypeError`
   */
  public constructor({ guarded = false }: IRouterOptions = {}) {
    if (typeof guarded !== "boolean") {
      throw new TypeError("`guarded` is not a boolean");
    }
    this.#guarded = guarded;
    this.#middlewares = new Map<string, IMiddleware<State, Params>[]>();
  }

  /**
   * Whether a request of a method without middlewares is refused (see
   * `IRouterOptions`)
   */
  public get guarded(): boolean {
    return this.#guarded;
  }

  /** Sets whether a request of a method without middlewares is refused */
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

  /** The middlewares of a method (in any case) */
  public get middlewares(): (method: string) => IMiddleware<State, Params>[] {
    return (method: string): IMiddleware<State, Params>[] => [
      ...(this.#middlewares.get(method.toUpperCase()) ?? []),
    ];
  }

  /** Adds middlewares for a method (in any case: `get` is `GET`) */
  public on(
    _method: string,
    ..._middlewares: IMiddleware<State, Params>[]
  ): this {
    const method = Router.#method(_method);
    if (!_middlewares.length) {
      return this;
    }

    for (const middleware of _middlewares) {
      if (!(
        middleware instanceof Middleware || typeof middleware === "function"
      )) {
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

  /** Removes middlewares of a method: the removed ones */
  public off(
    _method: string,
    ..._middlewares: IMiddleware<State, Params>[]
  ): IMiddleware<State, Params>[] {
    const method = Router.#method(_method);
    const middlewares = this.#middlewares.get(method) ?? [];
    const removed: IMiddleware<State, Params>[] = [];

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

  /** Adds middlewares for `DELETE` (see `on()`) */
  public delete(...middlewares: IMiddleware<State, Params>[]): this {
    return this.on("DELETE", ...middlewares);
  }

  /**
   * Adds middlewares for `GET` (and `HEAD`, without middlewares of its own, see
   * `auto_head`)
   */
  public get(...middlewares: IMiddleware<State, Params>[]): this {
    return this.on("GET", ...middlewares);
  }

  /** Adds middlewares for `HEAD` (see `on()`) */
  public head(...middlewares: IMiddleware<State, Params>[]): this {
    return this.on("HEAD", ...middlewares);
  }

  /**
   * Adds middlewares for `OPTIONS` (instead of the automatic `204` of a guarded
   * router)
   */
  public options(...middlewares: IMiddleware<State, Params>[]): this {
    return this.on("OPTIONS", ...middlewares);
  }

  /** Adds middlewares for `PATCH` (see `on()`) */
  public patch(...middlewares: IMiddleware<State, Params>[]): this {
    return this.on("PATCH", ...middlewares);
  }

  /** Adds middlewares for `POST` (see `on()`) */
  public post(...middlewares: IMiddleware<State, Params>[]): this {
    return this.on("POST", ...middlewares);
  }

  /** Adds middlewares for `PUT` (see `on()`) */
  public put(...middlewares: IMiddleware<State, Params>[]): this {
    return this.on("PUT", ...middlewares);
  }

  /** Adds middlewares for `TRACE` (see `on()`) */
  public trace(...middlewares: IMiddleware<State, Params>[]): this {
    return this.on("TRACE", ...middlewares);
  }

  /**
   * A method in upper case: a token, but not `CONNECT` (Node.js emits its
   * requests as `connect` events of the server, which never reach the
   * middlewares)
   */
  static #method(method: unknown): string {
    if (typeof method !== "string" || !token.test(method)) {
      throw new TypeError(`Method ${String(method)} is not a valid token`);
    }
    const upper = method.toUpperCase();
    if (upper === "CONNECT") {
      throw new TypeError("Method CONNECT is not supported");
    }
    return upper;
  }
}
