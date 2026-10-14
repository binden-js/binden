import type { Context, IParams } from "./context.js";

/** What a middleware returns: nothing, or the context of the next middlewares */
type IMiddlewareReturnType<
  State extends object = Record<string, unknown>,
  Params extends IParams = IParams,
> =
  | Context<State, Params>
  | Promise<Context<State, Params>>
  | Promise<void>
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
  | void;

/** A middleware as a function of the context */
export type IFunctionMiddleware<
  State extends object = Record<string, unknown>,
  Params extends IParams = IParams,
> = (context: Context<State, Params>) => IMiddlewareReturnType<State, Params>;

/** The options of a `Middleware` */
export interface IMiddlewareParams {
  /** Whether the middleware is skipped (`false`) */
  disabled?: boolean | undefined;
  /** Whether the errors of the middleware are ignored (`false`) */
  ignore_errors?: boolean | undefined;
}

/** A middleware as a class: its `run()` handles the context */
export abstract class Middleware<
  State extends object = Record<string, unknown>,
  Params extends IParams = IParams,
> {
  public disabled: boolean;
  public ignore_errors: boolean;

  public constructor({
    disabled = false,
    ignore_errors = false,
  }: IMiddlewareParams = {}) {
    if (typeof disabled !== "boolean") {
      throw new TypeError("`disabled` is not a boolean");
    } else if (typeof ignore_errors !== "boolean") {
      throw new TypeError("`ignore_errors` is not a boolean");
    }
    this.disabled = disabled;
    this.ignore_errors = ignore_errors;
  }

  public abstract run(
    context: Context<State, Params>,
  ): IMiddlewareReturnType<State, Params>;
}

/** A middleware: a function, or an instance of a `Middleware` class */
export type IMiddleware<
  State extends object = Record<string, unknown>,
  Params extends IParams = IParams,
> = IFunctionMiddleware<State, Params> | Middleware<State, Params>;
