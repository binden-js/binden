import type { Context, IParams } from "./context.js";
import { formatting, objectOf } from "./formatting.js";
import { formatStack } from "./exchange.js";

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

/** The options of a middleware, each read once, with their defaults */
function read({
  disabled = false,
  ignore_errors = false,
}: IMiddlewareParams): IMiddlewareParams {
  return { disabled, ignore_errors };
}

/** A middleware as a class: its `run()` handles the context */
export abstract class Middleware<
  State extends object = Record<string, unknown>,
  Params extends IParams = IParams,
> {
  /** Whether the middleware is skipped */
  public disabled: boolean;
  /** Whether the errors of the middleware are ignored (the stack goes on) */
  public ignore_errors: boolean;

  /**
   * A middleware with its options: an option that is not a boolean throws a
   * `TypeError`, and so do options that are not an object. What reading them
   * throws (e.g. a revoked proxy) is formatted (see `formatting()`).
   */
  public constructor(options?: IMiddlewareParams) {
    // Each option is read once (e.g. by a getter)
    const checked = formatting(() =>
      read(objectOf(options, "options", true) as IMiddlewareParams),
    );
    if (typeof checked.disabled !== "boolean") {
      throw formatStack(new TypeError("`disabled` is not a boolean"));
    } else if (typeof checked.ignore_errors !== "boolean") {
      throw formatStack(new TypeError("`ignore_errors` is not a boolean"));
    }
    this.disabled = checked.disabled;
    this.ignore_errors = checked.ignore_errors;
  }

  /**
   * Handles the context: it may reply (and set `done`), or return (or resolve
   * to) the context of the next middlewares
   */
  public abstract run(
    context: Context<State, Params>,
  ): IMiddlewareReturnType<State, Params>;
}

/** A middleware: a function, or an instance of a `Middleware` class */
export type IMiddleware<
  State extends object = Record<string, unknown>,
  Params extends IParams = IParams,
> = IFunctionMiddleware<State, Params> | Middleware<State, Params>;
