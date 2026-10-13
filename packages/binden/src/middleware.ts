import type { Context } from "./context.js";

type IMiddlewareReturnType =
  | Context
  | Promise<Context>
  | Promise<void>
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
  | void;

export type IFunctionMiddleware = (context: Context) => IMiddlewareReturnType;

export interface IMiddlewareParams {
  disabled?: boolean;
  ignore_errors?: boolean;
}

export abstract class Middleware {
  public disabled: boolean;
  public ignore_errors: boolean;

  public constructor({
    disabled = false,
    ignore_errors = false,
  }: IMiddlewareParams = {}) {
    this.disabled = disabled;
    this.ignore_errors = ignore_errors;
  }

  public abstract run(context: Context): IMiddlewareReturnType;
}

export type IMiddleware = IFunctionMiddleware | Middleware;
